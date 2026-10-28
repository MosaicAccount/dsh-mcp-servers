/**
 * 由 `mcp-servers` 条目 Config 段派生的服务清单状态。Host 始终是唯一权威：每次编辑
 * 都通过 `ConfigForm` 写入，页面则从写入后的快照重新渲染，因此被拒绝或被版本栅栏挡
 * 下的写入展示的是真正存下来的值，而不是表单刚才试图保存的值。
 *
 * 0.2.x 里设置命名空间就是 Host 的 Loader 条目 id，页面通过 `ctx.configForms` 拿到
 * 该条目的表单；唯一可写层是 volatile 的 `mcpServers`。Host 是否接受一次写入，仍以
 * 写后快照里那一层的实际内容为准。
 *
 * @module dsh-mcp-servers/client
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  resolveTransport,
  serverTarget,
  type McpServerDefinition,
  type McpServerSource,
  type McpServersConfig,
  type McpTransport,
} from './servers.ts'

/**
 * 路径操作携带的值的类型。取自线上契约而不是重新声明，这样本包不需要再依赖任何
 * JSON 值类型。
 */
type SettingsOpValue = Extract<SettingsPathOpView, { op: 'set' }>['value']

/** 一个已配置的服务，拍平成便于渲染的形状。 */
export interface McpServerRow {
  /** 设置里的映射键，同时也是该服务的工具名称空间。 */
  readonly name: string
  /** 该行的编辑器打开时使用的存储态定义。 */
  readonly definition: McpServerDefinition
  /** 注册表是否挂载该服务。 */
  readonly enabled: boolean
  /** 该行展示的传输方式。 */
  readonly transport: McpTransport
  /** 该行摘要展示的命令行或端点。 */
  readonly target: string
  /** 该条目的来源层；只有 `own` 可以从本页编辑。 */
  readonly source: McpServerSource
  /** 该行是否允许编辑/删除。 */
  readonly editable: boolean
  /** 该条目是被用户层覆盖的，而不是由部署组合出来的。 */
  readonly overridden: boolean
}

/** MCP 区块渲染所需的状态。 */
export interface McpServersState {
  /** 服务清单是已加载、仍在加载，还是在此部署中不存在。 */
  status: 'loading' | 'ready' | 'unavailable'
  /** 已配置的服务，按名称排序。 */
  rows: McpServerRow[]
  /** Host 文档是否接受写入。 */
  writable: boolean
  /** 本页面最后一次无法确认的写入。 */
  error: 'refused' | null
  /** 是否有写入正在进行。 */
  saving: boolean
}

/**
 * 读取某个原始层（快照的用户层）的 `mcpServers` 映射。
 * @param layer - 形状未知的原始用户层。
 * @returns 服务映射；该层未携带时返回空对象。
 */
function userServerMap(layer: unknown): Record<string, unknown> {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) return {}
  const servers = (layer as Record<string, unknown>).mcpServers
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers)
    ? servers as Record<string, unknown>
    : {}
}

/**
 * 比较一次挂载真正依赖的字段，忽略键的顺序，也忽略 Host 在写入存储途中补上的默认
 * 值。直接比较序列化后的对象会把每一次成功保存都判成"被拒绝"，因为解析过程会给省
 * 略了 `args`、`env`、`headers` 的定义补上这些字段。
 * @param definition - 待归约的定义。
 * @returns 标识该定义所产生挂载的稳定字符串。
 */
export function mountSignature(definition: McpServerDefinition): string {
  return JSON.stringify([
    resolveTransport(definition),
    definition.enabled !== false,
    definition.command ?? '',
    definition.args ?? [],
    Object.entries(definition.env ?? {}).sort(),
    definition.cwd ?? '',
    definition.url ?? '',
    Object.entries(definition.headers ?? {}).sort(),
    definition.toolCallTimeoutMs ?? null,
  ])
}

/** 持有 MCP 设置页面这份服务清单副本及其写入逻辑。 */
export class McpServersStore {
  /** 供已注册的 MCP 区块共享、可安全用于 uSES 的状态源。 */
  readonly store: SnapshotStore<McpServersState> = createSnapshotStore<McpServersState>({
    status: 'loading', rows: [], writable: false, error: null, saving: false,
  })

  private following: (() => void) | undefined

  /**
   * @param form - `mcp-servers` Loader 条目的设置表单。
   */
  constructor(private readonly form: ConfigForm<McpServersConfig>) {}

  /** 开始跟随绑定的条目表单（幂等），并发布它当前的答案。 */
  load(): void {
    this.following ??= this.form.subscribe(() => { this.derive() })
    this.derive()
  }

  /**
   * 把一个服务存到 `name` 之下；名称空间变化时同时搬移该条目。
   * @param name - 编辑之后的服务名。
   * @param definition - 待存储的定义。
   * @param previousName - 编辑前的名称，仅在名称发生变化时给出。
   * @returns 写入完成并回读之后才 settle。
   */
  async save(name: string, definition: McpServerDefinition, previousName?: string): Promise<void> {
    const ops: SettingsPathOpView[] = []
    if (previousName !== undefined && previousName !== name) {
      ops.push({ op: 'unset', path: ['mcpServers', previousName] })
    }
    // 存储态定义按构造就是 JSON 对象——每个字段都是字符串、数字、布尔、字符串数组
    // 或字符串映射——只是接口上的可选成员无法向线上类型表达这一点。
    ops.push({ op: 'set', path: ['mcpServers', name], value: definition as unknown as SettingsOpValue })
    await this.write(ops, name, definition)
  }

  /**
   * 移除一个服务条目。
   * @param name - 待移除的服务名称空间。
   * @returns 写入完成并回读之后才 settle。
   */
  async remove(name: string): Promise<void> {
    await this.write([{ op: 'unset', path: ['mcpServers', name] }], name, undefined)
  }

  /** 停止跟随该条目表单。 */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  /**
   * 提交一次原子修改，并以 Host 现在存下来的内容判定它是否成功。
   * @param ops - 本次编辑所需的、按顺序排列的操作。
   * @param name - 本次编辑针对的服务。
   * @param expected - 本次编辑要求的定义；删除时为 undefined。
   */
  private async write(
    ops: readonly SettingsPathOpView[],
    name: string,
    expected: McpServerDefinition | undefined,
  ): Promise<void> {
    this.store.update((state) => { state.saving = true; state.error = null })
    try {
      // 不使用固定版本栅栏：一行的编辑与其他行彼此独立，而表单本身已经用它所见到
      // 的最新版本做了栅栏。
      await this.form.mutate(ops)
    } finally {
      this.store.update((state) => { state.saving = false })
    }
    this.derive()
    if (this.settled(name, expected)) return
    this.store.update((state) => { state.error = 'refused' })
  }

  /**
   * Host 现在存下来的，是否就是这次写入所要求的定义。
   * @param name - 本次编辑针对的服务。
   * @param expected - 要求的定义；删除时为 undefined。
   * @returns 存储值与要求是否一致。
   */
  private settled(name: string, expected: McpServerDefinition | undefined): boolean {
    const config = this.form.getSnapshot().value
    const stored = config?.mcpServers?.[name]
    if (expected === undefined) return stored === undefined
    return stored !== undefined && mountSignature(stored) === mountSignature(expected)
  }

  /** 发布绑定表单当前的答案。 */
  private derive(): void {
    const snapshot = this.form.getSnapshot()
    if (snapshot.status === 'unavailable') {
      this.store.update((state) => {
        state.status = 'unavailable'
        state.rows = []
        state.writable = false
        state.error = null
      })
      return
    }
    if (snapshot.status === 'loading') {
      this.store.update((state) => { state.status = 'loading'; state.error = null })
      return
    }
    const servers = snapshot.value?.mcpServers ?? {}
    const composed = snapshot.value?.composedServers
    const overridden = userServerMap(snapshot.user)
    // 页面把四层都渲染出来。同名时以**真正在跑**的那一层为准：部署插入的 bridge 行
    // 优先于页面写入的条目（Host 也不会重复挂载后者），然后是文件层与遗留层。
    const rows = new Map<string, McpServerRow>()
    const put = (name: string, definition: McpServerDefinition, source: McpServerSource): void => {
      if (rows.has(name)) return
      rows.set(name, {
        name,
        definition,
        enabled: definition.enabled !== false,
        transport: resolveTransport(definition),
        target: serverTarget(definition),
        source,
        editable: source === 'own',
        overridden: source === 'own' && Object.hasOwn(overridden, name),
      })
    }
    for (const [name, definition] of Object.entries(composed?.deployment ?? {})) put(name, definition, 'deployment')
    for (const [name, definition] of Object.entries(servers)) put(name, definition, 'own')
    for (const [name, definition] of Object.entries(composed?.file ?? {})) put(name, definition, 'file')
    for (const [name, definition] of Object.entries(composed?.legacy ?? {})) put(name, definition, 'legacy')
    this.store.update((state) => {
      state.status = 'ready'
      state.rows = [...rows.values()].sort((left, right) => left.name.localeCompare(right.name))
      state.writable = snapshot.writable
      state.error = null
    })
  }
}
