/**
 * 真实组合覆盖：把一个仅供测试的 cordis.yml 通过真正的 Cordis Loader 启动，挂载本
 * 插件；随后断言的是持久可见的结果——每个启用的服务各挂出一条 bridge 条目且收到确切
 * 配置、停用的服务什么都不挂、被挂载的行只进入 Loader 的内存根树（绝不写进引导用的
 * 文件），以及卸载插件时移除它创建过的每一行（HMR 安全性）。
 *
 * 0.2.x 起 `mcpServers` 是 volatile 配置层：这里的核心用例用真实 Loader 的
 * `Entry.update()` 只改这一层，证明热更新不会重挂插件、未改动的服务行保持不动。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as McpServers from '../src/index.ts'
import type { ComposedServers } from '../src/servers.ts'

const PLUGIN = 'dsh-mcp-servers'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/** 收集到的一条日志：Loader 与插件都通过同一个 logger 服务报告。 */
interface CapturedLog {
  type: string
  args: unknown[]
}

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

/** 找到组合里挂载本插件的条目，也就是那条 Loader 条目。 */
function pluginEntry(ctx: Context): Entry {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === PLUGIN)
  if (entry === undefined) throw new Error('the composition did not mount the registry')
  return entry
}

/** 一份运行中的 bridge 子插件实例，由替身的 apply 记录。 */
interface BridgeInstance {
  config: { serverName: string }
  disposed: boolean
}

/** 读取插件发布给设置页面的只读投影。 */
function composedServers(ctx: Context): ComposedServers {
  const config = pluginEntry(ctx).fiber?.config as { composedServers?: { get(): ComposedServers } } | undefined
  const ref = config?.composedServers
  if (ref === undefined) throw new Error('the resolved config carries no composedServers projection')
  return ref.get()
}

/** 当前活着的实例，按服务名索引。 */
function liveInstances(instances: BridgeInstance[]): Map<string, BridgeInstance> {
  return new Map(instances
    .filter(instance => !instance.disposed)
    .map(instance => [instance.config.serverName, instance]))
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

/**
 * 启动一份单行组合，其中 bridge 包解析为一个记录用的替身，这样测试就能观察到插件
 * 创建了哪些 bridge 子插件，而不必真的拉起一个 MCP 服务。
 * @param composition - 要启动的 cordis.yml 文档。
 * @param mountExtra - 在插件行加载之前挂载额外插件的钩子（用于提供替身服务）。
 * @returns 启动后的上下文、替身收到的每一份 bridge 配置、实例记录，以及期间的全部日志。
 */
async function loadComposition(
  composition: string,
  mountExtra?: (ctx: Context) => Promise<void>,
): Promise<{ ctx: Context; mounted: unknown[]; instances: BridgeInstance[]; logs: CapturedLog[] }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-mcp-servers-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, composition)
  const mounted: unknown[] = []
  const instances: BridgeInstance[] = []
  const bridge = {
    name: 'mcp-client',
    apply: (bridgeCtx: Context, pluginConfig: unknown) => {
      mounted.push(pluginConfig)
      const instance: BridgeInstance = { config: pluginConfig as { serverName: string }, disposed: false }
      instances.push(instance)
      bridgeCtx.effect(() => () => { instance.disposed = true })
    },
  }
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  // 先装日志出口再挂插件，才能连激活期的报告一起看到。
  const logs: CapturedLog[] = []
  context.logger.exporter({
    export: (message) => { logs.push({ type: message.type, args: message.args }) },
    levels: { default: 3 },
  })
  await context.plugin(Loader)
  if (mountExtra !== undefined) await mountExtra(context)
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
  return { ctx: context, mounted, instances, logs }
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
  it('每个启用的服务实例化一份 bridge 子插件，且携带投影后的配置', async () => {
    const { ctx, mounted, instances } = await loadComposition(COMPOSITION)

    expect(mounted).toHaveLength(2)
    expect(liveInstances(instances).size).toBe(2)
    // bridge 是子插件而不是 Loader 行：它不出现在 Loader 树里。
    expect(entryNames(ctx)).not.toContain(MCP_CLIENT)
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

  it('绝不把运行期创建的子插件写回引导用的组合文件', async () => {
    const { ctx } = await loadComposition(COMPOSITION)
    const configPath = join(root!, 'cordis.yml')
    const before = await readFile(configPath, 'utf8')

    await pluginEntry(ctx).fiber!.dispose()

    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  it('插件卸载时停掉它创建过的每一份子插件', async () => {
    const { ctx, instances } = await loadComposition(COMPOSITION)
    expect(instances).toHaveLength(2)
    expect(instances.every(instance => !instance.disposed)).toBe(true)

    await pluginEntry(ctx).fiber!.dispose()

    expect(instances.every(instance => instance.disposed)).toBe(true)
    expect(entryNames(ctx)).not.toContain(MCP_CLIENT)
  })

  it('组合里没有声明任何服务时不创建任何实例', async () => {
    const { ctx, mounted, instances } = await loadComposition(`- name: '${PLUGIN}'\n`)
    expect(mounted).toEqual([])
    expect(instances).toEqual([])
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
    expect(pluginEntry(ctx).fiber?.state).toBe(2)
  })

  // 0.1.x 用户的 settings.yaml 段会被 harness 导入 `servers` 字段：它必须仍然生效，
  // 但可写层（设置页面）只认 `mcpServers`，所以非空时要提示迁移。
  it('遗留 servers 层参与生效清单，被 mcpServers 同名条目覆盖，并提示迁移一次', async () => {
    const { ctx, mounted, logs } = await loadComposition([
      `- name: '${PLUGIN}'`,
      '  config:',
      '    servers:',
      '      legacy-only:',
      '        command: legacy-server',
      '      shared:',
      '        command: from-legacy',
      '    mcpServers:',
      '      shared:',
      '        command: from-live',
      '',
    ].join('\n'))

    expect(mounted).toEqual([
      expect.objectContaining({ serverName: 'legacy-only', command: 'legacy-server' }),
      expect.objectContaining({ serverName: 'shared', command: 'from-live' }),
    ])
    expect(pluginEntry(ctx).fiber?.state).toBe(2)

    const warnings = logs.filter(message => message.type === 'warn'
      && String(message.args[0]).includes('legacy "servers" config layer'))
    expect(warnings).toHaveLength(1)
  })

  // 设置命名空间就是本条目 Config，浏览器另有我们的 MCP 页面；因此必须关掉按 schema
  // 自动生成的表单，否则设置里会出现两份 MCP 配置入口。卸载时那个决定要撤回。
  it('settings 服务在时关掉自动生成的配置表单，并在卸载时撤回', async () => {
    interface ConfigureCall {
      presentation: { auto?: boolean }
      owner: unknown
      disposed: boolean
    }
    const calls: ConfigureCall[] = []
    class FakeSettings extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'settings') }
      configure(presentation: { auto?: boolean }, owner?: unknown): () => void {
        const call: ConfigureCall = { presentation, owner, disposed: false }
        calls.push(call)
        return () => { call.disposed = true }
      }
    }

    const { ctx } = await loadComposition(`- name: '${PLUGIN}'\n`, async (loaderCtx) => {
      await loaderCtx.plugin(FakeSettings)
    })

    await until(() => calls.length === 1)
    const pluginFiber = pluginEntry(ctx).fiber
    expect(calls[0]?.presentation).toEqual({ auto: false })
    expect(calls[0]?.owner).toBe(pluginFiber)

    await pluginFiber!.dispose()
    expect(calls[0]?.disposed).toBe(true)
  })
})

describe('0.2.x volatile 热更新', () => {
  it('只改 mcpServers：未改动的服务保持运行，新增服务启动、被删服务停止', async () => {
    const { ctx, mounted, instances } = await loadComposition(COMPOSITION)
    const entry = pluginEntry(ctx)
    const alpha = liveInstances(instances).get('alpha')!
    const beta = liveInstances(instances).get('beta')!
    expect([...liveInstances(instances).keys()].sort()).toEqual(['alpha', 'beta'])
    expect(mounted).toHaveLength(2)

    // 只走 volatile 通道：alpha 原样保留、beta 删除、gamma 新增（off 仍然停用）。
    await entry.update({
      config: {
        mcpServers: {
          alpha: {
            command: 'alpha-server',
            args: ['--stdio'],
            env: { ALPHA_TOKEN: 'secret' },
          },
          gamma: { url: 'http://127.0.0.1:9/gamma' },
          off: { command: 'never-started', enabled: false },
        },
      },
    }, false, true)

    await until(() => liveInstances(instances).has('gamma') && beta.disposed)

    // 核心不变式：没改动的 alpha 还是同一份实例，连同它已经发现的工具继续运行。
    expect(liveInstances(instances).get('alpha')).toBe(alpha)
    expect(alpha.disposed).toBe(false)
    expect(beta.disposed).toBe(true)

    // 因此 bridge 替身只多收到新增 gamma 的一份配置；alpha 没有被重新 apply。
    expect(mounted).toHaveLength(3)
    expect(mounted[2]).toEqual({
      transport: 'streamable-http',
      serverName: 'gamma',
      url: 'http://127.0.0.1:9/gamma',
      headers: {},
      failOnStartupError: false,
    })

    // 插件没有被重挂，停用的服务依旧不创建。
    expect(entry.fiber?.state).toBe(2)
    expect([...liveInstances(instances).keys()].sort()).toEqual(['alpha', 'gamma'])
  })

  it('热更新改掉某个服务的配置时只重启那一份实例', async () => {
    const { ctx, mounted, instances } = await loadComposition(COMPOSITION)
    const entry = pluginEntry(ctx)
    const alpha = liveInstances(instances).get('alpha')!
    const beta = liveInstances(instances).get('beta')!

    await entry.update({
      config: {
        mcpServers: {
          alpha: { command: 'alpha-server', args: ['--stdio', '--verbose'] },
          beta: {
            url: 'http://127.0.0.1:9/mcp',
            headers: { Authorization: 'Bearer token' },
          },
        },
      },
    }, false, true)

    await until(() => mounted.length === 3 && alpha.disposed)

    // alpha 的旧实例被拆掉、新配置另起一份；beta 完全没被碰。
    expect(mounted[2]).toEqual(expect.objectContaining({ serverName: 'alpha' }))
    expect(liveInstances(instances).get('alpha')).not.toBe(alpha)
    expect(liveInstances(instances).get('beta')).toBe(beta)
    expect(beta.disposed).toBe(false)
    expect(entry.fiber?.state).toBe(2)
  })

  // 这是本次升级修掉的运行时 bug：bridge 的 apply() 会阻塞到自己连上 MCP 服务为止。
  // 若把它挂成 Loader 条目，一次设置写入会等 loader.await() 追到它，一个"能启动但一直
  // 不说话"的服务命令会让保存永远停在"保存中"。子插件不在 Loader 树里，因此收敛只
  // 等待实例创建，不等待连接完成。
  it('一个连不上的服务不会拖住收敛：实例照常创建，插件照常激活', async () => {
    const { ctx, instances } = await loadComposition([
      `- name: '${PLUGIN}'`,
      '  config:',
      '    mcpServers:',
      '      silent:',
      '        command: never-answers',
      '',
    ].join('\n'))

    expect(pluginEntry(ctx).fiber?.state).toBe(2)
    expect(liveInstances(instances).get('silent')).toBeDefined()
    // Loader 树里没有它的条目，所以下一次配置写入不会在 loader.await() 上等它。
    expect(entryNames(ctx)).not.toContain(MCP_CLIENT)
  })
})

describe('profile 里已经配好的 MCP 服务', () => {
  // 这是升级反馈里的核心诉求：profile 补丁里直接插入的 bridge 行不归本插件所有，但它们
  // 确实在跑；页面必须把它们列出来（只读），不能凭空消失。
  it('部署插入的 bridge 行被扫描进只读投影，同时在跑', async () => {
    const { ctx, instances } = await loadComposition([
      `- name: '${MCP_CLIENT}'`,
      '  config:',
      '    serverName: showdoc',
      '    transport: streamable-http',
      '    url: https://showdoc.invalid/mcp',
      `- name: '${PLUGIN}'`,
      '  config:',
      '    mcpServers:',
      '      alpha:',
      '        command: alpha-server',
      '',
    ].join('\n'))

    await until(() => Object.hasOwn(composedServers(ctx).deployment, 'showdoc'))

    const projection = composedServers(ctx)
    expect(projection.deployment).toEqual({
      showdoc: {
        enabled: true,
        transport: 'streamable-http',
        url: 'https://showdoc.invalid/mcp',
        headers: {},
      },
    })
    // 本插件自己的服务照常挂载；部署行那一份没有被重复挂载。
    expect([...liveInstances(instances).keys()].sort()).toEqual(['alpha', 'showdoc'])
  })

  it('同名时部署行优先：本插件的条目被跳过并报告，不产生两份实例', async () => {
    const { ctx, instances, logs } = await loadComposition([
      `- name: '${MCP_CLIENT}'`,
      '  config:',
      '    serverName: showdoc',
      '    transport: streamable-http',
      '    url: https://showdoc.invalid/mcp',
      `- name: '${PLUGIN}'`,
      '  config:',
      '    mcpServers:',
      '      showdoc:',
      '        url: https://other.invalid/mcp',
      '',
    ].join('\n'))

    await until(() => logs.some(message => message.type === 'error'
      && String(message.args[0]).includes('already mounted by a bridge row')))

    expect([...liveInstances(instances).keys()]).toEqual(['showdoc'])
    expect(composedServers(ctx).deployment.showdoc?.url).toBe('https://showdoc.invalid/mcp')
  })
})
