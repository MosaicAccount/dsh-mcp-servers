/**
 * 服务清单控制器：用假的 `ConfigForm` 验证派生、写入路径、成功判定与生命周期。
 *
 * 页面从不自己保存清单：`save()`/`remove()` 只是把路径操作交给 `ConfigForm`，
 * 然后回读快照判断 Host 是否真的接受。这些用例钉住的正是这个契约——包括
 * "写入被拒绝时页面展示的是存下来的值"，以及"Host 补齐默认字段不算拒绝"。
 */

import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { McpServersStore } from '../src/client/store.ts'
import type { McpServerDefinition, McpServersConfig } from '../src/client/servers.ts'

// 快照 store 引擎属于外壳的冻结模块表（zustand/immer 随外壳发行），Node 测试里无法
// 求值；换成只实现本包所用四项能力的最小替身。
vi.mock('@deepseek-ai/dsh-client-store', async () => await import('./support/client-store-stub.ts'))

type Snapshot = ConfigFormSnapshot<McpServersConfig>

/**
 * 一份最小的 `ConfigForm` 替身：记录每次提交的路径操作，把它们应用到快照，
 * 并像真实实现那样在每次变化后发布新的快照对象。
 */
class FakeConfigForm implements ConfigForm<McpServersConfig> {
  /** 每次 `mutate()` 收到的操作序列。 */
  readonly mutations: SettingsPathOpView[][] = []

  /** Host 是否接受写入；false 时快照保持不变（模拟拒绝）。 */
  accept = true

  /** 写入被应用之前的归约步骤，用来模拟 Host 补默认值。 */
  normalize: ((definition: McpServerDefinition) => McpServerDefinition) | undefined

  /** 下一次 `mutate()` 抛出的传输错误。 */
  failWith: Error | undefined

  private snapshot: Snapshot
  private readonly listeners = new Set<() => void>()

  constructor(initial: Partial<Snapshot> = {}) {
    this.snapshot = {
      status: 'ready',
      value: { mcpServers: {} },
      base: undefined,
      user: undefined,
      revision: 1,
      writable: true,
      ...initial,
    }
  }

  getSnapshot(): Snapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 当前订阅者数量；用来断言 `load()` 幂等与 `dispose()` 解绑。 */
  get subscriberCount(): number {
    return this.listeners.size
  }

  async mutate(ops: readonly SettingsPathOpView[]): Promise<boolean> {
    this.mutations.push([...ops])
    const failure = this.failWith
    this.failWith = undefined
    if (failure !== undefined) throw failure
    if (this.accept) this.apply(ops)
    this.publish()
    return this.accept
  }

  async set(field: string, value: unknown): Promise<boolean> {
    return this.mutate([{ op: 'set', path: [field], value: value as never }])
  }

  async unset(field: string): Promise<boolean> {
    return this.mutate([{ op: 'unset', path: [field] }])
  }

  /** 把操作应用到 `mcpServers` 层；本页面只会写这一层。 */
  private apply(ops: readonly SettingsPathOpView[]): void {
    const servers: Record<string, McpServerDefinition> = { ...(this.snapshot.value?.mcpServers ?? {}) }
    for (const op of ops) {
      const [layer, name] = op.path
      if (layer !== 'mcpServers' || name === undefined) continue
      if (op.op === 'set') {
        const value = op.value as unknown as McpServerDefinition
        servers[name] = this.normalize === undefined ? value : this.normalize(value)
      } else {
        delete servers[name]
      }
    }
    this.snapshot = {
      ...this.snapshot,
      value: { ...(this.snapshot.value ?? {}), mcpServers: servers },
    }
  }

  /** 发布一份新快照，并通知订阅者。 */
  private publish(): void {
    this.snapshot = { ...this.snapshot, revision: (this.snapshot.revision ?? 0) + 1 }
    for (const listener of [...this.listeners]) listener()
  }
}

/** 一台启用的 stdio 服务的定义。 */
const ALPHA: McpServerDefinition = { command: 'alpha-server', args: ['--stdio'] }

/** 一台停用的 HTTP 服务的定义。 */
const BETA: McpServerDefinition = { url: 'http://127.0.0.1:9/mcp', enabled: false }

/** 构造一份带有两台服务、其中一台被用户层覆盖的就绪快照。 */
function readySnapshot(): Partial<Snapshot> {
  return {
    value: { mcpServers: { beta: BETA, alpha: ALPHA } },
    user: { mcpServers: { alpha: ALPHA } },
  }
}

describe('McpServersStore.derive', () => {
  it('把部署插入的 bridge 行与 mcp.json 层也列出来，但保持只读', () => {
    const form = new FakeConfigForm({
      value: {
        mcpServers: { own: { command: 'own-server' } },
        composedServers: {
          deployment: { showdoc: { url: 'https://showdoc.invalid/mcp' } },
          file: { fromFile: { command: 'file-server' } },
          legacy: { fromLegacy: { command: 'legacy-server' } },
        },
      },
      user: { mcpServers: {} },
    })
    const store = new McpServersStore(form)
    store.load()

    const rows = store.store.getSnapshot().rows
    expect(rows.map(row => [row.name, row.source, row.editable])).toEqual([
      ['fromFile', 'file', false],
      ['fromLegacy', 'legacy', false],
      ['own', 'own', true],
      ['showdoc', 'deployment', false],
    ])
  })

  it('同名时以真正在跑的那一层为准：部署行压过页面条目，页面条目压过文件层', () => {
    const form = new FakeConfigForm({
      value: {
        mcpServers: { shared: { command: 'from-page' }, pageOnly: { command: 'page' } },
        composedServers: {
          deployment: { shared: { command: 'from-deployment' } },
          file: { pageOnly: { command: 'from-file' }, fileOnly: { command: 'file' } },
        },
      },
      user: { mcpServers: {} },
    })
    const store = new McpServersStore(form)
    store.load()

    const rows = new Map(store.store.getSnapshot().rows.map(row => [row.name, row]))
    expect(rows.get('shared')?.definition.command).toBe('from-deployment')
    expect(rows.get('shared')?.editable).toBe(false)
    expect(rows.get('pageOnly')?.definition.command).toBe('page')
    expect(rows.get('pageOnly')?.editable).toBe(true)
    expect(rows.get('fileOnly')?.source).toBe('file')
  })

  it('把条目 Config 段拍平成按名称排序的行', () => {
    const form = new FakeConfigForm(readySnapshot())
    const store = new McpServersStore(form)
    store.load()

    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.error).toBeNull()
    expect(state.rows).toEqual([
      {
        name: 'alpha',
        definition: ALPHA,
        enabled: true,
        transport: 'stdio',
        target: 'alpha-server --stdio',
        source: 'own',
        editable: true,
        overridden: true,
      },
      {
        name: 'beta',
        definition: BETA,
        enabled: false,
        transport: 'streamable-http',
        target: 'http://127.0.0.1:9/mcp',
        source: 'own',
        editable: true,
        overridden: false,
      },
    ])
  })

  it('把只读部署映射成不可写', () => {
    const store = new McpServersStore(new FakeConfigForm({ ...readySnapshot(), writable: false }))
    store.load()
    expect(store.store.getSnapshot().writable).toBe(false)
    expect(store.store.getSnapshot().rows).toHaveLength(2)
  })

  it('命名空间还在加载时保持 loading，且不报错', () => {
    const store = new McpServersStore(new FakeConfigForm({ status: 'loading', value: undefined }))
    store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'loading', rows: [], error: null })
  })

  it('命名空间不可用时清空清单并锁住写入', () => {
    const store = new McpServersStore(new FakeConfigForm({ status: 'unavailable', value: undefined }))
    store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'unavailable',
      rows: [],
      writable: false,
      error: null,
    })
  })
})

describe('McpServersStore.load / dispose', () => {
  it('load() 幂等，并跟随表单快照', async () => {
    const form = new FakeConfigForm({ value: { mcpServers: {} } })
    const store = new McpServersStore(form)
    store.load()
    store.load()
    expect(form.subscriberCount).toBe(1)

    await form.mutate([{ op: 'set', path: ['mcpServers', 'alpha'], value: ALPHA as never }])
    expect(store.store.getSnapshot().rows.map(row => row.name)).toEqual(['alpha'])
  })

  it('dispose() 之后不再跟随', async () => {
    const form = new FakeConfigForm({ value: { mcpServers: {} } })
    const store = new McpServersStore(form)
    store.load()
    store.dispose()
    expect(form.subscriberCount).toBe(0)

    await form.mutate([{ op: 'set', path: ['mcpServers', 'alpha'], value: ALPHA as never }])
    expect(store.store.getSnapshot().rows).toEqual([])
  })
})

describe('McpServersStore.save', () => {
  it('新服务写入 ["mcpServers", name]，并从回读快照重建清单', async () => {
    const form = new FakeConfigForm()
    const store = new McpServersStore(form)
    store.load()

    await store.save('alpha', ALPHA)

    expect(form.mutations).toEqual([
      [{ op: 'set', path: ['mcpServers', 'alpha'], value: ALPHA }],
    ])
    expect(store.store.getSnapshot()).toMatchObject({
      saving: false,
      error: null,
      rows: [{ name: 'alpha', enabled: true, transport: 'stdio' }],
    })
  })

  it('改名时先删旧键再写新键', async () => {
    const form = new FakeConfigForm(readySnapshot())
    const store = new McpServersStore(form)
    store.load()

    await store.save('gamma', { command: 'alpha-server', args: ['--stdio'] }, 'alpha')

    expect(form.mutations).toEqual([[
      { op: 'unset', path: ['mcpServers', 'alpha'] },
      { op: 'set', path: ['mcpServers', 'gamma'], value: { command: 'alpha-server', args: ['--stdio'] } },
    ]])
    expect(store.store.getSnapshot().rows.map(row => row.name)).toEqual(['beta', 'gamma'])
    expect(store.store.getSnapshot().error).toBeNull()
  })

  it('写入在途时标记 saving，结束后复位', async () => {
    const form = new FakeConfigForm()
    const store = new McpServersStore(form)
    store.load()

    const pending = store.save('alpha', ALPHA)
    expect(store.store.getSnapshot().saving).toBe(true)
    await pending
    expect(store.store.getSnapshot().saving).toBe(false)
  })

  it('Host 拒绝时展示 refused，清单里没有这次写入', async () => {
    const form = new FakeConfigForm()
    const store = new McpServersStore(form)
    store.load()
    form.accept = false

    await store.save('alpha', ALPHA)

    expect(store.store.getSnapshot()).toMatchObject({ error: 'refused', saving: false, rows: [] })
  })

  it('Host 补上默认字段不算拒绝', async () => {
    const form = new FakeConfigForm()
    // 真实 Host 会把省略的 args/env/enabled 规范化后写回；挂载语义没有变。
    form.normalize = definition => ({ enabled: true, args: [], env: {}, ...definition })
    const store = new McpServersStore(form)
    store.load()

    await store.save('alpha', { command: 'alpha-server' })

    expect(store.store.getSnapshot().error).toBeNull()
    expect(store.store.getSnapshot().rows[0]?.definition).toMatchObject({ args: [], env: {} })
  })

  it('传输失败会让 save() 抛出，但 saving 仍复位', async () => {
    const form = new FakeConfigForm()
    const store = new McpServersStore(form)
    store.load()
    form.failWith = new Error('wire down')

    await expect(store.save('alpha', ALPHA)).rejects.toThrow('wire down')
    expect(store.store.getSnapshot().saving).toBe(false)
  })
})

describe('McpServersStore.remove', () => {
  it('只提交对 ["mcpServers", name] 的 unset', async () => {
    const form = new FakeConfigForm(readySnapshot())
    const store = new McpServersStore(form)
    store.load()

    await store.remove('alpha')

    expect(form.mutations).toEqual([[{ op: 'unset', path: ['mcpServers', 'alpha'] }]])
    expect(store.store.getSnapshot().rows.map(row => row.name)).toEqual(['beta'])
    expect(store.store.getSnapshot().error).toBeNull()
  })

  it('Host 没有真的删除时展示 refused', async () => {
    const form = new FakeConfigForm(readySnapshot())
    const store = new McpServersStore(form)
    store.load()
    form.accept = false

    await store.remove('alpha')

    expect(store.store.getSnapshot()).toMatchObject({ error: 'refused', saving: false })
    expect(store.store.getSnapshot().rows.map(row => row.name)).toEqual(['alpha', 'beta'])
  })
})

describe('McpServersStore 错误状态', () => {
  it('下一次成功写入会清掉上一次的 refused', async () => {
    const form = new FakeConfigForm()
    const store = new McpServersStore(form)
    store.load()

    form.accept = false
    await store.save('alpha', ALPHA)
    expect(store.store.getSnapshot().error).toBe('refused')

    form.accept = true
    await store.save('alpha', ALPHA)
    expect(store.store.getSnapshot()).toMatchObject({ error: null, rows: [{ name: 'alpha' }] })
  })
})
