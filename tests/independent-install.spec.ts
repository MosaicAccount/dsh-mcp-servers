/**
 * 独立使用方覆盖：一个不位于本仓库内的部署，究竟能依赖什么。
 *
 * 这里钉住两个事实，都是针对构建出的 `lib/` 产物而言：
 *
 * 1. 用 file URL 指名本包的配置行，能在纯 Cordis 应用下激活——本包不携带任何自己的
 *    运行期依赖，因此 Node 半边要跑起来不需要再装别的东西。
 * 2. 发布出去的 manifest 是一份完整的 `dsh.client` 声明 + 明确的 DSH 版本范围，
 *    因此把包装进自己解析闭包的部署，能从同一行里拿到被服务出来的浏览器半边。
 *
 * 包尚未构建时，前一组用例会跳过。
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

/**
 * 本插件声明支持的 DSH 版本范围。
 *
 * 这是一个**字面契约**，不是可以随手放大的写法：范围的两端都必须是我们真的验证过的
 * 版本。下限 0.2.1-rc.3 是官方 Desktop/Web 当前安装的运行时；上限 0.3.0 之前的下一个
 * 破坏性大版本。0.1.x 的 `settings.installSection` 模型已经被 DSH 移除，本插件不再
 * 兼容那一代。
 */
const DSH_RANGE = '>=0.2.1-rc.3 <0.3.0'

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

  it('不含任何需要使用者自行安装的运行期 import', () => {
    const bundle = readFileSync(HOST_ENTRY, 'utf8')
    const bareImports = [...bundle.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map(match => match[1])
    expect(bareImports).toEqual([])
  })
})

describe('发布出去的 manifest 契约', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    main?: string
    exports?: Record<string, unknown>
    engines?: { dsh?: string }
    peerDependencies?: Record<string, string>
    dsh?: {
      bundle?: { patch?: string | string[] }
      client?: { platform?: string; inject?: string[] }
    }
  }

  it('声明了官方 Web 与官方 Desktop 共用的浏览器半边', () => {
    // Desktop 只是把同一套 Web 外壳装进 Electron，因此客户端平台标识仍然是 `web`；
    // 两个官方 profile 都由这个声明服务。
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(Object.keys(manifest.exports ?? {})).toContain('./client')
  })

  it('客户端半边声明了对设置域与 locale 的依赖', () => {
    expect(manifest.dsh?.client?.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
    ]))
  })

  it('声明了 bundle patch，因此两个官方 profile 装上即生效', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('用 engines.dsh 明确支持的 DSH 版本范围', () => {
    expect(manifest.engines?.dsh).toBe(DSH_RANGE)
    // 范围里的版本号必须是具体版本，而不是 `*` 或空串：一个空范围会让
    // evaluatePluginCompatibility 把插件判成不兼容。
    expect(DSH_RANGE).toMatch(/^>=0\.2\.1-rc\.\d+ </)
  })

  it('bridge 包仍然以 peer 形式声明，并按同一代版本取值', () => {
    // engines.dsh 一旦存在就单独决定兼容性；bridge 的 peer 只是给静态工具和
    // pnpm 的解析用的，因此两端必须与 engines.dsh 保持一致。
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-mcp-client']).toBe(DSH_RANGE)
  })
})
