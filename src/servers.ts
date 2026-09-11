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

/**
 * 拒绝任何挂载不起来的服务清单。名称必须满足 bridge 的名称空间语法，每条定义必须
 * 带上其传输方式所需的字段。它挂在设置的 `validate` 钩子上，因此被拒的值在写入时
 * 就失败，而不是拖到下一次挂载。
 * @param servers - 待检查的服务清单。
 * @throws {Error} 指出出问题的服务名与缺失的字段。
 */
export function assertServers(servers: Record<string, McpServerDefinition>): void {
  for (const [name, definition] of Object.entries(servers)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`mcp-servers: server name "${name}" must match ${String(SERVER_NAME_PATTERN)}`)
    }
    const transport = resolveTransport(definition)
    if (transport === 'stdio' && (definition.command ?? '') === '') {
      throw new Error(`mcp-servers: server "${name}" uses stdio and requires a command`)
    }
    if (transport === 'streamable-http' && (definition.url ?? '') === '') {
      throw new Error(`mcp-servers: server "${name}" uses streamable-http and requires a url`)
    }
  }
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

/**
 * 从 `mcp.json` 文档里读出服务映射。文件不存在时返回空清单，这样从未写过该文件的
 * 部署组合结果与之前完全一致；但文件存在而结构不对时会直接报错，因为那是用户刻意
 * 编写的配置，不是可选文件。
 * @param path - 解析后的 `mcp.json` 路径。
 * @returns `mcpServers` 映射；文件不存在时为空对象。
 * @throws {Error} 文件存在却没有一个对象形式的 `mcpServers` 映射时。
 */
export function readConfigFile(path: string): Record<string, McpServerDefinition> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`mcp-servers: cannot read ${path}`, { cause: error })
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`mcp-servers: ${path} is not valid JSON`, { cause: error })
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`mcp-servers: ${path} must contain a JSON object`)
  }
  const servers = (document as Record<string, unknown>)[MCP_CONFIG_SERVERS_KEY]
  if (servers === undefined) return {}
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error(`mcp-servers: ${path} must carry "${MCP_CONFIG_SERVERS_KEY}" as an object`)
  }
  return servers as Record<string, McpServerDefinition>
}

/**
 * 把配置行里的内联服务合并到从 `mcp.json` 读到的服务之上。同名时内联条目胜出，因此
 * 部署可以覆盖共享文件里的内容而不必改文件。
 * @param inline - 该配置行自己的 `mcpServers`，可能为空。
 * @param file - 从配置路径读到的服务。
 * @returns 注册时解析所依据的基础服务清单。
 */
export function mergeServers(
  inline: Record<string, McpServerDefinition> | undefined,
  file: Record<string, McpServerDefinition>,
): Record<string, McpServerDefinition> {
  return { ...file, ...inline }
}
