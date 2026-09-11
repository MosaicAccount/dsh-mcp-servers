/**
 * harness home 的解析，行为对齐 `@deepseek-ai/dsh-home-paths`。
 *
 * 这里自己实现而不是 import，是为了让发布出去的插件不带任何运行期依赖——DSH 安装
 * 未必能从插件所在位置解析到它。优先级与 harness 自身一致：显式配置的路径，其次
 * `$DSH_HOME`，最后 `~/.dsh`。
 *
 * @module dsh-mcp-servers
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 用于覆盖默认 harness home 的环境变量。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 默认 harness home 在操作系统用户目录下的目录名。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/**
 * 解析生效的 harness home。
 * @param configured - 来自插件配置的显式路径，可能为空。
 * @returns 绝对的 harness home 路径。
 */
export function resolveDshHome(configured?: string): string {
  const configuredPath = configured ?? process.env[DSH_HOME_ENV] ?? ''
  return configuredPath.trim() === '' ? join(homedir(), DSH_HOME_DIR_NAME) : configuredPath
}
