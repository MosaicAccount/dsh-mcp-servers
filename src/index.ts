/**
 * MCP 服务注册表：外部 Model Context Protocol 服务清单的唯一所有者。
 *
 * 插件从三个地方解析这份清单，优先级从低到高：
 *
 * 1. harness home 下的 `mcp.json` 文件（激活时只读一次）；
 * 2. 本条目 Config 里 0.1.x 遗留的 `servers` 层（旧 `settings.yaml` 的段被 harness
 *    一次性导入到这里），让老用户升级后不丢服务；
 * 3. 本条目 Config 里的 `mcpServers` 层——唯一可从页面写入的层，标记为 volatile，
 *    因此写入会就地热更新而不重挂插件。
 *
 * 随后为每个启用的服务实例化一份 `@deepseek-ai/dsh-mcp-client` 子插件（模块本身仍由
 * Loader 按名字解析）。因此在设置页面里保存会立即生效，既不用改文件也不用重启
 * harness。
 *
 * 这里**不**把每个服务挂成 Loader 条目：settings 的配置写入会在 Host 侧
 * `loader.await()` 上等待所有条目 settle，而 bridge 的 `apply()` 会阻塞到首次 MCP
 * 连接完成。一个"能启动但一直不说话"的服务命令会让那次写入永远不返回，设置页面从此
 * 卡在"保存中"。子插件不在 Loader 树里，因此连接的快慢只影响该服务自己的工具何时
 * 出现，不会拖住别人的配置写入。
 *
 * 0.2.x 的设置命名空间就是 Loader 条目 id（由 `cordis.patch.yml` 固定为
 * `mcp-servers`），条目 Config schema 即设置段；浏览器通过 `ctx.configForms` 读写它。
 * 本插件关掉按 schema 自动生成的表单——我们有自己的 MCP 设置页面。
 *
 * 子插件都是运行时创建的，而 `Loader.write()` 是空操作，所以本插件创建的任何内容都
 * 不可能被写回组合文件；插件卸载时 Cordis 会连同它创建过的每一个子插件一起拆掉。
 *
 * @module dsh-mcp-servers
 */

import type { Context, Fiber, Plugin, Volatile } from '@deepseek-ai/cordis'
// 纯类型导入：把下面用到的 `loader` 与 `settings` 两个 Context 合并带进来。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  ComposedServersSchema,
  McpServerSchema,
  definitionFromBridgeConfig,
  emptyComposedServers,
  mergeServers,
  partitionServers,
  readConfigFile,
  readServers,
  resolveConfigPath,
  toMcpClientConfig,
} from './servers.ts'
import type { ComposedServers, McpServersResult } from './servers.ts'
import type { McpServerDefinition } from './types.ts'

export type { McpServerDefinition, McpTransport } from './types.ts'
export {
  ComposedServersSchema,
  MCP_CONFIG_FILENAME,
  MCP_CONFIG_SERVERS_KEY,
  McpServerSchema,
  SERVER_NAME_PATTERN,
  definitionFromBridgeConfig,
  emptyComposedServers,
  mergeServers,
  partitionServers,
  readConfigFile,
  readServers,
  resolveConfigPath,
  resolveTransport,
  toMcpClientConfig,
} from './servers.ts'
export type { ComposedServers, McpServersResult, ServersLayer } from './servers.ts'
export type { McpClientConfig, McpClientHttpConfig, McpClientStdioConfig } from './servers.ts'
export { DSH_HOME_DIR_NAME, DSH_HOME_ENV, resolveDshHome } from './home.ts'

/** Cordis 插件名，供 Loader 诊断信息使用。 */
export const name = 'mcp-servers'

/** 必需服务：每个服务的 bridge 行要挂载进去的那棵条目树。 */
export const inject = ['loader']

/**
 * 按服务名解析并实例化的 bridge 包。
 *
 * 它是由这个字符串经 Loader 解析出来的，而不是被 `import` 进来的——也就是说静态
 * 扫描工具看不到这层关系：组合本插件的部署必须能按名字解析到这个 bridge 包。这也是
 * 本包 Host 产物可以保持零运行期 import 的原因。
 */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/**
 * 写一个 volatile 配置引用。
 *
 * 公开的 `Volatile<T>` 类型只暴露 `get()`；就地提交走的是 Loader 与 schemastery 共用的
 * 全局 symbol 协议（`Symbol.for('cosmokit.volatile.write')`）。只读投影层必须由 Host
 * 在激活时就地填值，而它不经过 Loader 的配置提交，所以这里直接借用同一个协议——不引入
 * 任何运行期依赖，也不改变 Loader 拥有的引用身份。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 把值写进一个 volatile 引用；传入的不是引用（纯函数测试里的普通对象）时静默跳过。
 * @param ref - volatile 引用。
 * @param value - 新的只读快照。
 */
function setVolatileValue(ref: unknown, value: unknown): void {
  if (typeof ref !== 'object' || ref === null) return
  const write: unknown = Reflect.get(ref, VOLATILE_WRITE)
  if (typeof write === 'function') (write as (next: unknown) => void).call(ref, value)
}

/**
 * 扫描部署在 profile patch / `cordis.yml` 里、由**别人的行**挂载的 MCP 服务。
 *
 * 这些行不归本插件所有，但它们确实在跑；设置页面要把它们列出来（只读），用户才看得到
 * "profile 里已经配好的 MCP"。只收根 Loader 树里的行：Agent 预设等子树里的 MCP 行是
 * 会话级的，不属于部署清单。
 * @param ctx - 携带 `loader` 服务的上下文。
 * @returns 按 `serverName` 索引的存储态定义。
 */
export function scanDeploymentServers(ctx: Context): Record<string, McpServerDefinition> {
  const servers: Record<string, McpServerDefinition> = {}
  // 本插件那一行所在的 include 树就是"这个部署"的树；Agent 预设等子树里的 MCP 行
  // 是会话级的，不参与部署清单。
  const ownTree = ctx.fiber.entry?.parent.tree
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name !== MCP_CLIENT_PACKAGE) continue
    if (ownTree !== undefined && entry.parent.tree !== ownTree) continue
    // 已经激活的行给出解析后的配置（默认值齐全）；还没激活的退回升级前的原始配置。
    const config: unknown = entry.fiber?.config ?? entry.options.config
    const definition = definitionFromBridgeConfig(config)
    if (definition === undefined) continue
    const serverName = (config as Record<string, unknown>).serverName
    if (typeof serverName !== 'string' || Object.hasOwn(servers, serverName)) continue
    servers[serverName] = definition
  }
  return servers
}

/** 注册表的配置，也就是本插件 Loader 条目的设置段。 */
export interface Config {
  /** 用于填充 base 层的 `mcp.json` 路径；默认 `<harness home>/mcp.json`。 */
  path?: string
  /**
   * 可写层：MCP 设置页面编辑的服务，覆盖文件层与遗留的 `servers` 层。
   *
   * 标记为 volatile，因此页面写入由 Loader 就地提交进这个引用：值变了，插件不重挂，
   * 只收到一条 `loader/volatile-update`。运行期这里是 volatile 引用（用 `.get()` 读）；
   * 纯函数调用方（组合代码、测试）可以直接给普通映射，{@link readServers} 两种都认。
   */
  mcpServers?: Volatile<Record<string, McpServerDefinition>> | Record<string, McpServerDefinition>
  /**
   * 0.1.x 兼容层：旧 `settings.yaml` 里 `mcp-servers` 段的服务。
   *
   * harness 升级时会把那一段一次性导入本字段。它参与生效清单，但不归设置页面编辑。
   */
  servers?: Record<string, McpServerDefinition>
  /**
   * 只读投影层：不归设置页面写、但已经参与生效清单的服务。
   *
   * Host 在激活与每次配置变化时扫描 Loader 树（profile patch / `cordis.yml` 里直接插入
   * 的 `@deepseek-ai/dsh-mcp-client` 行）、`mcp.json` 文件层与遗留 `servers` 层，把结果
   * 写进这个 volatile 字段。设置页面因此能把"profile 里已经配好、但由部署维护"的 MCP
   * 服务列出来（只读），而不是让它们凭空消失。它永远不会被页面或组合持久化。
   */
  composedServers?: Volatile<ComposedServers> | ComposedServers
}

/** 注册表配置在组合文档里的原始形状：volatile 层在这里仍是普通映射。 */
export interface ConfigInput {
  /** 用于填充 base 层的 `mcp.json` 路径；默认 `<harness home>/mcp.json`。 */
  path?: string
  /** 可写层的原始映射；Loader 校验后交给插件的会是同名 volatile 引用。 */
  mcpServers?: Record<string, McpServerDefinition>
  /** 0.1.x 兼容层的原始映射。 */
  servers?: Record<string, McpServerDefinition>
}

/** 注册表配置的 schema；条目 id 即设置命名空间。 */
export const Config: z<ConfigInput, Config> = z.object({
  path: z.string(),
  mcpServers: z.dict(McpServerSchema).default({}).volatile(),
  servers: z.dict(McpServerSchema),
  // 只读投影：Loader 为它创建 volatile 引用，Host 在激活时就地填值，页面只读展示。
  composedServers: ComposedServersSchema.default(emptyComposedServers()).volatile(),
})

/** 一条已挂载的服务：bridge 子插件的 fiber，以及创建它时使用的确切配置。 */
interface Mount {
  fiber: Fiber
  config: string
}

/** 把 bridge 的模块命名空间解析成 Cordis 插件，并按服务实例化。 */
interface BridgeLoader {
  /** 解析并缓存 bridge 插件；解析失败会拒绝每一次调用。 */
  plugin: () => Promise<Plugin>
}

/**
 * 通过 Loader 自己那套模块解析（profile / installation 的闭包）加载 bridge 模块。
 *
 * 这里不 `import '@deepseek-ai/dsh-mcp-client'`：本包发布出去时并不携带 bridge 的
 * 依赖，只有部署的解析闭包才找得到它。
 * @param ctx - 携带 `loader` 服务的上下文。
 * @returns 按需解析并缓存插件对象的加载器。
 */
function bridgeLoader(ctx: Context): BridgeLoader {
  let plugin: Promise<Plugin> | undefined
  return {
    plugin: () => plugin ??= (async () => {
      const module: unknown = await ctx.loader.import(MCP_CLIENT_PACKAGE)
      return ctx.loader.unwrapExports(module) as Plugin
    })(),
  }
}

/**
 * 为每个启用的服务实例化一份 bridge 子插件，更新配置发生变化的实例，移除服务已删除
 * 或已停用的实例。收敛是幂等的：投影出的配置没变的服务会保留正在运行的实例，连同它
 * 已经发现的工具。
 *
 * 子插件不进入 Loader 树，因此 bridge 的启动（它会等到首次 MCP 连接完成）不会进入
 * 配置写入所等待的 `loader.await()`。
 * @param ctx - 携带 `loader` 服务的上下文。
 * @param mounted - 按服务名索引的已挂载实例，就地修改。
 * @param servers - 要收敛到的服务清单。
 * @param report - 记录一次失败；同一条原因只会被记录一次。
 */
export async function reconcile(
  ctx: Context,
  mounted: Map<string, Mount>,
  servers: Record<string, McpServerDefinition>,
  report: (problem: string) => void = problem => { ctx.logger.error(problem) },
): Promise<void> {
  const desired = new Map(
    Object.entries(servers).filter(([, definition]) => definition.enabled !== false),
  )

  for (const [serverName, mount] of [...mounted]) {
    if (desired.has(serverName)) continue
    mounted.delete(serverName)
    await mount.fiber.dispose()
  }

  const bridge = desired.size === 0 ? undefined : bridgeLoader(ctx)
  for (const [serverName, definition] of desired) {
    const config = toMcpClientConfig(serverName, definition)
    const serialized = JSON.stringify(config)
    const existing = mounted.get(serverName)
    if (existing !== undefined) {
      if (existing.config === serialized) continue
      // 改配置只会重启这一份子插件；没变化的服务继续运行。
      mounted.delete(serverName)
      await existing.fiber.dispose()
    }
    let plugin: Plugin
    try {
      plugin = await bridge!.plugin()
    } catch (error: unknown) {
      // bridge 解析不到是部署问题，不是这一条服务的问题：报告后不再重试同一批服务。
      report(`mcp-servers: cannot load ${MCP_CLIENT_PACKAGE}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const fiber = ctx.plugin(plugin, config)
    mounted.set(serverName, { fiber, config: serialized })
    // 子插件的 apply 可能失败（例如 serverName 撞车）。Cordis 会记录 fiber 状态，
    // 这里只把失败带进同一条去重报告通道；启动的快慢完全不影响本插件。
    void Promise.resolve(fiber).catch((error: unknown) => {
      report(`mcp-servers: server "${serverName}" failed to start: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

/**
 * 解析最低的两个配置层：`mcp.json` 文件层，以及 0.1.x 遗留的 `servers` 配置层。
 *
 * 两层都逐条过滤：能挂载的进 `servers`，其余进 `problems`。这里不抛错——这两层都
 * 来自用户可编辑的数据，一条坏条目不该阻止 harness 启动（详见 {@link readConfigFile}）。
 * @param config - 解析后的插件配置。
 * @returns 可挂载的基础服务清单、所有被跳过条目的原因，以及两层各自可用的条目。
 */
export function resolveBaseServers(config: Config): BaseServers {
  const file = readConfigFile(resolveConfigPath(config.path))
  const legacy = partitionServers(readServers(config.servers))
  return {
    servers: mergeServers(legacy.servers, file.servers),
    problems: [
      ...file.problems,
      ...legacy.problems.map(problem => `legacy "servers" layer: ${problem}`),
    ],
    file: file.servers,
    legacy: legacy.servers,
  }
}

/** 基础层解析结果：合并后的清单，加上页面只读展示需要的两层明细。 */
export interface BaseServers extends McpServersResult {
  /** `mcp.json` 文件层里可挂载的条目。 */
  file: Record<string, McpServerDefinition>
  /** 0.1.x 遗留 `servers` 层里可挂载的条目。 */
  legacy: Record<string, McpServerDefinition>
}

/**
 * 保持每个启用的服务有一份 bridge 子插件在运行，并跟随设置页面写入的 volatile
 * 配置热更新。
 *
 * 子插件的创建与销毁会被 await，但它们的**启动**（首次 MCP 连接）不会：bridge 的
 * `apply()` 阻塞到自己连上服务为止，把它放进 Loader 树会让一次设置写入陪着等到
 * 超时。启动失败的服务——命令没装、或者名称已被别处占用——会被记录并跳过，而不是让
 * 整个插件激活失败：一个坏服务不该拖垮设置页面和其他所有服务。
 * @param ctx - 携带 `loader` 服务的上下文。
 * @param config - 解析后的插件配置；`mcpServers` 是就地更新的 volatile 引用。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const base = resolveBaseServers(config)
  const mounted = new Map<string, Mount>()

  // 只读投影：把"已经在跑、但不归本插件写"的服务发布给设置页面（部署插入的 bridge
  // 行、mcp.json 文件层、0.1.x 遗留 servers 层）。页面因此能把当前 profile 里已经配好
  // 的 MCP 列出来，而不是只列本插件自己写的那一层。
  const publishComposed = (): void => {
    setVolatileValue(config.composedServers, {
      deployment: scanDeploymentServers(ctx),
      file: base.file,
      legacy: base.legacy,
    } satisfies ComposedServers)
  }
  publishComposed()
  // 首次激活时别的行可能还没 settle（解析后的配置才有默认值、!!js 才有结果），补一次投影。
  ctx.effect(() => {
    const timer = setTimeout(publishComposed, 0)
    return () => { clearTimeout(timer) }
  }, 'mcp-servers: composed projection refresh')

  // 同一条问题只报一次：首次收敛、volatile 热更新与重新挂载都会各跑一遍，逐条刷屏
  // 会把真正有用的诊断淹掉。
  const reported = new Set<string>()
  const report = (problem: string): void => {
    if (reported.has(problem)) return
    reported.add(problem)
    ctx.logger.error(problem)
  }
  for (const problem of base.problems) report(problem)

  // 0.1.x 升级路径：旧 settings.yaml 的段被导入本条目的 `servers` 字段。它照样生效，
  // 但可写层已经是 `mcpServers`，提示用户把条目搬过去才能从页面编辑。
  if (Object.keys(readServers(config.servers)).length > 0) {
    ctx.logger.warn(
      'mcp-servers: the legacy "servers" config layer is still mounted; '
      + 'move those entries to "mcpServers" so the MCP settings page can edit them',
    )
  }

  // 在任何 await 之前注册：即使首次挂载失败，本插件创建过的子插件也都会被拆掉。
  // Cordis 会在父 fiber 卸载时回收子 fiber；这里显式拆一遍，让本次收敛里创建到一半
  // 的实例也能立即停下，而不是等父级清理。
  ctx.effect(() => () => {
    const pending = [...mounted.values()].reverse()
    mounted.clear()
    return (async () => {
      for (const mount of pending) await mount.fiber.dispose()
    })()
  }, 'mcp-servers: bridge plugins')

  /**
   * 生效清单：volatile 层覆盖遗留层，遗留层覆盖文件层。
   *
   * 部署里已经由独立 bridge 行提供的名字不再重复挂载——否则 bridge 会以 serverName
   * 冲突为由拒绝第二份实例。这也正是"把 profile 里已有的行迁到页面"的约束：先把那条
   * 行从 profile 补丁里删掉，页面上的条目才会真正接管。
   */
  const source = (): McpServersResult => {
    // 页面写入经过 Config schema 校验，但 schema 挡不住"语义上挂不起来"的值
    // （比如没有 command 的 stdio 条目），所以这一层同样逐条过滤。
    const live = partitionServers(readServers(config.mcpServers))
    const deployment = scanDeploymentServers(ctx)
    const merged = mergeServers(live.servers, base.servers)
    const servers: Record<string, McpServerDefinition> = {}
    const problems = [...live.problems]
    for (const [name, definition] of Object.entries(merged)) {
      if (Object.hasOwn(deployment, name)) {
        problems.push(`mcp-servers: server "${name}" is already mounted by a bridge row in this profile; `
          + 'remove that row before managing it here')
        continue
      }
      servers[name] = definition
    }
    return { servers, problems }
  }

  // 写入与重新挂载都串到同一条 promise 链上，因此两次设置提交不可能交错执行各自
  // 的 remove/create 交换。
  let queue: Promise<void> = Promise.resolve()
  const converge = (): void => {
    queue = queue.then(async () => {
      const { servers, problems } = source()
      for (const problem of problems) report(problem)
      // reconcile 只等待子插件的创建/销毁，不等待它们连上 MCP 服务；bridge 的启动
      // 快慢因此不会进入配置写入所等待的 loader.await()。
      await reconcile(ctx, mounted, servers, report)
    }).catch((error: unknown) => {
      report(`mcp-servers: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // 只改 volatile 字段的配置写入由 Loader 就地提交进上面这份 config 的
  // `mcpServers` 引用，然后只向拥有它的 fiber 分发这个事件。事件到达时引用已经是
  // 新值，所以这里只需重新收敛：投影没变的子插件保持不动（核心不变式）。
  ctx.on('loader/volatile-update', () => {
    // Loader 会把 volatile 引用重写成 schema 默认值（投影层不在原始配置里），所以先补投影。
    publishComposed()
    converge()
  })
  // 组合树被重写（profile patch / cordis.yml 热更新）时，部署插入的行可能变化。
  ctx.on('loader/config-update', () => { publishComposed() })

  // 我们有自己的 MCP 设置页面，关掉按 schema 自动生成的表单。settings 服务缺席时
  // 这段依赖保持 pending，插件本身照常工作。
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  converge()
  await queue
}
