/**
 * 存储态的服务定义：单条定义与一层服务清单的 schema、挂载前必须通过的检查、被投影成
 * 的 bridge 配置，以及作为基础层的 `mcp.json` 文件。
 *
 * @module dsh-mcp-servers
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// 纯类型导入：volatile 配置字段在运行期是个稳定引用，这里只描述它的形状。
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from './home.ts'
import type { McpServerDefinition, McpTransport } from './types.ts'

/**
 * 服务名的合法字符。与 bridge 自己的 `SERVER_NAME_PATTERN` 完全一致：这个名字既是
 * 设置里的键，又是工具名的名称空间，所以 bridge 会拒绝的值绝不能走到挂载那一步。
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 未配置路径时，在 harness home 下解析的 `mcp.json` 文件名。 */
export const MCP_CONFIG_FILENAME = 'mcp.json'

/** 存放服务映射的 JSON 键，与其他 MCP 客户端互通时使用同一个名字。 */
export const MCP_CONFIG_SERVERS_KEY = 'mcpServers'

/** 单条存储态的服务定义，即设置 schema 解析后的样子。 */
export const McpServerSchema: z<McpServerDefinition> = z.object({
  enabled: z.boolean().default(true),
  transport: z.union([z.const('stdio'), z.const('streamable-http')]),
  command: z.string(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  cwd: z.string(),
  url: z.string(),
  headers: z.dict(String).default({}),
  toolCallTimeoutMs: z.number().step(1).min(1),
})

/**
 * 一层的服务清单：运行期是 volatile 配置引用，纯函数调用方（组合、测试）也可能直接
 * 给出普通对象。
 */
export type ServersLayer =
  | Volatile<Record<string, McpServerDefinition>>
  | Record<string, McpServerDefinition>
  | undefined

/**
 * 读出一层服务清单。
 *
 * 0.2.x 里可写层是 volatile 字段：Loader 把新值就地写进同一个引用，插件必须通过
 * `.get()` 读当前快照，而不是把 `apply()` 收到的对象当成值。纯函数调用方（组合
 * 配置、测试）直接传普通对象，两种形状都要接受；缺席的层贡献零个服务。
 * @param layer - 一层配置：volatile 引用、普通映射或 undefined。
 * @returns 该层当前的服务映射。
 */
export function readServers(layer: ServersLayer): Record<string, McpServerDefinition> {
  if (layer === undefined) return {}
  if (typeof (layer as Volatile<unknown>).get === 'function') {
    return (layer as Volatile<Record<string, McpServerDefinition>>).get() as unknown as
      Record<string, McpServerDefinition>
  }
  return layer as Record<string, McpServerDefinition>
}

/** 单个 stdio 服务的 bridge 配置，即 `@deepseek-ai/dsh-mcp-client` 接受的形式。 */
export interface McpClientStdioConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  toolCallTimeoutMs?: number
  failOnStartupError: false
}

/** 单个 Streamable HTTP 服务的 bridge 配置，即 bridge 接受的形式。 */
export interface McpClientHttpConfig {
  transport: 'streamable-http'
  serverName: string
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs?: number
  failOnStartupError: false
}

/** 单个服务的 bridge 配置：挂载行收到的确切 `config`。 */
export type McpClientConfig = McpClientStdioConfig | McpClientHttpConfig

/**
 * 推断一条定义的传输方式：显式指定的优先；有 `url` 而没有 `command` 判定为
 * Streamable HTTP；其余都是 stdio。
 * @param definition - 存储态的定义。
 * @returns 挂载时使用的传输方式。
 */
export function resolveTransport(definition: McpServerDefinition): McpTransport {
  if (definition.transport === 'stdio' || definition.transport === 'streamable-http') return definition.transport
  return definition.url !== undefined && definition.url !== '' && (definition.command ?? '') === ''
    ? 'streamable-http'
    : 'stdio'
}

/** 一次服务清单读取或合并的结果：能挂载的服务，以及全部被跳过的原因。 */
export interface McpServersResult {
  /** 通过挂载检查、可以交给 bridge 的服务。 */
  servers: Record<string, McpServerDefinition>
  /** 每条被跳过条目的原因，按发现顺序排列；被跳过的条目不会进入 `servers`。 */
  problems: string[]
}

/**
 * 报出一条定义无法挂载的原因。
 * @param name - 服务名称空间。
 * @param definition - 待检查的定义。
 * @returns 原因描述；可以挂载时返回 undefined。
 */
function describeServerProblem(name: string, definition: McpServerDefinition): string | undefined {
  if (!SERVER_NAME_PATTERN.test(name)) {
    return `mcp-servers: server name "${name}" must match ${String(SERVER_NAME_PATTERN)}`
  }
  // 这个值来自 JSON 或用户写入，类型系统看不到它。枚举外的取值（其他 MCP 客户端常见的
  // "sse"）必须在这里就被拦下：让它继续走下去，会在 Loader 校验条目 Config 那一步被
  // 静默丢弃（volatile 写入失败只留一条警告），表现为设置页面里"保存了却没生效"，
  // 比一条明确的报告难查得多。
  const declared: unknown = definition.transport
  if (declared !== undefined && declared !== 'stdio' && declared !== 'streamable-http') {
    return `mcp-servers: server "${name}" has unknown transport ${JSON.stringify(declared)}; `
      + 'use "stdio" or "streamable-http"'
  }
  const transport = resolveTransport(definition)
  if (transport === 'stdio' && (definition.command ?? '') === '') {
    return `mcp-servers: server "${name}" uses stdio and requires a command`
  }
  if (transport === 'streamable-http' && (definition.url ?? '') === '') {
    return `mcp-servers: server "${name}" uses streamable-http and requires a url`
  }
  return undefined
}

/**
 * 逐条检查服务定义，把能挂载的和不能挂载的分开。
 *
 * 注册表处理的是**用户可编辑的数据**，不是组合配置：一条读不懂或挂不起来的条目，正确
 * 的处理是"报告并跳过"。若让它抛错，harness 会连同启动一起失败——用户也就失去了修它
 * 的手段（设置页面根本打不开）。
 * @param servers - 待检查的服务清单。
 * @returns 能挂载的服务，以及每条被跳过条目的原因。
 */
export function partitionServers(servers: Record<string, McpServerDefinition>): McpServersResult {
  const usable: Record<string, McpServerDefinition> = {}
  const problems: string[] = []
  for (const [name, definition] of Object.entries(servers)) {
    const problem = describeServerProblem(name, definition)
    if (problem !== undefined) {
      problems.push(problem)
      continue
    }
    usable[name] = definition
  }
  return { servers: usable, problems }
}

/**
 * 把一条存储态的定义投影成 bridge 自己的配置。
 * `failOnStartupError` 固定为 false：用户刚添加的服务不该让本插件激活失败，重试交给
 * bridge 的重连循环。
 * @param name - 服务名称空间，用作 bridge 的 `serverName`。
 * @param definition - 待投影的存储态定义。
 * @returns 传给所挂载 bridge 行的配置。
 */
export function toMcpClientConfig(name: string, definition: McpServerDefinition): McpClientConfig {
  const shared = definition.toolCallTimeoutMs === undefined
    ? {}
    : { toolCallTimeoutMs: definition.toolCallTimeoutMs }
  if (resolveTransport(definition) === 'streamable-http') {
    return {
      transport: 'streamable-http',
      serverName: name,
      url: definition.url ?? '',
      headers: { ...definition.headers },
      failOnStartupError: false,
      ...shared,
    }
  }
  return {
    transport: 'stdio',
    serverName: name,
    command: definition.command ?? '',
    args: [...definition.args ?? []],
    env: { ...definition.env },
    cwd: definition.cwd ?? '',
    failOnStartupError: false,
    ...shared,
  }
}

/**
 * 解析 `mcp.json` 路径：给了配置路径就用它，否则用
 * `<harness home>/mcp.json`。
 * @param path - 配置的路径，可能为空。
 * @returns 读取基础服务清单所用的路径。
 */
export function resolveConfigPath(path: string | undefined): string {
  return path === undefined || path === '' ? join(resolveDshHome(), MCP_CONFIG_FILENAME) : path
}

/** 取一条错误的可读说明，用于诊断信息。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 从 `mcp.json` 文档里读出服务清单。
 *
 * 文件不存在是最常见的情况，贡献零个服务。文件存在但读不了、JSON 坏了、结构不对，或
 * 其中某条定义挂不起来时，问题会被收集到 `problems` 里，受影响的条目被跳过——**但绝不
 * 抛错**。
 *
 * 这一点是刻意的：这个文件是用户手写的可编辑数据。一个漏掉的逗号若能让 harness 启动
 * 失败，用户就同时失去了修它的手段——设置页面也打不开了。所以这里只报告。
 * @param path - 解析后的 `mcp.json` 路径。
 * @returns 文件中可用（且逐条通过挂载检查）的服务，以及发现的问题。
 */
export function readConfigFile(path: string): McpServersResult {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {}, problems: [] }
    return { servers: {}, problems: [`mcp-servers: cannot read ${path}: ${describeError(error)}`] }
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { servers: {}, problems: [`mcp-servers: ${path} is not valid JSON: ${describeError(error)}`] }
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { servers: {}, problems: [`mcp-servers: ${path} must contain a JSON object`] }
  }
  const declared = (document as Record<string, unknown>)[MCP_CONFIG_SERVERS_KEY]
  if (declared === undefined) return { servers: {}, problems: [] }
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    return {
      servers: {},
      problems: [`mcp-servers: ${path} must carry "${MCP_CONFIG_SERVERS_KEY}" as an object`],
    }
  }
  const { servers, problems } = partitionServers(declared as Record<string, McpServerDefinition>)
  return { servers, problems: problems.map(problem => `${path}: ${problem}`) }
}

/**
 * 只读的服务来源：不归设置页面写、但确实参与生效清单的层。
 *
 * 设置页面只编辑 `mcpServers`；这些层由 Host 扫描后投影给页面，让"profile 里已经配好
 * 的 MCP 服务"在页面上看得见（只读），而不是像以前那样完全消失。
 */
export interface ComposedServers {
  /**
   * 部署在 profile patch / `cordis.yml` 里直接插入的 `@deepseek-ai/dsh-mcp-client` 行，
   * 按 `serverName` 索引。
   */
  deployment: Record<string, McpServerDefinition>
  /** `mcp.json` 文件层提供的服务。 */
  file: Record<string, McpServerDefinition>
  /** 0.1.x 遗留 `servers` 层提供的服务（由旧 `settings.yaml` 导入）。 */
  legacy: Record<string, McpServerDefinition>
}

/** 只读投影层的 schema；字段与设置页面收到的线上形状一一对应。 */
export const ComposedServersSchema: z<ComposedServers> = z.object({
  deployment: z.dict(McpServerSchema).default({}),
  file: z.dict(McpServerSchema).default({}),
  legacy: z.dict(McpServerSchema).default({}),
})

/** 空的只读投影。 */
export function emptyComposedServers(): ComposedServers {
  return { deployment: {}, file: {}, legacy: {} }
}

/** 从任意 JSON 值里取字符串，取不到就返回 undefined。 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 从任意 JSON 值里取字符串列表，过滤掉非字符串项。 */
function textList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

/** 从任意 JSON 值里取字符串映射，过滤掉非字符串项。 */
function textDict(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item
  }
  return result
}

/**
 * 把一条 bridge 配置（部署行里 `@deepseek-ai/dsh-mcp-client` 的 config）反投影成存储
 * 态定义，供设置页面只读展示。
 *
 * 部署行的 config 是用户手写的组合数据，可能含 `!!js` 表达式、缺字段或类型不对，
 * 所以这里逐字段收窄；`serverName` 缺失或非法时返回 undefined（这条行不属于可展示的
 * 服务）。
 * @param config - 部署行的配置值。
 * @returns 存储态定义；无法当作 MCP 服务展示时返回 undefined。
 */
export function definitionFromBridgeConfig(config: unknown): McpServerDefinition | undefined {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined
  const record = config as Record<string, unknown>
  const serverName = text(record.serverName)
  if (serverName === undefined || !SERVER_NAME_PATTERN.test(serverName)) return undefined
  const timeout = record.toolCallTimeoutMs
  const toolCallTimeoutMs = typeof timeout === 'number' && Number.isSafeInteger(timeout) && timeout > 0
    ? timeout
    : undefined
  const shared = toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs }
  // 部署行通常显式写 transport；省略时按 bridge 同样的规则推断，别让一条手写行消失。
  const transport = record.transport === 'stdio' || record.transport === 'streamable-http'
    ? record.transport
    : text(record.url) !== undefined && text(record.url) !== '' && (text(record.command) ?? '') === ''
      ? 'streamable-http'
      : 'stdio'
  if (transport === 'streamable-http') {
    const url = text(record.url)
    if (url === undefined || url === '') return undefined
    return {
      enabled: true,
      transport: 'streamable-http',
      url,
      headers: textDict(record.headers) ?? {},
      ...shared,
    }
  }
  const command = text(record.command)
  if (command === undefined || command === '') return undefined
  const cwd = text(record.cwd)
  return {
    enabled: true,
    transport: 'stdio',
    command,
    args: textList(record.args) ?? [],
    env: textDict(record.env) ?? {},
    ...cwd === undefined || cwd === '' ? {} : { cwd },
    ...shared,
  }
}

/**
 * 把配置行里的内联服务合并到从 `mcp.json` 读到的服务之上。同名时内联条目胜出，因此
 * 部署可以覆盖共享文件里的内容而不必改文件。
 *
 * 两侧都应先经过 {@link partitionServers}：这样一条读不懂的内联条目不会顶掉文件里
 * 同名且完好的那条。
 * @param inline - 该配置行自己已过滤过的 `mcpServers`，可能为空。
 * @param file - 从配置路径读到的、已过滤过的服务。
 * @returns 注册时解析所依据的基础服务清单。
 */
export function mergeServers(
  inline: Record<string, McpServerDefinition> | undefined,
  file: Record<string, McpServerDefinition>,
): Record<string, McpServerDefinition> {
  return { ...file, ...inline }
}
