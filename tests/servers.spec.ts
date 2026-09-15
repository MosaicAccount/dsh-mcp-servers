/**
 * 存储态 MCP 服务定义：传输方式推断、写入被拒时依据的挂载检查、单个挂载行收到的
 * bridge 投影，以及作为基础层的 `mcp.json` 文档。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertServers,
  mergeServers,
  partitionServers,
  readConfigFile,
  resolveConfigPath,
  resolveTransport,
  toMcpClientConfig,
} from '../src/servers.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** 在一个全新的临时目录里写入一份 JSON 文档。 */
async function writeJson(contents: string): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-mcp-servers-'))
  const path = join(root, 'mcp.json')
  await writeFile(path, contents)
  return path
}

describe('resolveTransport', () => {
  it('显式声明的传输方式优先于字段推断', () => {
    expect(resolveTransport({ transport: 'streamable-http', command: 'x' })).toBe('streamable-http')
    expect(resolveTransport({ transport: 'stdio', url: 'http://x/mcp' })).toBe('stdio')
  })

  it('只有 url 而没有 command 时推断为 streamable-http', () => {
    expect(resolveTransport({ url: 'http://x/mcp' })).toBe('streamable-http')
  })

  it('有 command、url 为空、或两者都没有时回落到 stdio', () => {
    expect(resolveTransport({ command: 'x' })).toBe('stdio')
    expect(resolveTransport({ command: 'x', url: 'http://x/mcp' })).toBe('stdio')
    expect(resolveTransport({ url: '' })).toBe('stdio')
    expect(resolveTransport({})).toBe('stdio')
  })
})

describe('assertServers', () => {
  it('接受一条 stdio 条目和一条 streamable-http 条目', () => {
    expect(() => {
      assertServers({ a: { command: 'x' }, b: { url: 'http://x/mcp' } })
    }).not.toThrow()
  })

  it('拒绝不符合 bridge 名称空间语法的名称', () => {
    expect(() => { assertServers({ 'bad name': { command: 'x' } }) }).toThrow(/must match/)
    expect(() => { assertServers({ ['a'.repeat(33)]: { command: 'x' } }) }).toThrow(/must match/)
  })

  it('拒绝没有 command 的 stdio 条目', () => {
    expect(() => { assertServers({ a: {} }) }).toThrow(/requires a command/)
  })

  it('拒绝没有 url 的 streamable-http 条目', () => {
    expect(() => { assertServers({ a: { transport: 'streamable-http' } }) }).toThrow(/requires a url/)
  })
})

describe('toMcpClientConfig', () => {
  it('投影 stdio 条目，补齐 bridge 默认值且永不因启动失败而拒绝', () => {
    expect(toMcpClientConfig('alpha', { command: 'run', args: ['--x'], env: { A: '1' }, cwd: '/tmp' })).toEqual({
      transport: 'stdio',
      serverName: 'alpha',
      command: 'run',
      args: ['--x'],
      env: { A: '1' },
      cwd: '/tmp',
      failOnStartupError: false,
    })
  })

  it('投影 streamable-http 条目', () => {
    expect(toMcpClientConfig('web', { url: 'http://x/mcp', headers: { A: '1' } })).toEqual({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://x/mcp',
      headers: { A: '1' },
      failOnStartupError: false,
    })
  })

  it('带上显式的工具调用超时，缺省时则完全不带该字段', () => {
    expect(toMcpClientConfig('a', { command: 'x', toolCallTimeoutMs: 5 }).toolCallTimeoutMs).toBe(5)
    expect('toolCallTimeoutMs' in toMcpClientConfig('a', { command: 'x' })).toBe(false)
  })

  it('投影时复制参数与环境变量集合，不与调用方共享引用', () => {
    const args = ['--x']
    const env = { A: '1' }
    const projected = toMcpClientConfig('a', { command: 'x', args, env })
    if (projected.transport !== 'stdio') throw new Error('expected the stdio projection')
    expect(projected.args).not.toBe(args)
    expect(projected.env).not.toBe(env)
  })
})

describe('mergeServers', () => {
  it('同名时内联条目胜出', () => {
    expect(mergeServers(
      { shared: { command: 'inline' } },
      { shared: { command: 'file' }, other: { command: 'file' } },
    )).toEqual({ shared: { command: 'inline' }, other: { command: 'file' } })
  })

  it('组合里没声明任何服务时保留文件里的条目', () => {
    expect(mergeServers(undefined, { a: { command: 'x' } })).toEqual({ a: { command: 'x' } })
  })
})

describe('partitionServers', () => {
  it('把能挂载的条目挑出来，其余带上原因', () => {
    const result = partitionServers({
      good: { command: 'x' },
      'bad name': { command: 'x' },
      nocommand: {},
      nourl: { transport: 'streamable-http' },
    })
    expect(Object.keys(result.servers)).toEqual(['good'])
    expect(result.problems).toEqual([
      'mcp-servers: server name "bad name" must match /^[A-Za-z0-9_-]{1,32}$/',
      'mcp-servers: server "nocommand" uses stdio and requires a command',
      'mcp-servers: server "nourl" uses streamable-http and requires a url',
    ])
  })

  it('全部条目都可用时不产生任何问题', () => {
    expect(partitionServers({ a: { command: 'x' } })).toEqual({ servers: { a: { command: 'x' } }, problems: [] })
  })
})

describe('readConfigFile', () => {
  it('读出 mcpServers 映射', async () => {
    const path = await writeJson(JSON.stringify({ mcpServers: { a: { command: 'x' } } }))
    expect(readConfigFile(path)).toEqual({ servers: { a: { command: 'x' } }, problems: [] })
  })

  it('文件不存在时不贡献任何服务，也不算问题', () => {
    expect(readConfigFile(join(tmpdir(), 'dsh-mcp-servers-absent-dir', 'mcp.json')))
      .toEqual({ servers: {}, problems: [] })
  })

  it('文档里没有该键时不贡献任何服务', async () => {
    const path = await writeJson('{}')
    expect(readConfigFile(path)).toEqual({ servers: {}, problems: [] })
  })

  it('逐条过滤挂不起来的条目，并把原因带上文件路径', async () => {
    const path = await writeJson(JSON.stringify({ mcpServers: { good: { command: 'x' }, bad: {} } }))
    const result = readConfigFile(path)
    expect(Object.keys(result.servers)).toEqual(['good'])
    expect(result.problems).toEqual([`${path}: mcp-servers: server "bad" uses stdio and requires a command`])
  })

  // 这是 issue #2：一个漏掉的逗号曾让 apply() 拒绝、整个插件树加载失败、harness 起不来。
  it('JSON 损坏、文档不是对象、映射不是对象时都只报告问题，绝不抛错', async () => {
    const malformed = await writeJson('{"mcpServers":{"a":{"command":"x"} "b":{}}}')
    const list = await writeJson('[]')
    const wrongMap = await writeJson('{"mcpServers":[]}')

    const fromMalformed = readConfigFile(malformed)
    expect(fromMalformed.servers).toEqual({})
    expect(fromMalformed.problems).toHaveLength(1)
    expect(fromMalformed.problems[0]).toMatch(/is not valid JSON/)

    expect(readConfigFile(list)).toEqual({
      servers: {},
      problems: [`mcp-servers: ${list} must contain a JSON object`],
    })
    expect(readConfigFile(wrongMap)).toEqual({
      servers: {},
      problems: [`mcp-servers: ${wrongMap} must carry "mcpServers" as an object`],
    })
  })

  it('路径根本读不了时报告问题而不是抛错', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-mcp-servers-'))
    const result = readConfigFile(root)
    expect(result.servers).toEqual({})
    expect(result.problems[0]).toMatch(/cannot read/)
  })
})

describe('resolveConfigPath', () => {
  it('保留显式给出的路径', () => {
    expect(resolveConfigPath('/tmp/custom.json')).toBe('/tmp/custom.json')
  })

  it('默认落在 harness home 下的 mcp.json', () => {
    expect(resolveConfigPath(undefined).endsWith('mcp.json')).toBe(true)
    expect(resolveConfigPath('')).toContain('.dsh')
  })
})
