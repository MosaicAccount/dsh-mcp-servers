/**
 * bundle 组合覆盖：部署方导入本包所走的那条 profile 机制，全程无需手改任何组合文件。
 *
 * `dsh plugin --profile <name> add <spec>` 会把包装进 profile 目录，并在安装后的
 * manifest 声明了 `dsh.bundle.patch` 时把它追加进 `dsh.profile.bundles`。随后 harness
 * 会为每个 bundle 组合出一层补丁。本用例用真实的 profile loader 处理一个列出了本包的
 * profile，并断言它产出的那一层里，正是挂载本插件所需的那一行。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_NAME = 'dsh-mcp-servers'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('作为 profile bundle 被组合', () => {
  it('从包自带的补丁里产出注册表那一行', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-mcp-profile-'))
    const profileDir = join(root, 'profiles', 'web')
    await mkdir(join(profileDir, 'node_modules'), { recursive: true })
    // 这正是 `dsh plugin add` 留下的状态：包装在 profile manifest 旁边，并被列入它
    // 的 bundle 栈。
    await symlink(PACKAGE_ROOT, join(profileDir, 'node_modules', PACKAGE_NAME), 'dir')
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { [PACKAGE_NAME]: 'file:../../../dsh-mcp-servers' },
      dsh: { profile: { bundles: [PACKAGE_NAME] } },
    }))

    const profile = loadProfileDirectory(
      'dsh',
      profileDir,
      join(PACKAGE_ROOT, 'package.json'),
      { userLayer: false },
    )

    expect(profile.layers).toHaveLength(1)
    const [layer] = profile.layers
    expect(layer?.packageName).toBe(PACKAGE_NAME)
    // 解析走的是 profile 的 node_modules，因此断言 manifest 声明的那个文件，而不是
    // 符号链接自己那一份路径拼写。
    expect(layer?.patchPath).toBe(join(profileDir, 'node_modules', PACKAGE_NAME, 'cordis.patch.yml'))
    expect(layer?.patches).toEqual([
      { insert: [{ id: 'mcp-servers', name: PACKAGE_NAME }] },
    ])
  })
})
