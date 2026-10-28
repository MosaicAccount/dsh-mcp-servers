/** MCP 设置区块：已配置的服务列表及其编辑器。 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ServerEditor } from './ServerEditor.tsx'
import type { McpServersStore, McpServersState } from './store.ts'
import type { McpServerDefinition, McpServerSource } from './servers.ts'
import type { McpKey } from './locales.ts'
import css from './McpSection.module.css'

/** 只读行右上角的来源标签；可写层不显示。 */
const SOURCE_LABEL: Record<Exclude<McpServerSource, 'own'>, McpKey> = {
  deployment: 'sourceDeployment',
  file: 'sourceFile',
  legacy: 'sourceLegacy',
}

/** {@link McpSection} 在注册侧依赖的东西。 */
export interface McpSectionInjected {
  hooks: {
    /** 已配置的服务，以及最后一次写入的状态。 */
    servers: SnapshotStore<McpServersState>
  }
  /** 服务清单控制器。 */
  controller: McpServersStore
  /** 区块文案。 */
  t: (key: McpKey) => string
}

/** 设置外壳的 owner props，加上本区块的注入面。 */
export type McpSectionProps = PropsRuntime<'settings.section'> & InjectFace<McpSectionInjected>

/**
 * 渲染已配置的 MCP 服务，并让用户添加、编辑、删除它们。所有写入都发往 Host；
 * 本页面自身从不持有这份清单。
 * @param props - 设置外壳的 owner 状态与 MCP 依赖。
 * @returns MCP 设置页面。
 */
export function McpSection(props: McpSectionProps): ReactNode {
  const { controller, useServers, t } = props
  const state = useServers(snapshot => snapshot)
  // 用两个状态而不是一个哨兵值：服务名可以是任意字符串，因此单个"当前编辑哪个条目"
  // 的值没法再表示"正在新增"。
  const [editingName, setEditingName] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    if (state.status === 'loading') controller.load()
  }, [controller, state.status])

  const closeEditor = useCallback((): void => {
    setEditingName(null)
    setAdding(false)
  }, [])

  const save = useCallback(async (
    name: string,
    definition: McpServerDefinition,
    previousName: string | undefined,
  ): Promise<void> => {
    await controller.save(name, definition, previousName)
    // 写入被拒绝时保持编辑器打开、保留已输入的值，让用户就地修改，而不是从一个已经
    // 关闭的表单重新输入。
    if (controller.store.getSnapshot().error === null) closeEditor()
  }, [controller, closeEditor])

  const remove = useCallback(async (name: string): Promise<void> => {
    await controller.remove(name)
    setConfirming(null)
  }, [controller])

  return (
    <section className={css.section} aria-label={t('title')}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {state.status === 'ready' ? <p className={css.hint}>{t('scopeHint')}</p> : null}

      {state.status === 'unavailable' ? <p className={css.notice} role="alert">{t('loadFailed')}</p> : null}
      {state.status === 'ready' && !state.writable
        ? <p className={css.notice}>{t('readOnly')}</p>
        : null}
      {state.error === null ? null : <p className={css.error} role="alert">{t(state.error)}</p>}

      {state.status !== 'ready'
        ? null
        : state.rows.length === 0
        ? <p className={css.empty}>{t('empty')}</p>
        : (
            <ul className={css.rows}>
              {state.rows.map(row => (
                <li key={row.name} className={css.rowCard}>
                  <div className={css.rowHead}>
                    <span className={css.rowIdentity}>
                      <span className={css.rowName}>{row.name}</span>
                      <span className={css.rowTag}>
                        {row.transport === 'stdio' ? t('transportStdio') : t('transportStreamableHttp')}
                      </span>
                      {row.source === 'own' ? null : (
                        <span className={css.rowTag}>{t(SOURCE_LABEL[row.source])}</span>
                      )}
                      {row.enabled ? null : <span className={css.rowTag}>{t('disabled')}</span>}
                    </span>
                    {row.editable ? (
                      <span className={css.rowActions}>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!state.writable}
                          onClick={() => { setEditingName(row.name) }}
                        >
                          {t('editServer')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!state.writable}
                          onClick={() => { setConfirming(row.name) }}
                        >
                          {t('removeServer')}
                        </Button>
                      </span>
                    ) : null}
                  </div>
                  <span className={css.rowTarget}>{row.target}</span>

                  {!row.editable || confirming !== row.name ? null : (
                    <div className={css.confirm}>
                      <span className={css.confirmText}>{t('removeTitle')}</span>
                      <span className={css.hint}>{t('removeDescription')}</span>
                      <div className={css.editorActions}>
                        <Button variant="outline" size="sm" onClick={() => { setConfirming(null) }}>
                          {t('cancel')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className={css.dangerButton}
                          disabled={state.saving}
                          onClick={() => { void remove(row.name) }}
                        >
                          {t('removeConfirm')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {!row.editable || editingName !== row.name ? null : (
                    <ServerEditor
                      key={`edit:${row.name}`}
                      originalName={row.name}
                      originalDefinition={row.definition}
                      t={t}
                      disabled={!state.writable || state.saving}
                      onSave={save}
                      onCancel={closeEditor}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

      {state.status !== 'ready' || !state.writable ? null : (
        <div className={css.addBlock}>
          {adding ? null : (
            <Button variant="outline" className={css.addButton} onClick={() => { setAdding(true) }}>
              {t('addServer')}
            </Button>
          )}
          {!adding ? null : (
            <ServerEditor
              key="edit:new"
              originalName={undefined}
              originalDefinition={undefined}
              t={t}
              disabled={state.saving}
              onSave={save}
              onCancel={closeEditor}
            />
          )}
        </div>
      )}
    </section>
  )
}
