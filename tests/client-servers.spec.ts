/** MCP 设置页面视角下的存储词汇：暂存、校验与投影。 */

import { describe, expect, it } from 'vitest'
import {
  decodeMcpServersSection,
  definitionFrom,
  draftFrom,
  emptyDraft,
  formatPairs,
  parsePairs,
  resolveTransport,
  serverTarget,
  validateDraft,
} from '../src/client/servers.ts'

describe('decodeMcpServersSection', () => {
  it('读出设置段，并把缺失的 servers 键当作空', () => {
    expect(decodeMcpServersSection({ servers: { a: { command: 'x' } } })).toEqual({ servers: { a: { command: 'x' } } })
    expect(decodeMcpServersSection({})).toEqual({ servers: {} })
  })

  it('拒绝读不出来的设置段', () => {
    expect(decodeMcpServersSection('nope')).toBeUndefined()
    expect(decodeMcpServersSection(['nope'])).toBeUndefined()
    expect(decodeMcpServersSection({ servers: [] })).toBeUndefined()
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

describe('parsePairs 与 formatPairs', () => {
  it('环境变量行可以往返转换', () => {
    expect(parsePairs('A=1\nB=2', '=')).toEqual({ A: '1', B: '2' })
    expect(formatPairs({ A: '1' }, '=')).toBe('A=1')
  })

  it('请求头行可以往返转换，且值里的冒号会被保留', () => {
    expect(parsePairs('Authorization: Bearer x', ':')).toEqual({ Authorization: 'Bearer x' })
    expect(formatPairs({ Authorization: 'Bearer x' }, ':')).toBe('Authorization: Bearer x')
  })

  it('报出没有可用分隔符的行，并忽略空行', () => {
    expect(parsePairs('NOPE', '=')).toBeUndefined()
    expect(parsePairs('=value', '=')).toBeUndefined()
    expect(parsePairs('\n A=1 \n', '=')).toEqual({ A: '1' })
    expect(parsePairs('', '=')).toEqual({})
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
    expect(draft).toMatchObject({ name: 'alpha', transport: 'stdio', command: 'run', args: '--x', env: 'A=1', cwd: '/tmp' })
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
    draft.headers = 'A: 1'
    expect(definitionFrom(draft)).toEqual({
      enabled: true,
      transport: 'streamable-http',
      url: 'http://x/mcp',
      headers: { A: '1' },
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

  it('报出格式错误的参数行或请求头行', () => {
    const draft = emptyDraft()
    draft.name = 'a'
    draft.command = 'x'
    draft.env = 'NOPE'
    expect(validateDraft(draft)).toBe('pairs')
    draft.env = ''
    draft.transport = 'streamable-http'
    draft.url = 'http://x/mcp'
    draft.headers = 'NOPE'
    expect(validateDraft(draft)).toBe('pairs')
  })
})
