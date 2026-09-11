// @vitest-environment jsdom
/** MCP 设置页面：各状态的渲染，以及添加、编辑、删除三条操作路径。 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

/** 一个就绪页面：一台启用的 stdio 服务，一台停用的 HTTP 服务。 */
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
      overridden: true,
    },
    {
      name: 'beta',
      definition: { url: 'http://127.0.0.1:9/mcp', enabled: false },
      enabled: false,
      transport: 'streamable-http',
      target: 'http://127.0.0.1:9/mcp',
      overridden: false,
    },
  ],
}

/** 本区块驱动的写入路径；把 spy 直接暴露出来，断言就不必再去碰方法引用。 */
interface FakeController {
  controller: McpServersStore
  save: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

/** 基于一份状态快照构造区块的 props 并渲染。 */
function renderSection(state: McpServersState): FakeController {
  const save = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const controller = {
    store: { getSnapshot: () => state },
    load: vi.fn(),
    save,
    remove,
    dispose: vi.fn(),
  } as unknown as McpServersStore
  const props = {
    close: () => undefined,
    controller,
    useServers: (selector: (value: McpServersState) => unknown) => selector(state),
    t,
  } as unknown as McpSectionProps
  render(<McpSection {...props} />)
  return { controller, save, remove }
}

describe('McpSection', () => {
  it('列出每个已配置服务的传输方式与目标', () => {
    renderSection(READY)
    expect(screen.getByText('alpha')).toBeDefined()
    expect(screen.getByText('alpha-server --stdio')).toBeDefined()
    expect(screen.getByText('beta')).toBeDefined()
    expect(screen.getByText('http://127.0.0.1:9/mcp')).toBeDefined()
    expect(screen.getByText(en.disabled)).toBeDefined()
  })

  it('命名空间不可用时给出提示，而不是显示空列表', () => {
    renderSection({ ...READY, status: 'unavailable', rows: [], writable: false })
    expect(screen.getByText(en.loadFailed)).toBeDefined()
    expect(screen.queryByText(en.empty)).toBeNull()
    expect(screen.queryByText(en.addServer)).toBeNull()
  })

  it('可写部署在没有服务时显示空态且不出现编辑器', () => {
    renderSection({ ...READY, rows: [] })
    expect(screen.getByText(en.empty)).toBeDefined()
    expect(screen.getByText(en.addServer)).toBeDefined()
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

  it('关闭编辑器时不写入', () => {
    const { save } = renderSection({ ...READY, rows: [] })
    fireEvent.click(screen.getByText(en.addServer))
    fireEvent.click(screen.getByText(en.cancel))
    expect(screen.queryByLabelText(en.name)).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })
})
