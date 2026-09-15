/**
 * 真实组合覆盖：把一个仅供测试的 cordis.yml 通过真正的 Cordis Loader 启动，挂载本
 * 插件；随后断言的是持久可见的结果——每个启用的服务各挂出一条 bridge 条目且收到确切
 * 配置、停用的服务什么都不挂、被挂载的行只进入 Loader 的内存根树（绝不写进引导用的
 * 文件），以及卸载插件时移除它创建过的每一行（HMR 安全性）。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as McpServers from '../src/index.ts'

const PLUGIN = 'dsh-mcp-servers'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

let root: string | undefined
let home: string | undefined
let context: Context | undefined

// 插件还会读取 <harness home>/mcp.json，所以这里必须把 DSH_HOME 指到一个空目录：
// 否则跑测试的这台机器上真实的用户配置会混进组合结果，断言随环境而变。
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-mcp-servers-home-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, home]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
  root = undefined
  home = undefined
})

/** 当前 Loader store 里存在的条目名（根树加上各子树）。 */
function entryNames(ctx: Context): string[] {
  return [...ctx.loader.entries()].map(entry => entry.options.name)
}

/**
 * 启动一份单行组合，其中 bridge 包解析为一条记录用的替身，这样测试就能观察到插件
 * 挂载了什么，而不必真的拉起一个 MCP 服务。
 * @param composition - 要启动的 cordis.yml 文档。
 * @returns 启动后的上下文，以及替身收到的每一份 bridge 配置。
 */
async function loadComposition(composition: string): Promise<{ ctx: Context; mounted: unknown[] }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-mcp-servers-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, composition)
  const mounted: unknown[] = []
  const bridge = {
    name: 'mcp-client',
    apply: (_ctx: Context, pluginConfig: unknown) => { mounted.push(pluginConfig) },
  }
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    [PLUGIN, McpServers],
    [MCP_CLIENT, bridge],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { ctx: context, mounted }
}

/** 所有用例的起始组合：两个启用的服务，外加一个停用的。 */
const COMPOSITION = [
  `- name: '${PLUGIN}'`,
  '  config:',
  '    mcpServers:',
  '      alpha:',
  '        command: alpha-server',
  '        args:',
  '          - --stdio',
  '        env:',
  '          ALPHA_TOKEN: secret',
  '      beta:',
  '        url: http://127.0.0.1:9/mcp',
  '        headers:',
  '          Authorization: Bearer token',
  '      off:',
  '        command: never-started',
  '        enabled: false',
  '',
].join('\n')

describe('真实 Loader 组合', () => {
  it('每个启用的服务挂出一条 bridge 行，且携带投影后的配置', async () => {
    const { ctx, mounted } = await loadComposition(COMPOSITION)

    expect(entryNames(ctx).filter(name => name === MCP_CLIENT)).toHaveLength(2)
    expect(mounted).toEqual([
      {
        transport: 'stdio',
        serverName: 'alpha',
        command: 'alpha-server',
        args: ['--stdio'],
        env: { ALPHA_TOKEN: 'secret' },
        cwd: '',
        failOnStartupError: false,
      },
      {
        transport: 'streamable-http',
        serverName: 'beta',
        url: 'http://127.0.0.1:9/mcp',
        headers: { Authorization: 'Bearer token' },
        failOnStartupError: false,
      },
    ])
    // 停用的服务保留配置，但不挂载任何东西。
    expect(mounted).not.toContainEqual(expect.objectContaining({ serverName: 'off' }))
    // 组合激活的每一行都有活着的 fiber。
    expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  })

  it('绝不把挂载的行写回引导用的组合文件', async () => {
    const { ctx } = await loadComposition(COMPOSITION)
    const configPath = join(root!, 'cordis.yml')
    const before = await readFile(configPath, 'utf8')

    const registry = [...ctx.loader.entries()].find(entry => entry.options.name === PLUGIN)!
    await registry.fiber!.dispose()

    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  it('插件卸载时移除它创建过的每一行', async () => {
    const { ctx } = await loadComposition(COMPOSITION)
    expect(entryNames(ctx).filter(name => name === MCP_CLIENT)).toHaveLength(2)

    const registry = [...ctx.loader.entries()].find(entry => entry.options.name === PLUGIN)!
    await registry.fiber!.dispose()

    expect(entryNames(ctx)).not.toContain(MCP_CLIENT)
  })

  it('组合里没有声明任何服务时不挂载任何东西', async () => {
    const { ctx, mounted } = await loadComposition(`- name: '${PLUGIN}'\n`)
    expect(mounted).toEqual([])
    expect(entryNames(ctx)).not.toContain(MCP_CLIENT)
  })

  // 行为在 issue #2 修复后改变：坏条目只报告并跳过，不再让整棵插件树加载失败。
  // 更完整的容错用例见 tests/config-resilience.spec.ts。
  it('组合配置里的坏条目被跳过，插件照常激活', async () => {
    const { ctx, mounted } = await loadComposition([
      `- name: '${PLUGIN}'`,
      '  config:',
      '    mcpServers:',
      '      bad name:',
      '        command: x',
      '      good:',
      '        command: good-server',
      '',
    ].join('\n'))

    expect(mounted).toEqual([expect.objectContaining({ serverName: 'good', command: 'good-server' })])
    const plugin = [...ctx.loader.entries()].find(entry => entry.options.name === PLUGIN)
    expect(plugin?.fiber?.state).toBe(2)
  })
})
