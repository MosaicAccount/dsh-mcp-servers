/**
 * 存储态 MCP 服务定义：传输方式推断、挂载前的逐条检查、单个挂载行收到的 bridge
 * 投影、作为基础层的 `mcp.json` 文档，以及 0.2.x 设置段（volatile `mcpServers`
 * 引用 + 遗留 `servers` 层）的读取。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, readServers } from '../src/index.ts'
import type { McpServerDefinition } from '../src/types.ts'
import {
  definitionFromBridgeConfig,
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

describe('definitionFromBridgeConfig', () => {
  it('把部署 stdio 行反投影成存储态定义', () => {
    expect(definitionFromBridgeConfig({
      transport: 'stdio',
      serverName: 'dbx',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: '1' },
      cwd: '/tmp',
      toolCallTimeoutMs: 5000,
      failOnStartupError: false,
    })).toEqual({
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: '1' },
      cwd: '/tmp',
      toolCallTimeoutMs: 5000,
    })
  })

  it('省略 transport 时按 command / url 推断，并忽略非字符串字段', () => {
    expect(definitionFromBridgeConfig({
      serverName: 'showdoc',
      url: 'https://www.showdoc.com.cn/mcp.php',
      headers: { Authorization: 'Bearer x', bad: 1 },
    })).toEqual({
      enabled: true,
      transport: 'streamable-http',
      url: 'https://www.showdoc.com.cn/mcp.php',
      headers: { Authorization: 'Bearer x' },
    })
  })

  // 部署行的 config 是手写组合数据：!!js 表达式在解析前是对象，不能让页面拿到半条定义。
  it('serverName 缺失/非法、或必需字段不是字符串时返回 undefined', () => {
    expect(definitionFromBridgeConfig(undefined)).toBeUndefined()
    expect(definitionFromBridgeConfig({ transport: 'stdio', command: 'x' })).toBeUndefined()
    expect(definitionFromBridgeConfig({ transport: 'stdio', serverName: 'bad name', command: 'x' })).toBeUndefined()
    expect(definitionFromBridgeConfig({ transport: 'stdio', serverName: 'a', command: { __jsExpr: 'cmd' } })).toBeUndefined()
    expect(definitionFromBridgeConfig({ transport: 'streamable-http', serverName: 'a' })).toBeUndefined()
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

  // 来自 JSON 的值不受类型系统约束；枚举外的传输方式必须在这里被拦下，否则它会走到
  // Loader 校验条目 Config 那一步被静默丢弃，表现为设置页面"保存了却没生效"。
  it('拦下枚举外的传输方式，并给出可操作的原因', () => {
    const result = partitionServers({
      sse: { transport: 'sse' as never, url: 'http://x/mcp' },
    })
    expect(result.servers).toEqual({})
    expect(result.problems).toEqual([
      'mcp-servers: server "sse" has unknown transport "sse"; use "stdio" or "streamable-http"',
    ])
  })
})

describe('readServers', () => {
  it('普通映射原样返回', () => {
    expect(readServers({ a: { command: 'x' } })).toEqual({ a: { command: 'x' } })
  })

  it('缺席的层贡献零个服务', () => {
    expect(readServers(undefined)).toEqual({})
  })

  // 0.2.x 的 volatile 字段在运行期是稳定引用：Loader 把新值就地写进同一个对象，
  // 因此每次读取都必须走 .get()，而不是缓存 apply() 时拿到的快照。
  it('volatile 引用读取当前快照，并跟随就地更新', () => {
    let current: Record<string, McpServerDefinition> = { a: { command: 'x' } }
    const layer = { get: () => current }
    expect(readServers(layer)).toEqual({ a: { command: 'x' } })

    current = { b: { command: 'y' } }
    expect(readServers(layer)).toEqual({ b: { command: 'y' } })
  })
})

describe('Config schema', () => {
  it('mcpServers 是带默认值的 volatile 引用：缺席时读到一个空映射', () => {
    const parsed = Config({})
    expect(parsed.mcpServers).toBeTypeOf('object')
    expect((parsed.mcpServers as { get?: unknown }).get).toBeTypeOf('function')
    expect(readServers(parsed.mcpServers)).toEqual({})
  })

  it('页面写入的条目被 schema 规范化后进入 volatile 层', () => {
    const parsed = Config({ mcpServers: { alpha: { command: 'alpha-server' } } })
    expect(readServers(parsed.mcpServers)).toMatchObject({
      alpha: { command: 'alpha-server', enabled: true },
    })
  })

  it('保留 0.1.x 遗留的 servers 层', () => {
    const parsed = Config({ servers: { legacy: { command: 'legacy-server' } } })
    expect(readServers(parsed.servers)).toMatchObject({
      legacy: { command: 'legacy-server' },
    })
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
