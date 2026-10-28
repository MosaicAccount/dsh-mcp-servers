/** MCP 设置页面视角下的存储词汇：暂存、校验与投影。 */

import { describe, expect, it } from 'vitest'
import {
  SERVER_TEMPLATES,
  collectPairs,
  decodeMcpServersConfig,
  definitionFrom,
  draftFrom,
  draftFromTemplate,
  emptyDraft,
  resolveTransport,
  serverTarget,
  validateDraft,
} from '../src/client/servers.ts'

describe('decodeMcpServersConfig', () => {
  it('读出条目 Config 段的 mcpServers 层，并把缺失的键当作空', () => {
    expect(decodeMcpServersConfig({ mcpServers: { a: { command: 'x' } } }))
      .toEqual({ mcpServers: { a: { command: 'x' } } })
    expect(decodeMcpServersConfig({})).toEqual({ mcpServers: {} })
    // 条目 Config 还带着 path 与旧 servers 层；页面只认 mcpServers。
    expect(decodeMcpServersConfig({ path: 'mcp.json', servers: { legacy: { command: 'x' } } }))
      .toEqual({ mcpServers: {} })
  })

  it('拒绝读不出来的条目 Config 段', () => {
    expect(decodeMcpServersConfig('nope')).toBeUndefined()
    expect(decodeMcpServersConfig(['nope'])).toBeUndefined()
    expect(decodeMcpServersConfig({ mcpServers: [] })).toBeUndefined()
  })
})

describe('resolveTransport 与 serverTarget', () => {
  it('推断出与 Host 一致的传输方式', () => {
    expect(resolveTransport({ url: 'http://x/mcp' })).toBe('streamable-http')
    expect(resolveTransport({ command: 'x' })).toBe('stdio')
  })

  it('把命令行或端点整理成一行摘要', () => {
    expect(serverTarget({ command: 'npx', args: ['-y', 'pkg'] })).toBe('npx -y pkg')
    expect(serverTarget({ url: 'http://x/mcp' })).toBe('http://x/mcp')
    expect(serverTarget({ command: '', args: [''] })).toBe('')
  })
})

describe('collectPairs', () => {
  it('把逐行填写的键值收成映射，忽略两列都空的行', () => {
    expect(collectPairs([
      { key: 'A', value: '1' },
      { key: ' ', value: ' ' },
      { key: 'B', value: '2' },
    ])).toEqual({ A: '1', B: '2' })
    expect(collectPairs([])).toEqual({})
  })

  it('缺名或重名时拒绝', () => {
    expect(collectPairs([{ key: '', value: 'orphan' }])).toBeUndefined()
    expect(collectPairs([{ key: 'A', value: '1' }, { key: 'A', value: '2' }])).toBeUndefined()
  })

  it('值里的冒号、等号与空格原样保留', () => {
    expect(collectPairs([{ key: 'Authorization', value: 'Bearer a:b=c' }]))
      .toEqual({ Authorization: 'Bearer a:b=c' })
  })
})

describe('模板', () => {
  it('除空白模板外，每个模板都给出一个能直接保存的起手配置', () => {
    for (const template of SERVER_TEMPLATES.filter(template => template.id !== 'blank')) {
      const draft = draftFromTemplate(template.id)
      expect(validateDraft(draft)).toBeNull()
      expect(definitionFrom(draft)).toBeDefined()
    }
    // 空白模板就是一张空表单：它有意不通过校验，等用户自己填写。
    expect(validateDraft(draftFromTemplate('blank'))).toBe('name')
  })

  it('模板名字避开已有服务', () => {
    expect(draftFromTemplate('memory').name).toBe('memory')
    expect(draftFromTemplate('memory', ['memory']).name).toBe('memory-2')
    expect(draftFromTemplate('memory', ['memory', 'memory-2']).name).toBe('memory-3')
  })

  it('远程 HTTP 模板直接给出端点和传输方式', () => {
    const draft = draftFromTemplate('remote')
    expect(draft.transport).toBe('streamable-http')
    expect(draft.url).toBe('http://localhost:3000/mcp')
  })

  it('空白模板不带任何预置内容', () => {
    expect(draftFromTemplate('blank')).toEqual(emptyDraft())
  })
})

describe('draftFrom 与 definitionFrom', () => {
  it('暂存 stdio 定义并能原样投影回去', () => {
    const draft = draftFrom('alpha', {
      command: 'run',
      args: ['--x'],
      env: { A: '1' },
      cwd: '/tmp',
      toolCallTimeoutMs: 5,
    })
    expect(draft).toMatchObject({
      name: 'alpha',
      transport: 'stdio',
      command: 'run',
      args: ['--x'],
      env: [{ key: 'A', value: '1' }],
      cwd: '/tmp',
    })
    expect(definitionFrom(draft)).toEqual({
      enabled: true,
      transport: 'stdio',
      command: 'run',
      args: ['--x'],
      env: { A: '1' },
      cwd: '/tmp',
      toolCallTimeoutMs: 5,
    })
  })

  it('工作目录为空、超时缺省时都不写入这些字段', () => {
    expect(definitionFrom(draftFrom('a', { command: 'x' }))).toEqual({
      enabled: true,
      transport: 'stdio',
      command: 'x',
      args: [],
      env: {},
    })
  })

  it('投影 streamable-http 草稿时不带上 stdio 字段', () => {
    const draft = emptyDraft()
    draft.name = 'web'
    draft.transport = 'streamable-http'
    draft.url = 'http://x/mcp'
    draft.headers = [{ key: 'A', value: '1' }]
    expect(definitionFrom(draft)).toEqual({
      enabled: true,
      transport: 'streamable-http',
      url: 'http://x/mcp',
      headers: { A: '1' },
    })
  })

  it('参数与键值行里的空项不会进入定义', () => {
    const draft = emptyDraft()
    draft.name = 'a'
    draft.command = 'x'
    draft.args = ['--x', ' ', '']
    draft.env = [{ key: '', value: '' }]
    expect(definitionFrom(draft)).toEqual({
      enabled: true,
      transport: 'stdio',
      command: 'x',
      args: ['--x'],
      env: {},
    })
  })

  it('超时不可用时拒绝投影', () => {
    const draft = emptyDraft()
    draft.name = 'a'
    draft.command = 'x'
    draft.toolCallTimeoutMs = '0'
    expect(definitionFrom(draft)).toBeUndefined()
    draft.toolCallTimeoutMs = 'nope'
    expect(definitionFrom(draft)).toBeUndefined()
  })

  it('停用状态会被带进草稿', () => {
    expect(draftFrom('a', { command: 'x', enabled: false }).enabled).toBe(false)
  })
})

describe('validateDraft', () => {
  it('拒绝不符合名称空间语法的名称', () => {
    const draft = emptyDraft()
    draft.command = 'x'
    expect(validateDraft(draft)).toBe('name')
    draft.name = 'a'.repeat(33)
    expect(validateDraft(draft)).toBe('name')
  })

  it('要求所选传输方式必需的字段', () => {
    const draft = emptyDraft()
    draft.name = 'a'
    expect(validateDraft(draft)).toBe('command')
    draft.transport = 'streamable-http'
    expect(validateDraft(draft)).toBe('url')
    draft.url = 'http://x/mcp'
    expect(validateDraft(draft)).toBeNull()
  })

  it('报出缺名或重名的环境变量/请求头行', () => {
    const draft = emptyDraft()
    draft.name = 'a'
    draft.command = 'x'
    draft.env = [{ key: '', value: 'orphan' }]
    expect(validateDraft(draft)).toBe('pairs')
    draft.env = [{ key: 'A', value: '1' }, { key: 'A', value: '2' }]
    expect(validateDraft(draft)).toBe('pairs')
    draft.env = []
    draft.transport = 'streamable-http'
    draft.url = 'http://x/mcp'
    draft.headers = [{ key: '', value: 'orphan' }]
    expect(validateDraft(draft)).toBe('pairs')
  })

  it('两列都空的键值行不阻止保存', () => {
    const draft = emptyDraft()
    draft.name = 'a'
    draft.command = 'x'
    draft.env = [{ key: '', value: '' }]
    expect(validateDraft(draft)).toBeNull()
  })
})
