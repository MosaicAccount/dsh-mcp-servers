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
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as McpServers from '../src/index.ts'

const PLUGIN = 'dsh-mcp-servers'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/** 收集到的一条日志：Loader 与插件都通过同一个 logger 服务报告。 */
interface CapturedLog {
  type: string
  args: unknown[]
}

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

/** 找到组合里挂载本插件的条目，也就是那条 Loader 条目。 */
function pluginEntry(ctx: Context): Entry {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === PLUGIN)
  if (entry === undefined) throw new Error('the composition did not mount the registry')
  return entry
}

/**
 * 等条件成立。插件的收敛跑在自己的串行队列上，不是 Loader 的 task，所以不能用
 * `loader.await()` 等它。
 * @param condition - 轮询条件。
 */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the registry to converge')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** 匹配指定片段、类型为 error 的日志条数。 */
function errorCount(logs: CapturedLog[], fragment: string): number {
  return logs.filter(message => message.type === 'error'
    && String(message.args[0]).includes(fragment)).length
}

/**
 * 用指定的 `mcp.json` 内容与组合配置启动一次真实 Loader。
 * @param mcpJson - 写进 <harness home>/mcp.json 的内容；undefined 表示不创建该文件。
 * @param configRows - 配置行下面缩进好的 `config:` 行，含末尾换行。
 * @returns 启动后的上下文、bridge 替身收到的每一份配置，以及期间的全部日志。
 */
async function boot(
  mcpJson: string | undefined,
  configRows: string,
): Promise<{ ctx: Context; mounted: unknown[]; logs: CapturedLog[] }> {
  if (mcpJson !== undefined) await writeFile(join(home!, 'mcp.json'), mcpJson)
  const configDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-resilience-cfg-'))
  const configPath = join(configDir, 'cordis.yml')
  await writeFile(configPath, [`- name: '${PLUGIN}'`, configRows].join('\n'))
  const mounted: unknown[] = []
  // bridge 现在是子插件而不是 Loader 行：记录 apply 的那份上下文，用来断言"未改动的
  // 服务没有被重挂"。
  const instances: Array<{ config: { serverName: string }; disposed: boolean }> = []
  const bridge = {
    name: 'mcp-client',
    apply: (bridgeCtx: Context, pluginConfig: unknown) => {
      mounted.push(pluginConfig)
      const instance = { config: pluginConfig as { serverName: string }, disposed: false }
      instances.push(instance)
      bridgeCtx.effect(() => () => { instance.disposed = true })
    },
  }
  context = new Context()
  context.baseUrl = pathToFileURL(configDir).href + '/'
  // 先装日志出口再挂插件，才能连激活期的报告一起看到。
  const logs: CapturedLog[] = []
  context.logger.exporter({
    export: (message) => { logs.push({ type: message.type, args: message.args }) },
    levels: { default: 3 },
  })
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
  return { ctx: context, mounted, instances, logs }
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

  // 枚举外的传输方式若被放行，会一路走到设置命名空间的 schema 才炸，表现为设置页面
  // 静默不可用。这里钉住它在更早的地方就被报告并跳过。
  it('枚举外的传输方式被拦下，不会拖垮同一文件里的好条目', async () => {
    const partial = JSON.stringify({
      mcpServers: {
        good: { command: 'good-server' },
        sse: { transport: 'sse', url: 'http://127.0.0.1:9/mcp' },
      },
    })

    const { ctx, mounted } = await boot(partial, '')

    expect(mounted).toEqual([
      expect.objectContaining({ serverName: 'good', command: 'good-server' }),
    ])
    expect(entryNames(ctx)).toContain(PLUGIN)
    const plugin = [...ctx.loader.entries()].find(entry => entry.options.name === PLUGIN)
    expect(plugin?.fiber?.state).toBe(2)
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

describe('0.2.x volatile 热更新里出现坏条目时', () => {
  it('只报告一次并跳过，未改动的好服务继续运行、插件不重挂', async () => {
    const { ctx, mounted, instances, logs } = await boot(undefined, INLINE_ALPHA)
    const entry = pluginEntry(ctx)
    const alpha = instances[0]!
    expect(alpha.config.serverName).toBe('alpha')
    expect(mounted).toHaveLength(1)

    // 设置页面写入只改 volatile 层：alpha 原样，外带一条 bridge 名称空间非法的条目。
    await entry.update({
      config: {
        mcpServers: {
          alpha: { command: 'alpha-server' },
          'bad name': { command: 'x' },
        },
      },
    }, false, true)

    await until(() => errorCount(logs, 'must match') > 0)

    // 坏条目被报告并跳过：没有多挂任何实例，alpha 还是同一份，插件仍处于 ACTIVE。
    expect(errorCount(logs, 'must match')).toBe(1)
    expect(mounted).toHaveLength(1)
    expect(instances).toHaveLength(1)
    expect(alpha.disposed).toBe(false)
    expect(entry.fiber?.state).toBe(2)

    // 再改一次、这条坏条目仍然在：去重集合不会让它再刷一条。
    await entry.update({
      config: {
        mcpServers: {
          alpha: { command: 'alpha-server' },
          gamma: { command: 'gamma-server' },
          'bad name': { command: 'x' },
        },
      },
    }, false, true)

    await until(() => mounted.length === 2)
    expect(errorCount(logs, 'must match')).toBe(1)
    expect(mounted[1]).toEqual(expect.objectContaining({ serverName: 'gamma' }))
    expect(entry.fiber?.state).toBe(2)
  })
})
