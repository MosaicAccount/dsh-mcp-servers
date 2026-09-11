/**
 * 由 `mcp-servers` 设置 scope 派生的服务清单状态。Host 始终是唯一权威：每次编辑都
 * 通过 scope 写入，页面则从写入后的快照重新渲染，因此被拒绝或被版本栅栏挡下的写入
 * 展示的是真正存下来的值，而不是表单刚才试图保存的值。
 *
 * @module dsh-mcp-servers/client
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  resolveTransport,
  serverTarget,
  type McpServerDefinition,
  type McpServersSection,
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
 * 读取某个原始设置层的 `servers` 映射。
 * @param layer - 形状未知的原始用户层。
 * @returns 服务映射；该层未携带时返回空对象。
 */
function serverMap(layer: unknown): Record<string, unknown> {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) return {}
  const servers = (layer as Record<string, unknown>).servers
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
   * @param scope - 已绑定的 `mcp-servers` 设置 scope。
   */
  constructor(private readonly scope: SettingsScope<McpServersSection>) {}

  /** 开始跟随绑定的 scope（幂等），并发布它当前的答案。 */
  load(): void {
    this.following ??= this.scope.subscribe(() => { this.derive() })
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
      ops.push({ op: 'unset', path: ['servers', previousName] })
    }
    // 存储态定义按构造就是 JSON 对象——每个字段都是字符串、数字、布尔、字符串数组
    // 或字符串映射——只是接口上的可选成员无法向线上类型表达这一点。
    ops.push({ op: 'set', path: ['servers', name], value: definition as unknown as SettingsOpValue })
    await this.write(ops, name, definition)
  }

  /**
   * 移除一个服务条目。
   * @param name - 待移除的服务名称空间。
   * @returns 写入完成并回读之后才 settle。
   */
  async remove(name: string): Promise<void> {
    await this.write([{ op: 'unset', path: ['servers', name] }], name, undefined)
  }

  /** 停止跟随该 scope。 */
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
      // 不使用固定版本栅栏：一行的编辑与其他行彼此独立，而 scope 本身已经用它所
      // 见到的最新版本做了栅栏。
      await this.scope.mutate(ops)
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
    const section = this.scope.getSnapshot().value
    const stored = section === undefined ? undefined : section.servers[name]
    if (expected === undefined) return stored === undefined
    return stored !== undefined && mountSignature(stored) === mountSignature(expected)
  }

  /** 发布绑定 scope 当前的答案。 */
  private derive(): void {
    const snapshot = this.scope.getSnapshot()
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
    const servers = snapshot.value?.servers ?? {}
    const overridden = serverMap(snapshot.user)
    const rows: McpServerRow[] = Object.entries(servers)
      .map(([name, definition]) => ({
        name,
        definition,
        enabled: definition.enabled !== false,
        transport: resolveTransport(definition),
        target: serverTarget(definition),
        overridden: Object.hasOwn(overridden, name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    this.store.update((state) => {
      state.status = 'ready'
      state.rows = rows
      state.writable = snapshot.writable
      state.error = null
    })
  }
}
