/**
 * 存储态的服务定义：它们解析所用的设置 schema、挂载前必须通过的检查、被投影成的
 * bridge 配置，以及作为基础层的 `mcp.json` 文件。
 *
 * @module dsh-mcp-servers
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from './home.ts'
import type { McpServerDefinition, McpServersSection, McpTransport } from './types.ts'

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

/** `mcp-servers` 命名空间的设置 schema。 */
export const McpServersSchema: z<McpServersSection> = z.object({
  servers: z.dict(McpServerSchema).default({}),
})

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
  // 这个值来自 JSON，类型系统看不到它。枚举外的取值（其他 MCP 客户端常见的 "sse"）
  // 必须在这里就被拦下：让它继续走下去，会在设置命名空间的 schema 那一步炸掉
  // ——那时表现为设置页面静默不可用，比一条明确的报告难查得多。
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
 * 拒绝任何挂载不起来的服务清单。
 *
 * 这是设置命名空间的 `validate` 钩子：写入时用户就在场、可以立刻改正，所以这里直接
 * 拒绝这次写入，而不是把它存下来留到下次挂载才出问题。与 {@link partitionServers}
 * 的区别正是"用户在不在场"。
 * @param servers - 待检查的服务清单。
 * @throws {Error} 指出第一个出问题的服务与原因。
 */
export function assertServers(servers: Record<string, McpServerDefinition>): void {
  const [problem] = partitionServers(servers).problems
  if (problem !== undefined) throw new Error(problem)
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
