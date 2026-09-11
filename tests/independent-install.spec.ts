/**
 * 独立使用方覆盖：一个不位于本仓库内的部署，究竟能依赖什么。
 *
 * 这里钉住两个事实，都是针对构建出的 `lib/` 产物而言：
 *
 * 1. 用 file URL 指名本包的配置行，能在纯 Cordis 应用下激活——本包不携带任何自己的
 *    运行期依赖，因此 Node 半边要跑起来不需要再装别的东西。
 * 2. 发布出去的 manifest 是一份完整的 `dsh.client` 声明，因此把包装进自己解析闭包的
 *    部署，能从同一行里拿到被服务出来的浏览器半边。
 *
 * 包尚未构建时，本用例会跳过。
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOST_ENTRY = join(PACKAGE_ROOT, 'lib', 'index.js')
const built = existsSync(HOST_ENTRY)

let root: string | undefined
let context: Context | undefined

beforeEach(async () => {
  // 空的 harness home，确保插件读不到任何真实的 `mcp.json`。
  root = await mkdtemp(join(tmpdir(), 'dsh-mcp-servers-home-'))
  vi.stubEnv('DSH_HOME', root)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe.skipIf(!built)('从本仓库之外安装使用', () => {
  it('用 file URL 指名的配置行即可激活，无需安装其他任何东西', async () => {
    const configPath = join(root!, 'cordis.yml')
    await writeFile(configPath, [
      `- name: '${pathToFileURL(HOST_ENTRY).href}'`,
      '  config:',
      '    mcpServers:',
      '      off:',
      '        command: never-started',
      '        enabled: false',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root!).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const entries = [...context.loader.entries()]
    const plugin = entries.find(entry => entry.options.name === pathToFileURL(HOST_ENTRY).href)
    expect(plugin).toBeDefined()
    // ACTIVE（2）：该行已导入、配置已校验、并已 settle。
    expect(plugin?.fiber?.state).toBe(2)
    // 唯一配置的服务是停用的，因此没有挂出任何 bridge 行。
    expect(entries.map(entry => entry.options.name)).not.toContain('@deepseek-ai/dsh-mcp-client')
  })

  it('带有客户端模块扫描所需的浏览器半边', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      main?: string
      exports?: Record<string, unknown>
      dsh?: { client?: { platform?: string } }
    }
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(Object.keys(manifest.exports ?? {})).toContain('./client')
    expect(existsSync(join(PACKAGE_ROOT, 'lib', 'client.js'))).toBe(true)
  })

  it('不含任何需要使用者自行安装的运行期 import', () => {
    const bundle = readFileSync(HOST_ENTRY, 'utf8')
    const bareImports = [...bundle.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map(match => match[1])
    expect(bareImports).toEqual([])
  })
})
