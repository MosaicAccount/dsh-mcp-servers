/**
 * MCP 服务注册表：外部 Model Context Protocol 服务清单的唯一所有者。
 *
 * 插件从三个地方解析这份清单——组合条目的内联配置、harness home 下的
 * `mcp.json` 文件、以及 `mcp-servers` 用户设置段；把它发布成设置命名空间供 Web
 * 设置页面编辑；并为每个启用的服务在 Loader 的内存根树上挂载一条
 * `@deepseek-ai/dsh-mcp-client` 行。因此在设置页面里保存会立即生效，既不用改文件
 * 也不用重启 harness。
 *
 * 挂载的行都是运行时创建的，而 `Loader.write()` 是空操作，所以本插件挂载的任何
 * 内容都不可能被写回组合文件；插件卸载时会移除它创建过的每一行。
 *
 * @module dsh-mcp-servers
 */

import type { Context } from '@deepseek-ai/cordis'
// 纯类型导入：把下面用到的 `loader` 与 `settings` 两个 Context 合并带进来。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  McpServerSchema,
  McpServersSchema,
  assertServers,
  mergeServers,
  partitionServers,
  readConfigFile,
  resolveConfigPath,
  toMcpClientConfig,
} from './servers.ts'
import type { McpServersResult } from './servers.ts'
import type { McpServerDefinition, McpServersSection } from './types.ts'

export type { McpServerDefinition, McpServersSection, McpTransport } from './types.ts'
export {
  MCP_CONFIG_FILENAME,
  MCP_CONFIG_SERVERS_KEY,
  McpServerSchema,
  McpServersSchema,
  SERVER_NAME_PATTERN,
  assertServers,
  mergeServers,
  partitionServers,
  readConfigFile,
  resolveConfigPath,
  resolveTransport,
  toMcpClientConfig,
} from './servers.ts'
export type { McpServersResult } from './servers.ts'
export type { McpClientConfig, McpClientHttpConfig, McpClientStdioConfig } from './servers.ts'
export { DSH_HOME_DIR_NAME, DSH_HOME_ENV, resolveDshHome } from './home.ts'

/** Cordis 插件名，供 Loader 诊断信息使用。 */
export const name = 'mcp-servers'

/** 必需服务：每个服务的 bridge 行要挂载进去的那棵条目树。 */
export const inject = ['loader']

/**
 * 存放服务清单的用户设置命名空间。Web 设置页面编辑的就是这个命名空间，因此这个
 * 字符串是插件两半之间的连接键。
 */
export const MCP_SERVERS_SETTINGS_NAMESPACE = 'mcp-servers'

/**
 * 按服务名挂载的 bridge 包。
 *
 * 它是由这个字符串解析出来的，而不是被 import 进来的——也就是说静态扫描工具看
 * 不到这层关系：组合本插件的部署必须能按名字解析到这个 bridge 包。
 */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** 注册表的配置。 */
export interface Config {
  /** 用于填充 base 层的 `mcp.json` 路径；默认 `<harness home>/mcp.json`。 */
  path?: string
  /** 内联组合的服务，合并在文件之上并按名称覆盖。 */
  mcpServers?: Record<string, McpServerDefinition>
}

/** 注册表配置的 schema。 */
export const Config: z<Config> = z.object({
  path: z.string(),
  mcpServers: z.dict(McpServerSchema).default({}),
})

/** 一条已挂载的行：Loader 条目 id，以及创建它时使用的确切配置。 */
interface Mount {
  entryId: string
  config: string
}

/**
 * 为每个启用的服务挂载一条 bridge 行，更新配置发生变化的行，移除服务已删除或已
 * 停用的行。收敛是幂等的：投影出的配置没变的服务会保留正在运行的行，连同它已经
 * 发现的工具。
 * @param ctx - 携带 `loader` 服务的上下文。
 * @param mounted - 按服务名索引的已挂载行，就地修改。
 * @param servers - 要收敛到的服务清单。
 */
export async function reconcile(
  ctx: Context,
  mounted: Map<string, Mount>,
  servers: Record<string, McpServerDefinition>,
): Promise<void> {
  const desired = new Map(
    Object.entries(servers).filter(([, definition]) => definition.enabled !== false),
  )

  for (const [serverName, mount] of [...mounted]) {
    if (desired.has(serverName)) continue
    mounted.delete(serverName)
    // 整棵树拆卸时（group.stop）可能已经把该条目移除了，此时没有东西可等。
    if (ctx.loader.store[mount.entryId] === undefined) continue
    await ctx.loader.remove(mount.entryId)
  }

  for (const [serverName, definition] of desired) {
    const config = toMcpClientConfig(serverName, definition)
    const serialized = JSON.stringify(config)
    const existing = mounted.get(serverName)
    if (existing !== undefined && ctx.loader.store[existing.entryId] !== undefined) {
      if (existing.config === serialized) continue
      // 改配置只会重启这一条行；没变化的服务继续运行。
      await ctx.loader.update(existing.entryId, { config })
      existing.config = serialized
      continue
    }
    const entryId = await ctx.loader.create({ name: MCP_CLIENT_PACKAGE, config })
    mounted.set(serverName, { entryId, config: serialized })
  }
}

/**
 * 解析本插件组合出的基础服务清单：读取解析后路径上的 `mcp.json`，再把配置行里的
 * 内联服务合并其上。
 *
 * 两个来源都逐条过滤：能挂载的进 `servers`，其余进 `problems`。这里不抛错——基础层
 * 来自用户可编辑的文件与部署组合，一条坏条目不该阻止 harness 启动（详见
 * {@link readConfigFile}）。
 * @param config - 解析后的插件配置。
 * @returns 可挂载的基础服务清单，以及所有被跳过条目的原因。
 */
export function resolveBaseServers(config: Config): McpServersResult {
  const file = readConfigFile(resolveConfigPath(config.path))
  const inline = partitionServers(config.mcpServers ?? {})
  return {
    servers: mergeServers(inline.servers, file.servers),
    problems: [
      ...file.problems,
      ...inline.problems.map(problem => `composition entry: ${problem}`),
    ],
  }
}

/**
 * 把服务清单发布成 `mcp-servers` 设置命名空间，并保持每个启用的服务有一条 bridge
 * 行处于挂载状态。
 *
 * 首次挂载会被 await，因此部署组合的服务在激活完成时就已经可达。挂载失败的行
 * ——命令没装、或者名称已被某条组合行占用——会被记录并跳过，而不是让整个插件激活
 * 失败：一个坏服务不该拖垮设置页面和其他所有服务。
 * @param ctx - 携带 `loader` 服务的上下文。
 * @param config - 解析后的插件配置。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const base = resolveBaseServers(config)
  const mounted = new Map<string, Mount>()
  let source = (): McpServersSection => ({ servers: base.servers })

  // 同一条问题只报一次：启动时首次收敛会跑多遍（installSection 的 attach 一次、这里
  // 一次），逐条刷屏会把真正有用的诊断淹掉。
  const reported = new Set<string>()
  const report = (problem: string): void => {
    if (reported.has(problem)) return
    reported.add(problem)
    ctx.logger.error(problem)
  }
  for (const problem of base.problems) report(problem)

  // 在任何 await 之前注册：即使首次挂载失败，本插件创建过的行也都会被拆掉。
  ctx.effect(() => () => {
    const pending = [...mounted.values()].reverse()
    mounted.clear()
    return (async () => {
      for (const mount of pending) {
        if (ctx.loader.store[mount.entryId] === undefined) continue
        await ctx.loader.remove(mount.entryId)
      }
    })()
  }, 'mcp-servers: mounted rows')

  // 写入与重新挂载都串到同一条 promise 链上，因此两次设置提交不可能交错执行各自
  // 的 remove/create 交换。
  let queue: Promise<void> = Promise.resolve()
  const converge = (): void => {
    queue = queue.then(async () => {
      // 设置文档也可能被手工改坏（validate 只挡得住经由本插件写入的值），所以这里
      // 同样逐条过滤，而不是把整份清单判为不可用。
      const { servers, problems } = partitionServers(source().servers)
      for (const problem of problems) report(problem)
      await reconcile(ctx, mounted, servers)
    }).catch((error: unknown) => {
      report(`mcp-servers: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(
      ctx,
      MCP_SERVERS_SETTINGS_NAMESPACE,
      McpServersSchema,
      { servers: base.servers },
      {
        setSource: (current) => { source = current },
        validate: (value) => { assertServers(value.servers) },
        onChange: () => { converge() },
      },
    )
  })

  // 没有挂载 settings provider 时，组合层与文件层就是全部配置，它们同样需要自己
  // 的行。
  converge()
  await queue
}
