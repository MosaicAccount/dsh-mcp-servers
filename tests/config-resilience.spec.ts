/**
 * 配置容错覆盖（issue #2 的回归测试）。
 *
 * 曾经 `mcp.json` 里一个漏掉的逗号会让 `readConfigFile` 抛错，进而让 `apply()` 拒绝、
 * 整个插件树加载失败、harness 连启动都起不来——用户同时失去了修它的手段，因为设置页面
 * 也打不开。
 *
 * 这里钉住修复后的契约：用户可编辑的配置出问题时只报告、不中断，能挂载的照常挂载。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

let home: string | undefined
let context: Context | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-mcp-resilience-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

/** 当前 Loader store 里存在的条目名。 */
function entryNames(ctx: Context): string[] {
  return [...ctx.loader.entries()].map(entry => entry.options.name)
}

/**
 * 用指定的 `mcp.json` 内容与组合配置启动一次真实 Loader。
 * @param mcpJson - 写进 <harness home>/mcp.json 的内容；undefined 表示不创建该文件。
 * @param configRows - 配置行下面缩进好的 `config:` 行，含末尾换行。
 * @returns 启动后的上下文，以及 bridge 替身收到的每一份配置。
 */
async function boot(
  mcpJson: string | undefined,
  configRows: string,
): Promise<{ ctx: Context; mounted: unknown[] }> {
  if (mcpJson !== undefined) await writeFile(join(home!, 'mcp.json'), mcpJson)
  const configDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-resilience-cfg-'))
  const configPath = join(configDir, 'cordis.yml')
  await writeFile(configPath, [`- name: '${PLUGIN}'`, configRows].join('\n'))
  const mounted: unknown[] = []
  const bridge = {
    name: 'mcp-client',
    apply: (_ctx: Context, pluginConfig: unknown) => { mounted.push(pluginConfig) },
  }
  context = new Context()
  context.baseUrl = pathToFileURL(configDir).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([[PLUGIN, McpServers], [MCP_CLIENT, bridge]])
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

const INLINE_ALPHA = [
  '  config:',
  '    mcpServers:',
  '      alpha:',
  '        command: alpha-server',
  '',
].join('\n')

describe('用户可编辑配置出问题时', () => {
  it('JSON 语法错误不再阻止激活，组合层的服务照常挂载', async () => {
    // 复现 issue #2：`headers` 对象后面漏了一个逗号。
    const broken = [
      '{',
      '  "mcpServers": {',
      '    "showdoc": {',
      '      "url": "https://www.showdoc.com.cn/mcp.php",',
      '      "headers": { "Authorization": "Bearer x" }',
      '      "enabled": true',
      '    }',
      '  }',
      '}',
    ].join('\n')

    const { ctx, mounted } = await boot(broken, INLINE_ALPHA)

    // 关键断言：启动完成了。修复前这里会 reject，harness 根本起不来。
    expect(entryNames(ctx)).toContain(PLUGIN)
    const plugin = [...ctx.loader.entries()].find(entry => entry.options.name === PLUGIN)
    expect(plugin?.fiber?.state).toBe(2)

    // 坏掉的文件层贡献零个服务，但组合层不受影响。
    expect(mounted).toEqual([
      expect.objectContaining({ serverName: 'alpha', command: 'alpha-server' }),
    ])
  })

  it('文件里单条坏条目被跳过，同文件里的好条目照常挂载', async () => {
    const partial = JSON.stringify({
      mcpServers: {
        good: { command: 'good-server' },
        bad: {},
      },
    })

    const { mounted } = await boot(partial, '')

    expect(mounted).toEqual([
      expect.objectContaining({ serverName: 'good', command: 'good-server' }),
    ])
    expect(mounted).not.toContainEqual(expect.objectContaining({ serverName: 'bad' }))
  })

  it('组合配置里单条坏条目被跳过，其余条目照常挂载', async () => {
    const rows = [
      '  config:',
      '    mcpServers:',
      '      alpha:',
      '        command: alpha-server',
      '      broken:',
      '        transport: streamable-http',
      '',
    ].join('\n')

    const { mounted } = await boot(undefined, rows)

    expect(mounted).toEqual([
      expect.objectContaining({ serverName: 'alpha', command: 'alpha-server' }),
    ])
  })

  it('文件结构正确时行为不变：文件层与组合层都生效', async () => {
    const good = JSON.stringify({ mcpServers: { fromFile: { command: 'file-server' } } })

    const { mounted } = await boot(good, INLINE_ALPHA)

    expect(mounted).toEqual([
      expect.objectContaining({ serverName: 'fromFile', command: 'file-server' }),
      expect.objectContaining({ serverName: 'alpha', command: 'alpha-server' }),
    ])
  })
})
