/**
 * MCP 设置区块，浏览器半边。它注册一个 `settings.section` 页面，列出 Host 注册表已
 * 配置的外部 MCP 服务，并让用户添加、编辑、删除它们。所有读写都经由
 * `mcp-servers` 设置 scope，因此存了什么、实际挂载了什么，始终以 Host 为唯一权威。
 *
 * 命名空间字符串是与本包 Host 半边之间的连接键：没有挂载 `dsh-mcp-servers` 那一行
 * 的部署不会提供该命名空间，此时页面渲染的是"不可用"状态，而不是一个空列表。
 *
 * @module dsh-mcp-servers/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 纯类型导入：把外壳 SlotMap 里的 'settings.section' 条目合并进来。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 纯类型导入：把 locale 插件的 Context 合并（ctx.locale）带进来。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { McpSection } from './McpSection.tsx'
import type { McpSectionInjected } from './McpSection.tsx'
import { McpServersStore } from './store.ts'
import { MCP_SERVERS_NAMESPACE } from './servers.ts'
import { en, zh, type McpKey } from './locales.ts'

export type { McpSectionInjected, McpSectionProps } from './McpSection.tsx'
export type { ServerEditorProps } from './ServerEditor.tsx'
export type { McpKey } from './locales.ts'
export type { McpServerRow, McpServersState } from './store.ts'
export type { McpServerDefinition, McpServersSection, McpTransport, ServerDraft } from './servers.ts'
export { MCP_SERVERS_NAMESPACE, decodeMcpServersSection } from './servers.ts'
export { McpServersStore, mountSignature } from './store.ts'
export { McpSection } from './McpSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP 设置页面的文案。 */
    'settings.mcp': McpKey
  }
}

/** 本插件拥有的文案字典命名空间。 */
const NS = 'settings.mcp'

/**
 * 必需服务（cordis fiber inject）。目标 slot 由设置外壳声明，它与本插件的激活先后
 * 顺序并不受约束；注册通过 `slots.inject()` 依赖该 slot 本身。
 */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * 等 `settings.section` 声明出现在账本上之后，注册 MCP 区块。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: copy dictionaries')

  const controller = new McpServersStore(ctx.settingsScope.bind({ namespace: MCP_SERVERS_NAMESPACE }))
  // 注册期文案（导航标签 thunk）与注入面共用一个已绑定的翻译函数；文案的新鲜度跟随
  // locale 的修订号。
  const t = ctx.locale.bind(NS) as McpSectionInjected['t']
  const injected = (): McpSectionInjected => ({
    controller,
    hooks: { servers: controller.store },
    t,
  })

  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-mcp: server list controller')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, McpSection))
}
