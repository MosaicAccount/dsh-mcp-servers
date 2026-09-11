/** 单条 MCP 服务的暂存表单。 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Pill, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  definitionFrom,
  draftFrom,
  emptyDraft,
  validateDraft,
  type McpDraftProblem,
  type McpServerDefinition,
  type ServerDraft,
} from './servers.ts'
import type { McpKey } from './locales.ts'
import css from './McpSection.module.css'

/** 每种阻断性问题对应的文案键。 */
const PROBLEM_KEY: Record<McpDraftProblem, McpKey> = {
  name: 'problemName',
  command: 'problemCommand',
  url: 'problemUrl',
  timeout: 'problemTimeout',
  pairs: 'problemPairs',
}

/** 一行带标签的控件，附可选提示。 */
function Field({ label, hint, children }: {
  label: string
  hint: string | undefined
  children: ReactNode
}): ReactNode {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      {children}
      {hint === undefined ? null : <span className={css.hint}>{hint}</span>}
    </div>
  )
}

/** {@link ServerEditor} 的 props。 */
export interface ServerEditorProps {
  /** 编辑器打开时该条目的名称；新增服务时为 undefined。 */
  originalName: string | undefined
  /** 编辑器打开时的定义；新增服务时为 undefined。 */
  originalDefinition: McpServerDefinition | undefined
  /** 本地化文案。 */
  t: (key: McpKey) => string
  /** 该部署是否接受写入。 */
  disabled: boolean
  /** 保存一份草稿；写入被确认后由拥有者关闭编辑器。 */
  onSave: (name: string, definition: McpServerDefinition, previousName: string | undefined) => Promise<void>
  /** 不写入直接关闭编辑器。 */
  onCancel: () => void
}

/**
 * 暂存一条服务定义，并在保存时写入。草稿状态放在这里，因此写入失败或被拒绝时，
 * 已输入的内容会留在屏幕上供修改。
 * @param props - 正在编辑的条目、文案，以及写入路径。
 * @returns 编辑表单。
 */
export function ServerEditor(props: ServerEditorProps): ReactNode {
  const { originalName, originalDefinition, t, disabled, onSave, onCancel } = props
  const [draft, setDraft] = useState<ServerDraft>(() => originalDefinition === undefined
    ? emptyDraft()
    : draftFrom(originalName ?? '', originalDefinition))
  const [problem, setProblem] = useState<McpDraftProblem | null>(null)
  const [busy, setBusy] = useState(false)

  const edit = <Key extends keyof ServerDraft>(key: Key, value: ServerDraft[Key]): void => {
    setDraft(current => ({ ...current, [key]: value }))
    setProblem(null)
  }

  const submit = (): void => {
    const found = validateDraft(draft)
    if (found !== null) {
      setProblem(found)
      return
    }
    const definition = definitionFrom(draft)
    if (definition === undefined) {
      setProblem('timeout')
      return
    }
    setBusy(true)
    void onSave(draft.name, definition, originalName).finally(() => { setBusy(false) })
  }

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <span className={css.editorTitle}>
          {originalName === undefined ? t('addTitle') : t('editTitle')}
        </span>
      </div>

      <Field label={t('name')} hint={t('nameHint')}>
        <Input
          aria-label={t('name')}
          value={draft.name}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => { edit('name', event.target.value) }}
        />
      </Field>

      <div className={css.field}>
        <span className={css.fieldLabel}>{t('enabled')}</span>
        <Switch
          checked={draft.enabled}
          disabled={disabled}
          label={t('enabled')}
          onChange={(next) => { edit('enabled', next) }}
        />
        <span className={css.hint}>{t('enabledHint')}</span>
      </div>

      <div className={css.field}>
        <span className={css.fieldLabel}>{t('transport')}</span>
        <div className={css.transportRow} role="group" aria-label={t('transport')}>
          {(['stdio', 'streamable-http'] as const).map(option => (
            <Pill
              key={option}
              active={draft.transport === option}
              disabled={disabled}
              onClick={() => { edit('transport', option) }}
            >
              {option === 'stdio' ? t('transportStdio') : t('transportStreamableHttp')}
            </Pill>
          ))}
        </div>
      </div>

      {draft.transport === 'stdio'
        ? (
            <>
              <Field label={t('command')} hint={t('commandHint')}>
                <Input
                  aria-label={t('command')}
                  value={draft.command}
                  disabled={disabled}
                  spellCheck={false}
                  onChange={(event) => { edit('command', event.target.value) }}
                />
              </Field>
              <Field label={t('args')} hint={t('argsHint')}>
                <textarea
                  className={css.textarea}
                  aria-label={t('args')}
                  value={draft.args}
                  disabled={disabled}
                  spellCheck={false}
                  rows={3}
                  onChange={(event) => { edit('args', event.target.value) }}
                />
              </Field>
              <Field label={t('env')} hint={t('envHint')}>
                <textarea
                  className={css.textarea}
                  aria-label={t('env')}
                  value={draft.env}
                  disabled={disabled}
                  spellCheck={false}
                  rows={3}
                  onChange={(event) => { edit('env', event.target.value) }}
                />
              </Field>
              <Field label={t('cwd')} hint={t('cwdHint')}>
                <Input
                  aria-label={t('cwd')}
                  value={draft.cwd}
                  disabled={disabled}
                  spellCheck={false}
                  onChange={(event) => { edit('cwd', event.target.value) }}
                />
              </Field>
            </>
          )
        : (
            <>
              <Field label={t('url')} hint={t('urlHint')}>
                <Input
                  aria-label={t('url')}
                  value={draft.url}
                  disabled={disabled}
                  spellCheck={false}
                  onChange={(event) => { edit('url', event.target.value) }}
                />
              </Field>
              <Field label={t('headers')} hint={t('headersHint')}>
                <textarea
                  className={css.textarea}
                  aria-label={t('headers')}
                  value={draft.headers}
                  disabled={disabled}
                  spellCheck={false}
                  rows={3}
                  onChange={(event) => { edit('headers', event.target.value) }}
                />
              </Field>
            </>
          )}

      <Field label={t('toolCallTimeout')} hint={t('toolCallTimeoutHint')}>
        <Input
          aria-label={t('toolCallTimeout')}
          value={draft.toolCallTimeoutMs}
          disabled={disabled}
          inputMode="numeric"
          onChange={(event) => { edit('toolCallTimeoutMs', event.target.value) }}
        />
      </Field>

      {problem === null ? null : <p className={css.error} role="alert">{t(PROBLEM_KEY[problem])}</p>}

      <div className={css.editorActions}>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" disabled={disabled || busy} onClick={submit}>
          {busy ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  )
}
