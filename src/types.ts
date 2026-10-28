/**
 * 服务注册表的存储词汇：一台外部 Model Context Protocol 服务。纯类型，无运行时代码。
 *
 * 0.2.x 起设置段就是本插件 Loader 条目的 Config schema（命名空间 = 条目 id），
 * 不再是独立的 `mcp-servers` 设置文档；可写层是其中的 `mcpServers` 字典。
 *
 * @module dsh-mcp-servers
 */

/** 单个 MCP 服务连接的传输方式。 */
export type McpTransport = 'stdio' | 'streamable-http'

/**
 * 一条 MCP 服务定义，写法与组合条目、`mcp.json` 文件或用户编辑一致。
 * `mcpServers` 里的键就是这个服务的名称空间——也就是
 * `mcp__<serverName>__<tool>` 里的 `<serverName>`——所以这里不再重复。
 */
export interface McpServerDefinition {
  /** 注册表是否挂载该服务；缺省表示启用。 */
  enabled?: boolean
  /** 显式指定传输方式；缺省时由 `command` 与 `url` 推断。 */
  transport?: McpTransport
  /** stdio：为该服务启动的可执行文件。 */
  command?: string
  /** stdio：直接传递的参数，不经过 shell 插值。 */
  args?: string[]
  /** stdio：额外环境变量，合并在清洗过的环境之上。 */
  env?: Record<string, string>
  /** stdio：子进程的工作目录。 */
  cwd?: string
  /** streamable-http：MCP 端点地址。 */
  url?: string
  /** streamable-http：附加到 MCP 请求上的额外请求头。 */
  headers?: Record<string, string>
  /** 单次工具调用超时（毫秒）；缺省使用 bridge 的默认值。 */
  toolCallTimeoutMs?: number
}
