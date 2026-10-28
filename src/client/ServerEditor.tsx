/** 单条 MCP 服务的暂存表单：模板 + 分节引导，而不是让用户在一个框里写一大段配置。 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  SERVER_TEMPLATES,
  definitionFrom,
  draftFrom,
  draftFromTemplate,
  emptyDraft,
  validateDraft,
  type KeyValueRow,
  type McpDraftProblem,
  type McpServerDefinition,
  type ServerDraft,
  type ServerTemplate,
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

/** 模板键到文案的映射。 */
const TEMPLATE_LABEL: Record<ServerTemplate['id'], McpKey> = {
  memory: 'templateMemory',
  filesystem: 'templateFilesystem',
  remote: 'templateRemote',
  blank: 'templateBlank',
}

/** 一行带标签的控件，附可选提示与错误。 */
function Field({ label, hint, error, children }: {
  label: string
  hint: string | undefined
  error?: string | undefined
  children: ReactNode
}): ReactNode {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      {children}
      {error === undefined ? null : <span className={css.fieldError}>{error}</span>}
      {hint === undefined ? null : <span className={css.hint}>{hint}</span>}
    </div>
  )
}

/** 一个分节的标题，可带一行说明。 */
function StepTitle({ label, hint }: { label: string; hint?: string }): ReactNode {
  return (
    <div className={css.stepHead}>
      <span className={css.stepTitle}>{label}</span>
      {hint === undefined ? null : <span className={css.stepHint}>{hint}</span>}
    </div>
  )
}

/** {@link ServerEditor} 的 props。 */
export interface ServerEditorProps {
  /** 编辑器打开时该条目的名称；新增服务时为 undefined。 */
  originalName: string | undefined
  /** 编辑器打开时的定义；新增服务时为 undefined。 */
  originalDefinition: McpServerDefinition | undefined
  /** 当前已有的服务名，用来给模板生成不重复的名字。 */
  takenNames?: readonly string[]
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
 * 暂存一条服务定义，并在保存时写入。表单按"模板 → 连接方式 → 基本信息 → 参数/变量 →
 * 高级设置"分节，参数与键值对都是逐行控件，用户不需要手写多行文本。
 * @param props - 正在编辑的条目、文案，以及写入路径。
 * @returns 引导式编辑表单。
 */
export function ServerEditor(props: ServerEditorProps): ReactNode {
  const { originalName, originalDefinition, takenNames = [], t, disabled, onSave, onCancel } = props
  const [draft, setDraft] = useState<ServerDraft>(() => originalDefinition === undefined
    ? emptyDraft()
    : draftFrom(originalName ?? '', originalDefinition))
  const [problem, setProblem] = useState<McpDraftProblem | null>(null)
  const [busy, setBusy] = useState(false)
  // 新增时收起高级项；编辑已有配置且确实用了高级项时展开，避免藏起已有值。
  const [advanced, setAdvanced] = useState<boolean>(() => originalDefinition !== undefined
    && ((originalDefinition.cwd ?? '') !== '' || originalDefinition.toolCallTimeoutMs !== undefined))
  const adding = originalName === undefined

  const edit = <Key extends keyof ServerDraft>(key: Key, value: ServerDraft[Key]): void => {
    setDraft(current => ({ ...current, [key]: value }))
    setProblem(null)
  }

  const applyTemplate = (id: ServerTemplate['id']): void => {
    setDraft(draftFromTemplate(id, takenNames))
    setProblem(null)
  }

  const setArgument = (index: number, value: string): void => {
    edit('args', draft.args.map((argument, at) => at === index ? value : argument))
  }

  const removeArgument = (index: number): void => {
    edit('args', draft.args.filter((_, at) => at !== index))
  }

  const setPair = (layer: 'env' | 'headers', index: number, part: keyof KeyValueRow, value: string): void => {
    edit(layer, draft[layer].map((row, at) => at === index ? { ...row, [part]: value } : row))
  }

  const removePair = (layer: 'env' | 'headers', index: number): void => {
    edit(layer, draft[layer].filter((_, at) => at !== index))
  }

  const addPair = (layer: 'env' | 'headers'): void => {
    edit(layer, [...draft[layer], { key: '', value: '' }])
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

  /** 渲染一层的键值行编辑（环境变量或请求头）。 */
  const pairEditor = (
    layer: 'env' | 'headers',
    nameLabel: McpKey,
    valueLabel: McpKey,
    addLabel: McpKey,
    removeLabel: McpKey,
  ): ReactNode => (
    <>
      {draft[layer].length === 0 ? null : (
        <div className={css.pairRows}>
          {draft[layer].map((row, index) => (
            <div className={css.pairRow} key={`${layer}:${index}`}>
              <Input
                aria-label={`${t(nameLabel)} ${index + 1}`}
                className={css.pairKey ?? ''}
                value={row.key}
                disabled={disabled}
                spellCheck={false}
                placeholder={t(nameLabel)}
                onChange={(event) => { setPair(layer, index, 'key', event.target.value) }}
              />
              <Input
                aria-label={`${t(valueLabel)} ${index + 1}`}
                className={css.pairValue ?? ''}
                value={row.value}
                disabled={disabled}
                spellCheck={false}
                placeholder={t(valueLabel)}
                onChange={(event) => { setPair(layer, index, 'value', event.target.value) }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                aria-label={`${t(removeLabel)} ${index + 1}`}
                onClick={() => { removePair(layer, index) }}
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className={css.rowActionsStart}>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => { addPair(layer) }}>
          {t(addLabel)}
        </Button>
      </div>
    </>
  )

  const stdio = draft.transport === 'stdio'
  const showProblem = (key: McpDraftProblem): string | undefined =>
    problem === key ? t(PROBLEM_KEY[key]) : undefined

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <span className={css.editorTitle}>
          {adding ? t('addTitle') : t('editTitle')}
        </span>
      </div>

      {adding ? (
        <div className={css.templateBlock}>
          <StepTitle label={t('templateTitle')} hint={t('templateHint')} />
          <div className={css.templateChips}>
            {SERVER_TEMPLATES.map(template => (
              <Button
                key={template.id}
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => { applyTemplate(template.id) }}
              >
                {t(TEMPLATE_LABEL[template.id])}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <section className={css.step}>
        <StepTitle label={t('transport')} />
        <div className={css.transportCards} role="radiogroup" aria-label={t('transport')}>
          {(['stdio', 'streamable-http'] as const).map(option => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={draft.transport === option}
              aria-label={option === 'stdio' ? t('transportStdio') : t('transportStreamableHttp')}
              className={draft.transport === option ? css.transportCardActive : css.transportCard}
              disabled={disabled}
              onClick={() => { edit('transport', option) }}
            >
              <span className={css.transportCardTitle}>
                {option === 'stdio' ? t('transportStdio') : t('transportStreamableHttp')}
              </span>
              <span className={css.transportCardDesc}>
                {option === 'stdio' ? t('transportStdioDesc') : t('transportHttpDesc')}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className={css.step}>
        <StepTitle label={t('basics')} />
        <Field label={t('name')} hint={t('nameHint')} error={showProblem('name')}>
          <Input
            aria-label={t('name')}
            value={draft.name}
            disabled={disabled}
            spellCheck={false}
            placeholder={t('namePlaceholder')}
            onChange={(event) => { edit('name', event.target.value) }}
          />
        </Field>
        {stdio ? (
          <Field label={t('command')} hint={t('commandHint')} error={showProblem('command')}>
            <Input
              aria-label={t('command')}
              value={draft.command}
              disabled={disabled}
              spellCheck={false}
              placeholder={t('commandPlaceholder')}
              onChange={(event) => { edit('command', event.target.value) }}
            />
          </Field>
        ) : (
          <Field label={t('url')} hint={t('urlHint')} error={showProblem('url')}>
            <Input
              aria-label={t('url')}
              value={draft.url}
              disabled={disabled}
              spellCheck={false}
              placeholder={t('urlPlaceholder')}
              onChange={(event) => { edit('url', event.target.value) }}
            />
          </Field>
        )}
        <div className={css.switchRow}>
          <div className={css.switchCopy}>
            <span className={css.fieldLabel}>{t('enabled')}</span>
            <span className={css.hint}>{t('enabledHint')}</span>
          </div>
          <Switch
            checked={draft.enabled}
            disabled={disabled}
            label={t('enabled')}
            onChange={(next) => { edit('enabled', next) }}
          />
        </div>
      </section>

      {stdio ? (
        <>
          <section className={css.step}>
            <StepTitle label={t('args')} hint={t('argsHint')} />
            {draft.args.length === 0 ? null : (
              <div className={css.repeatRows}>
                {draft.args.map((argument, index) => (
                  <div className={css.repeatRow} key={`arg:${index}`}>
                    <Input
                      aria-label={`${t('args')} ${index + 1}`}
                      value={argument}
                      disabled={disabled}
                      spellCheck={false}
                      placeholder={t('argumentPlaceholder')}
                      onChange={(event) => { setArgument(index, event.target.value) }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      aria-label={`${t('removeArgument')} ${index + 1}`}
                      onClick={() => { removeArgument(index) }}
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className={css.rowActionsStart}>
              <Button variant="outline" size="sm" disabled={disabled} onClick={() => { edit('args', [...draft.args, '']) }}>
                {t('addArgument')}
              </Button>
            </div>
          </section>

          <section className={css.step}>
            <StepTitle label={t('env')} hint={draft.env.length === 0 ? t('envEmptyHint') : t('envHint')} />
            {pairEditor('env', 'envName', 'envValue', 'addEnv', 'removeEnv')}
            {problem === 'pairs' ? <span className={css.fieldError}>{t('problemPairs')}</span> : null}
          </section>
        </>
      ) : (
        <section className={css.step}>
          <StepTitle
            label={t('headers')}
            hint={draft.headers.length === 0 ? t('headersEmptyHint') : t('headersHint')}
          />
          {pairEditor('headers', 'headerName', 'headerValue', 'addHeader', 'removeHeader')}
          {problem === 'pairs' ? <span className={css.fieldError}>{t('problemPairs')}</span> : null}
        </section>
      )}

      <section className={css.step}>
        <button
          type="button"
          className={css.advancedToggle}
          aria-expanded={advanced}
          disabled={disabled}
          onClick={() => { setAdvanced(current => !current) }}
        >
          <span className={css.stepTitle}>{t('advanced')}</span>
          <svg
            className={advanced ? css.chevronOpen : css.chevron}
            viewBox="0 0 16 16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
        {advanced ? (
          <div className={css.advancedBody}>
            {stdio ? (
              <Field label={t('cwd')} hint={t('cwdHint')}>
                <Input
                  aria-label={t('cwd')}
                  value={draft.cwd}
                  disabled={disabled}
                  spellCheck={false}
                  onChange={(event) => { edit('cwd', event.target.value) }}
                />
              </Field>
            ) : null}
            <Field label={t('toolCallTimeout')} hint={t('toolCallTimeoutHint')} error={showProblem('timeout')}>
              <Input
                aria-label={t('toolCallTimeout')}
                value={draft.toolCallTimeoutMs}
                disabled={disabled}
                inputMode="numeric"
                onChange={(event) => { edit('toolCallTimeoutMs', event.target.value) }}
              />
            </Field>
            <span className={css.hint}>{t('advancedHint')}</span>
          </div>
        ) : null}
      </section>

      {/* 错误就近显示在字段下方；只有落在收起的高级设置里的超时错误需要在这里兜底。 */}
      {problem === 'timeout' && !advanced ? (
        <p className={css.error} role="alert">{t(PROBLEM_KEY.timeout)}</p>
      ) : null}

      <div className={css.editorActions}>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" disabled={disabled || busy} onClick={submit}>
          {busy ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  )
}
