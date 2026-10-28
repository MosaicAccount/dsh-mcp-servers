/**
 * 两半之间的静态契约。
 *
 * 浏览器半边用**固定字符串**作为 `configForms` 命名空间来读写本插件的配置段，
 * 而 Host 半边的命名空间是它在 profile 里的 **Loader 条目 id**。两者不是同一个机制，
 * 却必须字面相等：一旦 `cordis.patch.yml`（或示例 overlay）改了条目 id，设置页面就会
 * 静默变成"当前部署无法提供 MCP 服务列表"。
 *
 * 这个用例把这条隐式契约变成显式断言，改 id 的人会在 CI 里立刻看到它。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MCP_SERVERS_NAMESPACE } from '../src/client/servers.ts'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_NAME = 'dsh-mcp-servers'

/** 从本包自己的 YAML 里取出 insert 行的 id 与 name。 */
function readInsertedRow(path: string): { id: string; name: string } {
  const text = readFileSync(path, 'utf8')
  const id = /^\s*-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1]
  const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1]
  if (id === undefined || name === undefined) throw new Error(`${path} carries no insert row with an id and a name`)
  return { id, name }
}

describe('bundle patch 与浏览器半边的命名空间', () => {
  it('cordis.patch.yml 的条目 id 就是设置页面读写的命名空间', () => {
    const row = readInsertedRow(join(PACKAGE_ROOT, 'cordis.patch.yml'))
    expect(row.id).toBe(MCP_SERVERS_NAMESPACE)
    expect(row.name).toBe(PACKAGE_NAME)
  })

  it('示例 overlay 使用同一个条目 id', () => {
    const row = readInsertedRow(join(PACKAGE_ROOT, 'examples', 'mcp-servers.patch.yml'))
    expect(row.id).toBe(MCP_SERVERS_NAMESPACE)
  })
})
