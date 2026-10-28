/**
 * 设置页面视角下的 MCP 服务词汇：存储态字段、暂存中的编辑草稿，以及两者之间的
 * 纯函数转换。
 *
 * 命名空间字符串是本包 Host 半边与浏览器半边之间的连接键。存储字段名在这里重新
 * 声明，而不是从 `../types.ts` 导入，是为了让这个浏览器程序不携带 Host 侧类型；
 * 一条定义意味着什么、以及每次写入是否合法，仍以 Host 为准。
 *
 * @module dsh-mcp-servers/client
 */

/** 单个 MCP 服务连接的传输方式。 */
export type McpTransport = 'stdio' | 'streamable-http'

/**
 * 一条存储态的 MCP 服务。`McpServersConfig.mcpServers` 的映射键就是该服务的名称
 * 空间——也就是 `mcp__<serverName>__<tool>` 里的 `<serverName>`——所以这里不再重复。
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

/** 一条服务来自哪一层：只有 `own` 归本页面编辑。 */
export type McpServerSource = 'own' | 'deployment' | 'file' | 'legacy'

/**
 * 本页面读写的 `mcp-servers` Loader 条目 Config 段。
 *
 * 0.2.x 里设置命名空间就是 Loader 条目 id，条目 Config schema 即设置段。页面编辑其中
 * 唯一可写（volatile）的 `mcpServers` 层；`composedServers` 是 Host 发布的**只读投影**，
 * 用来把已经在跑、但不归本页写的服务列出来（部署插入的 bridge 行、`mcp.json` 文件层、
 * 0.1.x 遗留 `servers` 层）。
 */
export interface McpServersConfig {
  /** 已配置的服务，以其工具发布所用的名称空间为键；页面唯一的可写层。 */
  mcpServers?: Record<string, McpServerDefinition>
  /** Host 发布的只读投影层。 */
  composedServers?: {
    deployment?: Record<string, McpServerDefinition>
    file?: Record<string, McpServerDefinition>
    legacy?: Record<string, McpServerDefinition>
  }
}

/**
 * Host 条目的 Loader id，同时也是浏览器读写设置时使用的命名空间；两半之间的
 * 连接键。没有挂载该条目的部署不会提供这个命名空间。
 */
export const MCP_SERVERS_NAMESPACE = 'mcp-servers'

/** Host 强制的服务名语法；同时也是工具名的名称空间。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * 按页面读取的方式接受一个条目 Config 段。不是对象、或 `mcpServers` 不是对象的段
 * 返回 undefined，这样页面渲染的是"缺失"状态，而不是一个只解析了一半的列表。
 * @param section - 线上传来的条目 Config 段。
 * @returns 该设置段；无法读取时返回 undefined。
 */
export function decodeMcpServersConfig(section: unknown): McpServersConfig | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const record = section as Record<string, unknown>
  const servers = record.mcpServers
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    return undefined
  }
  const composed = record.composedServers
  return {
    mcpServers: (servers ?? {}) as Record<string, McpServerDefinition>,
    ...typeof composed === 'object' && composed !== null && !Array.isArray(composed)
      ? { composedServers: composed as NonNullable<McpServersConfig['composedServers']> }
      : {},
  }
}

/**
 * 与 Host 相同的方式推断一条定义的传输方式：显式指定的优先；有 `url` 而没有
 * `command` 判定为 Streamable HTTP；其余都是 stdio。
 * @param definition - 存储态的定义。
 * @returns 挂载时会用到的传输方式。
 */
export function resolveTransport(definition: McpServerDefinition): McpTransport {
  if (definition.transport === 'stdio' || definition.transport === 'streamable-http') return definition.transport
  return definition.url !== undefined && definition.url !== '' && (definition.command ?? '') === ''
    ? 'streamable-http'
    : 'stdio'
}

/**
 * 生成列表中一行用于展示的连接目标。
 * @param definition - 存储态的定义。
 * @returns 命令行，或端点 URL。
 */
export function serverTarget(definition: McpServerDefinition): string {
  if (resolveTransport(definition) === 'streamable-http') return definition.url ?? ''
  const args = definition.args ?? []
  return [definition.command ?? '', ...args].filter(part => part !== '').join(' ')
}

/** 表单里一行键值对（环境变量或请求头）；两列都由用户逐个填写。 */
export interface KeyValueRow {
  /** 变量名或请求头名。 */
  key: string
  /** 变量值或请求头值。 */
  value: string
}

/** 一次暂存中的服务编辑；每个字段都对应表单里的一个控件。 */
export interface ServerDraft {
  /** 服务名称空间，即设置里的映射键。 */
  name: string
  /** 注册表是否挂载该服务。 */
  enabled: boolean
  /** 当前选中的传输方式。 */
  transport: McpTransport
  /** stdio 可执行文件。 */
  command: string
  /** stdio 参数；每个参数一个输入框。 */
  args: string[]
  /** stdio 环境变量；逐行编辑。 */
  env: KeyValueRow[]
  /** stdio 工作目录。 */
  cwd: string
  /** streamable-http 端点 URL。 */
  url: string
  /** streamable-http 请求头；逐行编辑。 */
  headers: KeyValueRow[]
  /** 单次工具调用超时，按用户输入的原样保存。 */
  toolCallTimeoutMs: string
}

/** 阻止保存某份草稿的问题。 */
export type McpDraftProblem = 'name' | 'command' | 'url' | 'timeout' | 'pairs'

/**
 * 一份引导模板：点一下就把常见服务填好，用户只需补路径/令牌。
 *
 * 只带命令、参数与传输方式，不预置任何真实凭据；名字会避开已有服务。
 */
export interface ServerTemplate {
  /** 稳定的模板键，文案由页面自己的字典提供。 */
  readonly id: 'blank' | 'memory' | 'filesystem' | 'remote'
}

/** 添加服务时可选的模板，按展示顺序排列。 */
export const SERVER_TEMPLATES: readonly ServerTemplate[] = [
  { id: 'memory' },
  { id: 'filesystem' },
  { id: 'remote' },
  { id: 'blank' },
]

/**
 * 把用户逐个填写的键值行收成映射：两列都空的行直接忽略，并报告缺名或重名。
 * @param rows - 表单里的键值行。
 * @returns 收好的映射；有缺名或重名时返回 undefined。
 */
export function collectPairs(rows: readonly KeyValueRow[]): Record<string, string> | undefined {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (key === '' && value === '') continue
    if (key === '' || Object.hasOwn(result, key)) return undefined
    result[key] = value
  }
  return result
}

/**
 * 一行键值对是否完整：要么两列都空（会被忽略），要么必须填名字。
 * @param row - 表单里的键值行。
 * @returns 该行是否可以进入保存。
 */
function completePair(row: KeyValueRow): boolean {
  return row.key.trim() !== '' || row.value.trim() === ''
}

/**
 * 从模板生成一份草稿；名字取模板名，并与已有名字去重。
 * @param id - 模板键。
 * @param takenNames - 当前已经存在的服务名，用来避免重名。
 * @returns 填好的草稿。
 */
export function draftFromTemplate(id: ServerTemplate['id'], takenNames: readonly string[] = []): ServerDraft {
  const draft = emptyDraft()
  const named = (base: string): string => {
    if (!takenNames.includes(base)) return base
    for (let index = 2; ; index += 1) {
      const candidate = `${base}-${index}`
      if (!takenNames.includes(candidate)) return candidate
    }
  }
  switch (id) {
    case 'memory':
      return { ...draft, name: named('memory'), command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }
    case 'filesystem':
      return {
        ...draft,
        name: named('filesystem'),
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/directory'],
      }
    case 'remote':
      return { ...draft, name: named('remote'), transport: 'streamable-http', url: 'http://localhost:3000/mcp' }
    case 'blank':
      return draft
  }
}

/** 新服务的空白草稿。 */
export function emptyDraft(): ServerDraft {
  return {
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: [],
    env: [],
    cwd: '',
    url: '',
    headers: [],
    toolCallTimeoutMs: '',
  }
}

/** 把一个映射展开成表单里的键值行。 */
function pairRows(values: Record<string, string> | undefined): KeyValueRow[] {
  return Object.entries(values ?? {}).map(([key, value]) => ({ key, value }))
}

/**
 * 把一条存储态定义暂存成可编辑的草稿。
 * @param name - 设置里的映射键。
 * @param definition - 存储态的定义。
 * @returns 可写的草稿。
 */
export function draftFrom(name: string, definition: McpServerDefinition): ServerDraft {
  const args = definition.args ?? []
  return {
    name,
    enabled: definition.enabled !== false,
    transport: resolveTransport(definition),
    command: definition.command ?? '',
    args: [...args],
    env: pairRows(definition.env),
    cwd: definition.cwd ?? '',
    url: definition.url ?? '',
    headers: pairRows(definition.headers),
    toolCallTimeoutMs: definition.toolCallTimeoutMs === undefined ? '' : String(definition.toolCallTimeoutMs),
  }
}

/**
 * 报出某份草稿无法保存的第一个原因。
 * @param draft - 暂存中的草稿。
 * @returns 阻止保存的问题；可以保存时返回 null。
 */
export function validateDraft(draft: ServerDraft): McpDraftProblem | null {
  if (!SERVER_NAME_PATTERN.test(draft.name)) return 'name'
  const rows = draft.transport === 'stdio' ? draft.env : draft.headers
  if (!rows.every(completePair)) return 'pairs'
  if (collectPairs(rows) === undefined) return 'pairs'
  if (draft.transport === 'stdio') return draft.command.trim() === '' ? 'command' : null
  return draft.url.trim() === '' ? 'url' : null
}

/**
 * 把校验通过的草稿投影成存储态定义。属于另一种传输方式的字段会被丢弃，这样切换
 * 传输方式不会留下过期的 `command` 或 `url` 让 Host 去收拾。
 * @param draft - 暂存中的草稿。
 * @returns 待写入的定义；超时不可用时返回 undefined。
 */
export function definitionFrom(draft: ServerDraft): McpServerDefinition | undefined {
  const timeout = draft.toolCallTimeoutMs.trim()
  const toolCallTimeoutMs = timeout === '' ? undefined : Number(timeout)
  if (toolCallTimeoutMs !== undefined && (!Number.isSafeInteger(toolCallTimeoutMs) || toolCallTimeoutMs < 1)) {
    return undefined
  }
  const shared = {
    enabled: draft.enabled,
    transport: draft.transport,
    ...toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs },
  }
  if (draft.transport === 'streamable-http') {
    return { ...shared, url: draft.url.trim(), headers: collectPairs(draft.headers) ?? {} }
  }
  const cwd = draft.cwd.trim()
  return {
    ...shared,
    command: draft.command.trim(),
    args: draft.args.map(argument => argument.trim()).filter(argument => argument !== ''),
    env: collectPairs(draft.env) ?? {},
    ...cwd === '' ? {} : { cwd },
  }
}
