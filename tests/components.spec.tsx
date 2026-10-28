// @vitest-environment jsdom
/** MCP 设置页面：各状态的渲染，以及添加、编辑、删除三条操作路径。 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpSection } from '../src/client/McpSection.tsx'
import type { McpSectionProps } from '../src/client/McpSection.tsx'
import type { McpServersStore, McpServersState } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

// 运行期这些基础控件由外壳通过模块表共享；Node 测试渲染替身，而不是渲染已发布包的
// Node 半边——后者会去够一堆使用者本来不会安装的 markdown 相关依赖。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./support/primitives-stub.tsx'))

afterEach(cleanup)

/** 区块绑定的翻译函数，读的就是插件注册的那份字典。 */
const t = ((key: keyof typeof en): string => en[key]) as McpSectionProps['t']

/** 一个就绪页面：一台可编辑的 stdio 服务，一台停用的 HTTP 服务，一台部署插入的只读服务。 */
const READY: McpServersState = {
  status: 'ready',
  writable: true,
  error: null,
  saving: false,
  rows: [
    {
      name: 'alpha',
      definition: { command: 'alpha-server', args: ['--stdio'] },
      enabled: true,
      transport: 'stdio',
      target: 'alpha-server --stdio',
      source: 'own',
      editable: true,
      overridden: true,
    },
    {
      name: 'beta',
      definition: { url: 'http://127.0.0.1:9/mcp', enabled: false },
      enabled: false,
      transport: 'streamable-http',
      target: 'http://127.0.0.1:9/mcp',
      source: 'own',
      editable: true,
      overridden: false,
    },
    {
      name: 'from-profile',
      definition: { url: 'https://example.invalid/mcp' },
      enabled: true,
      transport: 'streamable-http',
      target: 'https://example.invalid/mcp',
      source: 'deployment',
      editable: false,
      overridden: false,
    },
  ],
}

/** 本区块驱动的写入路径；把 spy 直接暴露出来，断言就不必再去碰方法引用。 */
interface FakeController {
  controller: McpServersStore
  save: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  /** 渲染所用的状态源；测试可以在写入被"拒绝"时改它。 */
  servers: FakeServersStore
}

/** 区块读取状态用的可订阅替身，行为与外壳注入的 hooks 源一致。 */
class FakeServersStore {
  private state: McpServersState
  private readonly listeners = new Set<() => void>()

  constructor(initial: McpServersState) {
    this.state = initial
  }

  getSnapshot = (): McpServersState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 发布一份新状态；模拟写入之后 Host 回读的结果。 */
  set(patch: Partial<McpServersState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}

/** 基于一份状态快照构造区块的 props 并渲染。 */
function renderSection(state: McpServersState): FakeController {
  const servers = new FakeServersStore(state)
  const save = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const controller = {
    store: servers,
    load: vi.fn(),
    save,
    remove,
    dispose: vi.fn(),
  } as unknown as McpServersStore
  // useServers 是外壳合成的选择器 hook：替身里用真正的订阅实现，这样写入之后
  // 页面会像在生产环境里一样重新渲染。
  const useServers = ((selector: (value: McpServersState) => unknown) =>
    useSyncExternalStore(servers.subscribe, () => selector(servers.getSnapshot()))) as McpSectionProps['useServers']
  const props = {
    close: () => undefined,
    controller,
    useServers,
    t,
  } as unknown as McpSectionProps
  render(<McpSection {...props} />)
  return { controller, save, remove, servers }
}

describe('McpSection', () => {
  it('列出每个已配置服务的传输方式与目标', () => {
    renderSection(READY)
    expect(screen.getByText('alpha')).toBeDefined()
    expect(screen.getByText('alpha-server --stdio')).toBeDefined()
    expect(screen.getByText('beta')).toBeDefined()
    expect(screen.getByText('http://127.0.0.1:9/mcp')).toBeDefined()
    expect(screen.getByText(en.disabled)).toBeDefined()
    // 页面只覆盖 profile 层：就绪态下必须说明 mcp.json / 旧 servers 层不在这里列出。
    expect(screen.getByText(en.scopeHint)).toBeDefined()
  })

  it('命名空间不可用时给出提示，而不是显示空列表', () => {
    renderSection({ ...READY, status: 'unavailable', rows: [], writable: false })
    expect(screen.getByText(en.loadFailed)).toBeDefined()
    expect(screen.queryByText(en.empty)).toBeNull()
    expect(screen.queryByText(en.addServer)).toBeNull()
    // 页面根本不存在于该部署时，不能给出"本页只管 profile 层"的说明。
    expect(screen.queryByText(en.scopeHint)).toBeNull()
  })

  it('可写部署在没有服务时显示空态且不出现编辑器', () => {
    renderSection({ ...READY, rows: [] })
    expect(screen.getByText(en.empty)).toBeDefined()
    expect(screen.getByText(en.addServer)).toBeDefined()
    // 只有 mcp.json 服务的部署显示的就是这个空态，说明必须仍然在场。
    expect(screen.getByText(en.scopeHint)).toBeDefined()
    expect(screen.queryByLabelText(en.name)).toBeNull()
  })

  it('只读部署下锁住所有编辑入口', () => {
    renderSection({ ...READY, writable: false })
    expect(screen.getByText(en.readOnly)).toBeDefined()
    expect(screen.queryByText(en.addServer)).toBeNull()
    expect(screen.getAllByText(en.editServer)[0]).toHaveProperty('disabled', true)
    expect(screen.getAllByText(en.removeServer)[0]).toHaveProperty('disabled', true)
  })

  it('报出 Host 未接受的写入', () => {
    renderSection({ ...READY, error: 'refused' })
    expect(screen.getByText(en.refused)).toBeDefined()
  })

  it('从新增表单保存一台服务', async () => {
    const { save } = renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'gamma' } })
    fireEvent.change(screen.getByLabelText(en.command), { target: { value: 'gamma-server' } })
    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('gamma', {
        enabled: true,
        transport: 'stdio',
        command: 'gamma-server',
        args: [],
        env: {},
      }, undefined)
    })
  })

  it('用模板一键填好常见服务，用户只需确认或改细节', async () => {
    const { save } = renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.click(screen.getByText(en.templateMemory))

    expect((screen.getByLabelText(en.name) as HTMLInputElement).value).toBe('memory')
    expect((screen.getByLabelText(en.command) as HTMLInputElement).value).toBe('npx')
    expect((screen.getByLabelText(`${en.args} 1`) as HTMLInputElement).value).toBe('-y')
    expect((screen.getByLabelText(`${en.args} 2`) as HTMLInputElement).value)
      .toBe('@modelcontextprotocol/server-memory')

    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('memory', {
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        env: {},
      }, undefined)
    })
  })

  it('模板生成的名字避开已有服务', () => {
    renderSection({
      ...READY,
      rows: [
        ...READY.rows,
        {
          name: 'memory',
          definition: { command: 'x' },
          enabled: true,
          transport: 'stdio',
          target: 'x',
          source: 'own',
          editable: true,
          overridden: false,
        },
      ],
    })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.click(screen.getByText(en.templateMemory))
    expect((screen.getByLabelText(en.name) as HTMLInputElement).value).toBe('memory-2')
  })

  it('参数是逐行控件，可增可删，不再手写多行文本', async () => {
    const { save } = renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'args-test' } })
    fireEvent.change(screen.getByLabelText(en.command), { target: { value: 'node' } })

    fireEvent.click(screen.getByText(en.addArgument))
    fireEvent.change(screen.getByLabelText(`${en.args} 1`), { target: { value: '--first' } })
    fireEvent.click(screen.getByText(en.addArgument))
    fireEvent.change(screen.getByLabelText(`${en.args} 2`), { target: { value: '--second' } })
    fireEvent.click(screen.getByLabelText(`${en.removeArgument} 1`))

    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('args-test', expect.objectContaining({
        command: 'node',
        args: ['--second'],
      }), undefined)
    })
  })

  it('环境变量按行列填写，保存成映射', async () => {
    const { save } = renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'env-test' } })
    fireEvent.change(screen.getByLabelText(en.command), { target: { value: 'node' } })

    fireEvent.click(screen.getByText(en.addEnv))
    fireEvent.change(screen.getByLabelText(`${en.envName} 1`), { target: { value: 'API_TOKEN' } })
    fireEvent.change(screen.getByLabelText(`${en.envValue} 1`), { target: { value: 'secret' } })

    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('env-test', expect.objectContaining({
        env: { API_TOKEN: 'secret' },
      }), undefined)
    })
  })

  it('高级设置默认收起，按需展开才显示工作目录与超时', () => {
    renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    expect(screen.queryByLabelText(en.cwd)).toBeNull()
    expect(screen.queryByLabelText(en.toolCallTimeout)).toBeNull()

    fireEvent.click(screen.getByText(en.advanced))
    expect(screen.queryByLabelText(en.cwd)).not.toBeNull()
    expect(screen.queryByLabelText(en.toolCallTimeout)).not.toBeNull()
  })

  it('被接受的写入会关闭编辑器', async () => {
    const { save } = renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'gamma' } })
    fireEvent.change(screen.getByLabelText(en.command), { target: { value: 'gamma-server' } })
    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => { expect(save).toHaveBeenCalled() })
    await waitFor(() => { expect(screen.queryByLabelText(en.name)).toBeNull() })
  })

  it('Host 拒绝写入时保留编辑器与已输入内容', async () => {
    const { save, servers } = renderSection({ ...READY, rows: [] })
    save.mockImplementation(async () => { servers.set({ error: 'refused' }) })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'gamma' } })
    fireEvent.change(screen.getByLabelText(en.command), { target: { value: 'gamma-server' } })
    fireEvent.click(screen.getByText(en.save))

    await waitFor(() => { expect(screen.getByText(en.refused)).toBeDefined() })
    // 编辑器没有关闭，草稿还在，用户可以直接改。
    expect((screen.getByLabelText(en.name) as HTMLInputElement).value).toBe('gamma')
    expect(screen.queryByLabelText(en.command)).not.toBeNull()
  })

  it('Host 会拒绝的草稿不写入', () => {
    const { save } = renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.click(screen.getByText(en.save))
    expect(screen.getByText(en.problemName)).toBeDefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('重新打开某台服务，改名后以新键保存', async () => {
    const { save } = renderSection(READY)
    fireEvent.click(screen.getAllByText(en.editServer)[0]!)
    const name = screen.getByLabelText(en.name) as HTMLInputElement
    expect(name.value).toBe('alpha')
    fireEvent.change(name, { target: { value: 'alpha2' } })
    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('alpha2', expect.objectContaining({ command: 'alpha-server' }), 'alpha')
    })
  })

  it('切换到另一种传输方式，保存时丢弃过期字段', async () => {
    const { save } = renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.change(screen.getByLabelText(en.name), { target: { value: 'web' } })
    fireEvent.click(screen.getByText(en.transportStreamableHttp))
    expect(screen.queryByLabelText(en.command)).toBeNull()
    fireEvent.change(screen.getByLabelText(en.url), { target: { value: 'http://x/mcp' } })
    fireEvent.click(screen.getByText(en.save))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('web', {
        enabled: true,
        transport: 'streamable-http',
        url: 'http://x/mcp',
        headers: {},
      }, undefined)
    })
  })

  it('只有确认之后才删除服务', async () => {
    const { remove } = renderSection(READY)
    fireEvent.click(screen.getAllByText(en.removeServer)[0]!)
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByText(en.removeTitle)).toBeDefined()
    fireEvent.click(screen.getByText(en.removeConfirm))
    await waitFor(() => { expect(remove).toHaveBeenCalledWith('alpha') })
  })

  it('取消删除时不写入', () => {
    const { remove } = renderSection(READY)
    fireEvent.click(screen.getAllByText(en.removeServer)[0]!)
    fireEvent.click(screen.getByText(en.cancel))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.queryByText(en.removeTitle)).toBeNull()
  })

  it('把 profile 里已有的服务只读列出，不提供编辑与删除入口', () => {
    renderSection(READY)
    expect(screen.getByText('from-profile')).toBeDefined()
    expect(screen.getByText(en.sourceDeployment)).toBeDefined()
    // 只有两台可写服务各自有编辑/删除按钮；只读行没有。
    expect(screen.getAllByText(en.editServer)).toHaveLength(2)
    expect(screen.getAllByText(en.removeServer)).toHaveLength(2)
  })

  it('关闭编辑器时不写入', () => {
    const { save } = renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.click(screen.getByText(en.cancel))
    expect(screen.queryByLabelText(en.name)).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })
})
