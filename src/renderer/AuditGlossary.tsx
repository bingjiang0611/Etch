import { useEffect, useRef, useState } from 'react'
import type { GlossaryApplyResult, GlossaryImpactPreview, TaskReviewPage } from '../shared/ipc'
import { glossaryImpactCounts } from './glossary-impact'

const AUTO_SAVE_DELAY_MS = 600
const GLOSSARY_DRAFT_KEY_PREFIX = 'etch:glossary-draft:'
const MANUAL_GLOSSARY_DRAFT_KEY_PREFIX = 'etch:manual-review-glossary-draft:'
const MAX_INLINE_CUE_REFS = 10
type GlossaryEntry = TaskReviewPage['glossary'][number]
export type GlossaryEdit = {
  index: number
  expectedSource: string
  expectedTarget: string
  source: string
  target: string
}

interface AuditGlossaryProps {
  page: TaskReviewPage | undefined
  loading?: boolean
  error?: string
  expectedState?: 'not-audited' | 'empty' | 'ready' | 'invalid'
  onSave?: (taskId: string, expectedRevision: number, edits: GlossaryEdit[]) => Promise<number>
  onBusyChange?: (busy: boolean) => void
  manualReview?: boolean
  onPreviewImpact?: (taskId: string, expectedRevision: number, edits: GlossaryEdit[]) => Promise<GlossaryImpactPreview>
  onApplyToCues?: (taskId: string, expectedRevision: number, impactFingerprint: string, edits: GlossaryEdit[]) => Promise<GlossaryApplyResult>
  onApplied?: (result?: GlossaryApplyResult) => void
}

function cloneGlossary(glossary: readonly GlossaryEntry[]): GlossaryEntry[] {
  return glossary.map((entry) => ({ ...entry, cueIds: [...entry.cueIds] }))
}

function sameEditableValues(left: readonly GlossaryEntry[], right: readonly GlossaryEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry.source === right[index]?.source && entry.target === right[index]?.target)
}

function isGlossaryConflictMessage(message: string): boolean {
  return message.includes('当前草稿已保留') || message.includes('术语表已被更新') || message.includes('请刷新后重试')
}

function keepOriginalSuggestion(source: string): string {
  return source.split(/\s*(?:\/|／|\|)\s*/u).map((value) => value.trim()).find(Boolean) ?? ''
}

function uniqueCueIds(cueIds: readonly number[]): number[] {
  return [...new Set(cueIds)].sort((left, right) => left - right)
}

function CueReferences({ cueIds, prefix = '' }: { cueIds: readonly number[]; prefix?: string }): React.JSX.Element {
  const unique = uniqueCueIds(cueIds)
  const visible = unique.slice(0, MAX_INLINE_CUE_REFS)
  return (
    <span className="glossary-cue-refs" aria-label={`${prefix ? `${prefix}：` : ''}${unique.map((cueId) => `#${cueId}`).join(' ')}`}>
      {prefix && <span className="glossary-cue-prefix">{prefix}</span>}
      {visible.map((cueId) => <span className="glossary-cue-ref" key={cueId}>#{cueId}</span>)}
      {unique.length > visible.length && <span className="glossary-cue-more">+{unique.length - visible.length}</span>}
    </span>
  )
}

function editsFrom(values: readonly GlossaryEntry[], baseline: readonly GlossaryEntry[], normalize = true): GlossaryEdit[] {
  return values.flatMap((entry, index) => {
    const saved = baseline[index]
    if (!saved || (entry.source === saved.source && entry.target === saved.target)) return []
    return [{
      index,
      expectedSource: saved.source,
      expectedTarget: saved.target,
      source: normalize ? entry.source.trim() : entry.source,
      target: normalize ? entry.target.trim() : entry.target
    }]
  })
}

function glossaryDraftKey(taskId: string, manualReview: boolean): string {
  return `${manualReview ? MANUAL_GLOSSARY_DRAFT_KEY_PREFIX : GLOSSARY_DRAFT_KEY_PREFIX}${taskId}`
}

function persistDraft(taskId: string | undefined, values: readonly GlossaryEntry[], baseline: readonly GlossaryEntry[], conflict = false, manualReview = false): void {
  if (!taskId) return
  const key = glossaryDraftKey(taskId, manualReview)
  const edits = editsFrom(values, baseline, false)
  try {
    if (edits.length) window.localStorage.setItem(key, JSON.stringify({ edits, conflict }))
    else window.localStorage.removeItem(key)
  } catch {
    // The in-memory draft remains authoritative for the current session.
  }
}

function restoreDraft(page: TaskReviewPage, manualReview: boolean): { values: GlossaryEntry[]; dirty: boolean; conflict: boolean } {
  const baseline = cloneGlossary(page.glossary)
  const key = glossaryDraftKey(page.taskId, manualReview)
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as { edits?: unknown; conflict?: unknown } | null
    if (!parsed || !Array.isArray(parsed.edits)) return { values: baseline, dirty: false, conflict: false }
    const edits = parsed.edits as Partial<GlossaryEdit>[]
    const valid = edits.every((edit) =>
      Number.isInteger(edit.index)
      && typeof edit.expectedSource === 'string'
      && typeof edit.expectedTarget === 'string'
      && typeof edit.source === 'string'
      && typeof edit.target === 'string'
      && Boolean(baseline[edit.index!]))
    if (!valid) {
      window.localStorage.removeItem(key)
      return { values: baseline, dirty: false, conflict: false }
    }
    const baselineMatches = edits.every((edit) =>
      baseline[edit.index!]?.source === edit.expectedSource
      && baseline[edit.index!]?.target === edit.expectedTarget)
    const values = baseline.map((entry, index) => {
      const edit = edits.find((candidate) => candidate.index === index)
      return edit ? { ...entry, source: edit.source!, target: edit.target! } : entry
    })
    const dirty = !sameEditableValues(values, baseline)
    if (!dirty) window.localStorage.removeItem(key)
    return { values, dirty, conflict: dirty && (parsed.conflict === true || !baselineMatches) }
  } catch {
    try {
      window.localStorage.removeItem(key)
    } catch {
      // Ignore unavailable renderer storage.
    }
    return { values: baseline, dirty: false, conflict: false }
  }
}

function ImpactDetails({ preview, applied = false }: { preview: GlossaryImpactPreview; applied?: boolean }): React.JSX.Element {
  const counts = glossaryImpactCounts(preview)
  const referencedCueIds = preview.finalCues.map((cue) => cue.cueId)
  const changedCueIds = preview.finalCues.filter((cue) => cue.before !== cue.after).map((cue) => cue.cueId)
  const unmatchedCueIds = new Set(preview.impacts.flatMap((impact) =>
    impact.cues.filter((cue) => cue.reason === 'target-not-found').map((cue) => cue.cueId)))
  return (
    <section className={`glossary-impact ${applied ? 'is-applied' : ''}`} aria-label={applied ? '术语同步结果' : '术语同步预览'}>
      <header className="glossary-impact-heading">
        <div>
          <strong>{counts.changed ? (applied ? `已写入 ${counts.changed} 条译文` : `将写入 ${counts.changed} 条译文`) : (applied ? '统一写法已保存，译文未改写' : '预览完成，现有译文无需改写')}</strong>
          <small>{counts.unmatched ? `${counts.unmatched} 条引用 cue 含未命中术语，未命中片段保持不变` : '所有引用 cue 均匹配旧写法'}</small>
          <CueReferences cueIds={changedCueIds.length ? changedCueIds : referencedCueIds} prefix={changedCueIds.length ? (applied ? '已修改' : '将修改') : '已核对'} />
        </div>
      </header>
      <div className="glossary-impact-final">
        <div className="glossary-impact-final-heading">
          <strong>{applied ? '最终已写入' : '最终将写入'}</strong>
          <small>按 cue 合并后的唯一结果</small>
        </div>
        {preview.finalCues.map((cue) => {
          const changed = cue.before !== cue.after
          const unmatched = unmatchedCueIds.has(cue.cueId)
          return (
            <div className={`glossary-impact-cue is-final ${changed ? 'is-changed' : ''}`} key={`final-${cue.cueId}`}>
              <span className="mono">#{cue.cueId}</span>
              <div><small>修改前</small><p>{cue.before}</p></div>
              <div><small>{applied ? '最终已写入' : '最终将写入'}</small><p>{cue.after}</p></div>
              <small className={unmatched ? 'is-warning' : ''}>
                {unmatched ? '含未命中术语，未命中片段保持不变' : changed ? '已合并全部命中修改' : '无需改写'}
              </small>
            </div>
          )
        })}
      </div>
      {preview.impacts.map((impact) => {
        const changed = impact.previousTarget !== impact.nextTarget
        const matched = impact.cues.filter((cue) => cue.matched)
        const unmatched = impact.cues.filter((cue) => !cue.matched)
        return (
          <details className="glossary-impact-entry" open={preview.impacts.length === 1} key={`${impact.index}-${impact.previousTarget}-${impact.nextTarget}`}>
            <summary>
              <span><strong>{impact.source}</strong> · {impact.previousTarget} → {impact.nextTarget}</span>
              <small>{changed ? `${matched.length} 条匹配 · ${unmatched.length} 条跳过` : '仅修改原文术语，不改写译文'}</small>
            </summary>
            {matched.map((cue) => (
              <div className="glossary-impact-cue is-matched" key={`matched-${impact.index}-${cue.cueId}`}>
                <span className="mono">#{cue.cueId}</span>
                <div><small>修改前</small><p>{cue.before}</p></div>
                <div><small>修改后</small><p>{cue.after}</p></div>
              </div>
            ))}
            {unmatched.map((cue) => (
              <div className="glossary-impact-cue is-unmatched" key={`unmatched-${impact.index}-${cue.cueId}`}>
                <span className="mono">#{cue.cueId}</span>
                <div><small>该条当前译文</small><p>{cue.before}</p></div>
                <small>{cue.reason === 'target-not-found' ? '含未命中术语，未命中片段保持不变' : '统一写法未变化'}</small>
              </div>
            ))}
          </details>
        )
      })}
    </section>
  )
}

export function AuditGlossary({ page, loading = false, error = '', expectedState, onSave, onBusyChange, manualReview = false, onPreviewImpact, onApplyToCues, onApplied }: AuditGlossaryProps): React.JSX.Element {
  const [values, setValues] = useState<GlossaryEntry[]>(() => cloneGlossary(page?.glossary ?? []))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [preview, setPreview] = useState<GlossaryImpactPreview | undefined>(undefined)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<GlossaryApplyResult | undefined>(undefined)
  const valuesRef = useRef(values)
  const baselineRef = useRef(cloneGlossary(page?.glossary ?? []))
  const revisionRef = useRef(page?.revision ?? 0)
  const taskIdRef = useRef<string | undefined>(undefined)
  const dirtyRef = useRef(false)
  const saveInFlightRef = useRef(false)
  const versionRef = useRef(0)
  const savedTimerRef = useRef<number | undefined>(undefined)
  const blockedRef = useRef(false)
  const previewVersionRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!page || page.taskId === taskIdRef.current) return
    taskIdRef.current = page?.taskId
    const baseline = cloneGlossary(page.glossary)
    const restored = restoreDraft(page, manualReview)
    valuesRef.current = restored.values
    baselineRef.current = baseline
    revisionRef.current = page.revision
    dirtyRef.current = restored.dirty
    saveInFlightRef.current = false
    blockedRef.current = restored.conflict
    setValues(restored.values)
    setDirty(restored.dirty)
    setSaving(false)
    setSaveError(restored.conflict ? '术语表已在其他位置更新；当前草稿已保留，请选择载入最新版本或覆盖' : '')
    setSaved(false)
    setBlocked(restored.conflict)
    setConflict(restored.conflict)
    setPreview(undefined)
    setPreviewing(false)
    setApplying(false)
    setApplyResult(undefined)
    previewVersionRef.current = undefined
  }, [page?.taskId])

  useEffect(() => {
    if (!page || page.taskId !== taskIdRef.current) return
    revisionRef.current = page.revision
    if (!dirtyRef.current && !saveInFlightRef.current) {
      const next = cloneGlossary(page.glossary)
      valuesRef.current = next
      baselineRef.current = next
      dirtyRef.current = false
      blockedRef.current = false
      persistDraft(page.taskId, next, next, false, manualReview)
      setValues(next)
      setDirty(false)
      setSaveError('')
      setSaved(false)
      setBlocked(false)
      setConflict(false)
    }
  }, [page?.revision, page?.glossary])

  useEffect(() => {
    if (!conflict || !page || page.taskId !== taskIdRef.current || !dirtyRef.current) return
    const latest = cloneGlossary(page.glossary)
    baselineRef.current = latest
    revisionRef.current = page.revision
    persistDraft(page.taskId, valuesRef.current, latest, true, manualReview)
  }, [conflict, page?.revision, page?.glossary])

  useEffect(() => {
    onBusyChange?.(dirty || saving || previewing || applying)
  }, [dirty, saving, previewing, applying, onBusyChange])

  useEffect(() => () => onBusyChange?.(false), [onBusyChange])

  useEffect(
    () => () => {
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current)
    },
    [],
  )

  const editable = Boolean(page?.glossaryEditable && (onSave || (manualReview && onPreviewImpact && onApplyToCues)))
  const saveNow = async (force = false): Promise<void> => {
    if (!page || !onSave || !editable || !dirtyRef.current || saveInFlightRef.current || (!force && blockedRef.current)) return
    const submitted = cloneGlossary(valuesRef.current)
    const edits = editsFrom(submitted, baselineRef.current)
    if (!edits.length) {
      dirtyRef.current = false
      setDirty(false)
      return
    }
    if (edits.some((edit) => !edit.source || !edit.target)) {
      setSaveError('原文术语和统一写法不能为空')
      blockedRef.current = true
      setBlocked(true)
      return
    }
    const submittedVersion = versionRef.current
    saveInFlightRef.current = true
    setSaving(true)
    setSaveError('')
    setSaved(false)
    try {
      const revision = await onSave(page.taskId, revisionRef.current, edits)
      revisionRef.current = revision
      baselineRef.current = submitted.map((entry) => ({ ...entry, source: entry.source.trim(), target: entry.target.trim() }))
      if (submittedVersion === versionRef.current) {
        valuesRef.current = cloneGlossary(baselineRef.current)
        setValues(cloneGlossary(baselineRef.current))
        dirtyRef.current = false
        setDirty(false)
        persistDraft(page.taskId, baselineRef.current, baselineRef.current, false, manualReview)
        setSaved(true)
        if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current)
        savedTimerRef.current = window.setTimeout(() => setSaved(false), 1_800)
      } else {
        const stillDirty = !sameEditableValues(valuesRef.current, baselineRef.current)
        dirtyRef.current = stillDirty
        setDirty(stillDirty)
        persistDraft(page.taskId, valuesRef.current, baselineRef.current, false, manualReview)
      }
      blockedRef.current = false
      setBlocked(false)
      setConflict(false)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '术语修改保存失败'
      const hasConflict = isGlossaryConflictMessage(message)
      setConflict(hasConflict)
      if (hasConflict) persistDraft(page.taskId, valuesRef.current, baselineRef.current, true, manualReview)
      setSaveError(message)
      blockedRef.current = true
      setBlocked(true)
    } finally {
      saveInFlightRef.current = false
      setSaving(false)
    }
  }

  useEffect(() => {
    if (manualReview || !dirty || saving || blocked || !editable) return
    const timer = window.setTimeout(() => {
      void saveNow()
    }, AUTO_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [values, dirty, saving, blocked, editable, manualReview])

  const updateValue = (index: number, field: 'source' | 'target', value: string): void => {
    versionRef.current += 1
    const next = valuesRef.current.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry)
    valuesRef.current = next
    const nextDirty = !sameEditableValues(next, baselineRef.current)
    dirtyRef.current = nextDirty
    setValues(next)
    setDirty(nextDirty)
    persistDraft(taskIdRef.current, next, baselineRef.current, conflict, manualReview)
    setSaved(false)
    setPreview(undefined)
    setApplyResult(undefined)
    previewVersionRef.current = undefined
    if (!conflict) {
      setSaveError('')
      blockedRef.current = false
      setBlocked(false)
    }
  }

  const resetRow = (index: number): void => {
    versionRef.current += 1
    const savedRow = baselineRef.current[index]
    if (!savedRow) return
    const next = valuesRef.current.map((entry, entryIndex) => entryIndex === index ? cloneGlossary([savedRow])[0] : entry)
    valuesRef.current = next
    const nextDirty = !sameEditableValues(next, baselineRef.current)
    dirtyRef.current = nextDirty
    setValues(next)
    setDirty(nextDirty)
    persistDraft(taskIdRef.current, next, baselineRef.current, conflict, manualReview)
    setPreview(undefined)
    setApplyResult(undefined)
    previewVersionRef.current = undefined
    if (!conflict) {
      setSaveError('')
      blockedRef.current = false
      setBlocked(false)
    }
  }

  const loadLatest = (): void => {
    if (!page) return
    const next = cloneGlossary(page.glossary)
    valuesRef.current = next
    baselineRef.current = next
    revisionRef.current = page.revision
    dirtyRef.current = false
    blockedRef.current = false
    persistDraft(page.taskId, next, next, false, manualReview)
    setValues(next)
    setDirty(false)
    setSaveError('')
    setSaved(false)
    setBlocked(false)
    setConflict(false)
    setPreview(undefined)
    setApplyResult(undefined)
    previewVersionRef.current = undefined
  }

  const overwriteLatest = (): void => {
    if (!page) return
    const latest = cloneGlossary(page.glossary)
    baselineRef.current = latest
    revisionRef.current = page.revision
    const nextDirty = !sameEditableValues(valuesRef.current, latest)
    dirtyRef.current = nextDirty
    blockedRef.current = false
    persistDraft(page.taskId, valuesRef.current, latest, false, manualReview)
    setDirty(nextDirty)
    setSaveError('')
    setBlocked(false)
    setConflict(false)
    setPreview(undefined)
    setApplyResult(undefined)
    previewVersionRef.current = undefined
    if (nextDirty && !manualReview) void saveNow(true)
  }

  const finishManualCommit = (submitted: readonly GlossaryEntry[], revision: number): void => {
    revisionRef.current = revision
    const committed = submitted.map((entry) => ({ ...entry, source: entry.source.trim(), target: entry.target.trim() }))
    baselineRef.current = cloneGlossary(committed)
    valuesRef.current = cloneGlossary(committed)
    dirtyRef.current = false
    blockedRef.current = false
    persistDraft(page?.taskId, committed, committed, false, manualReview)
    setValues(cloneGlossary(committed))
    setDirty(false)
    setBlocked(false)
    setConflict(false)
    setSaveError('')
    setSaved(true)
    previewVersionRef.current = undefined
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current)
    savedTimerRef.current = window.setTimeout(() => setSaved(false), 1_800)
  }

  const focusFirstIncompleteEdit = (edits: readonly GlossaryEdit[]): void => {
    const incomplete = edits.find((edit) => !edit.source.trim() || !edit.target.trim())
    if (!incomplete) return
    const field = incomplete.source.trim() ? 'target' : 'source'
    const suggestion = field === 'target' ? keepOriginalSuggestion(incomplete.source) : ''
    setSaveError(field === 'target'
      ? `“${incomplete.source.trim() || `术语 ${incomplete.index + 1}`}”缺少统一写法${suggestion ? `；如需保留英文，请填入“${suggestion}”` : ''}`
      : `术语 ${incomplete.index + 1} 缺少原文`)
    window.requestAnimationFrame(() => {
      const input = document.getElementById(`glossary-${page?.taskId ?? 'unknown'}-${incomplete.index}-${field}`)
      input?.focus({ preventScroll: true })
      input?.closest('.glossary-row')?.scrollIntoView({ block: 'center' })
    })
  }

  const previewManualImpact = async (): Promise<void> => {
    if (!page || !onPreviewImpact || previewing || applying || blockedRef.current) return
    const submitted = cloneGlossary(valuesRef.current)
    const edits = editsFrom(submitted, baselineRef.current)
    const targetEdits = edits.filter((edit) => edit.target !== edit.expectedTarget)
    if (!targetEdits.length) return
    if (edits.some((edit) => !edit.source || !edit.target)) {
      focusFirstIncompleteEdit(edits)
      return
    }
    const submittedVersion = versionRef.current
    setPreviewing(true)
    setSaveError('')
    setApplyResult(undefined)
    try {
      const nextPreview = await onPreviewImpact(page.taskId, revisionRef.current, edits)
      if (submittedVersion !== versionRef.current) return
      setPreview(nextPreview)
      previewVersionRef.current = submittedVersion
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '无法预览术语对译文的影响'
      const hasConflict = isGlossaryConflictMessage(message)
      setConflict(hasConflict)
      blockedRef.current = hasConflict
      setBlocked(hasConflict)
      if (hasConflict) persistDraft(page.taskId, valuesRef.current, baselineRef.current, true, manualReview)
      setSaveError(message)
    } finally {
      setPreviewing(false)
    }
  }

  const commitManualEdits = async (): Promise<void> => {
    if (!page || applying || previewing || blockedRef.current) return
    const submitted = cloneGlossary(valuesRef.current)
    const edits = editsFrom(submitted, baselineRef.current)
    if (!edits.length) return
    if (edits.some((edit) => !edit.source || !edit.target)) {
      focusFirstIncompleteEdit(edits)
      return
    }
    const hasTargetEdits = edits.some((edit) => edit.target !== edit.expectedTarget)
    if (hasTargetEdits && (!preview || previewVersionRef.current !== versionRef.current)) {
      setSaveError('统一写法有变化，请先预览对全部引用 cue 的影响')
      return
    }
    setApplying(true)
    setSaveError('')
    setSaved(false)
    try {
      if (hasTargetEdits) {
        if (!onApplyToCues || !preview) throw new Error('当前版本暂不支持把术语修改同步到译文')
        const result = await onApplyToCues(page.taskId, revisionRef.current, preview.impactFingerprint, edits)
        finishManualCommit(submitted, result.detail.manifest.revision)
        setPreview(undefined)
        setApplyResult(result)
        onApplied?.(result)
      } else {
        if (!onSave) throw new Error('当前版本暂不支持保存术语修改')
        const revision = await onSave(page.taskId, revisionRef.current, edits)
        finishManualCommit(submitted, revision)
        setPreview(undefined)
        setApplyResult(undefined)
        onApplied?.()
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '术语修改应用失败'
      const hasConflict = isGlossaryConflictMessage(message)
      setConflict(hasConflict)
      setSaveError(message)
      blockedRef.current = hasConflict
      setBlocked(hasConflict)
      if (hasConflict) persistDraft(page.taskId, valuesRef.current, baselineRef.current, true, manualReview)
    } finally {
      setApplying(false)
    }
  }

  if (loading) return <div className="review-placeholder">正在读取审计术语…</div>
  if (error)
    return (
      <p className="review-error" role="alert">
        {error}
      </p>
    )
  if (expectedState === 'invalid')
    return (
      <p className="review-error" role="alert">
        术语表读取失败
      </p>
    )
  if (expectedState === 'not-audited') return <div className="review-placeholder">尚未生成术语表</div>
  if (expectedState === 'empty') return <div className="review-placeholder">审计完成 · 无术语</div>
  if (expectedState === 'ready' && page?.glossaryState !== 'ready')
    return (
      <p className="review-error" role="alert">
        术语摘要可用，但完整术语暂时无法读取
      </p>
    )
  if (!page || page.glossaryState === 'not-audited') return <div className="review-placeholder">尚未生成术语表</div>
  if (page.glossaryState === 'empty') return <div className="review-placeholder">审计完成 · 无术语</div>

  const pendingEdits = editsFrom(values, baselineRef.current, false)
  const targetEdits = pendingEdits.filter((edit) => edit.target !== edit.expectedTarget)
  const incompleteEdits = pendingEdits.filter((edit) => !edit.source.trim() || !edit.target.trim())
  const incompleteIndexes = new Set(incompleteEdits.map((edit) => edit.index))
  const incompleteCueIds = values.flatMap((entry, index) => incompleteIndexes.has(index) ? entry.cueIds : [])
  const previewChangedCount = preview ? glossaryImpactCounts(preview).changed : 0
  const previewChangedCueIds = preview?.finalCues.filter((cue) => cue.before !== cue.after).map((cue) => cue.cueId) ?? []
  const previewReferencedCueIds = preview?.finalCues.map((cue) => cue.cueId) ?? []
  const previewImpactsByIndex = new Map(preview?.impacts.map((impact) => [impact.index, impact]) ?? [])
  const statusText = manualReview
    ? (applying
        ? '正在保存术语并同步引用译文…'
        : previewing
          ? '正在核对全部引用 cue…'
          : conflict
            ? '检测到版本冲突'
            : saveError
              ? '操作未完成'
              : dirty
                ? targetEdits.length
                  ? '草稿已保存在本机，尚未应用到译文'
                  : '草稿已保存在本机，尚未保存'
                : saved
                  ? '修改已保存'
                  : editable
                    ? '先编辑，再预览并应用；输入中不会改写译文'
                    : '')
    : (page.glossaryEditMessage
        ?? (saving ? '正在自动保存…' : conflict ? '检测到版本冲突' : saveError ? '自动保存失败' : dirty ? '等待自动保存…' : saved ? '已自动保存' : editable ? '修改会自动保存' : ''))

  return (
    <div className="glossary-editor">
      {(statusText || saveError) && (
        <div className="glossary-edit-state">
          <span role="status">{statusText}</span>
          {saveError && <small title={saveError}>{saveError}</small>}
          {saveError && !conflict && !manualReview && (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                blockedRef.current = false
                setBlocked(false)
                void saveNow(true)
              }}
            >
              重试
            </button>
          )}
          {conflict && (
            <>
              <button className="text-button" type="button" onClick={loadLatest}>
                载入最新版本
              </button>
              <button className="text-button" type="button" onClick={overwriteLatest}>
                用当前草稿覆盖
              </button>
            </>
          )}
        </div>
      )}
      <div className="glossary-table" role="table" aria-label="审计术语">
        <div className="glossary-row glossary-table-heading" role="row">
          <span role="columnheader">原文术语</span>
          <span role="columnheader">统一写法</span>
        </div>
        {values.map((entry, index) => {
          const baseline = baselineRef.current[index]
          const targetChanged = entry.target !== baseline?.target
          const targetMissing = targetChanged && !entry.target.trim()
          const suggestion = keepOriginalSuggestion(entry.source)
          const impact = previewImpactsByIndex.get(index)
          const changedCueIds = impact?.cues.filter((cue) => cue.before !== cue.after).map((cue) => cue.cueId) ?? []
          const skippedCueIds = impact?.cues.filter((cue) => cue.reason === 'target-not-found').map((cue) => cue.cueId) ?? []
          const unchangedCueIds = impact?.cues.filter((cue) => cue.before === cue.after && cue.reason !== 'target-not-found').map((cue) => cue.cueId) ?? []
          return (
          <article className={`glossary-row ${editable ? 'is-editable' : ''} ${targetMissing ? 'has-error' : ''}`} role="row" key={`${entry.cueIds.join(',')}-${index}`}>
            <span role="cell">
              {editable ? (
                <input
                  className="glossary-input source"
                  aria-label={`术语 ${index + 1} 原文`}
                  disabled={applying}
                  id={`glossary-${page.taskId}-${index}-source`}
                  maxLength={500}
                  value={entry.source}
                  onChange={(event) => updateValue(index, 'source', event.target.value)}
                  onBlur={() => {
                    if (!manualReview) void saveNow()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      resetRow(index)
                    }
                  }}
                />
              ) : (
                <strong>{entry.source}</strong>
              )}
            </span>
            <span className="glossary-target-cell" role="cell">
              {editable ? (
                <>
                  <input
                    className="glossary-input target"
                    aria-invalid={targetMissing}
                    aria-label={`术语 ${index + 1} 统一写法`}
                    disabled={applying}
                    id={`glossary-${page.taskId}-${index}-target`}
                    maxLength={500}
                    value={entry.target}
                    onChange={(event) => updateValue(index, 'target', event.target.value)}
                    onBlur={() => {
                      if (!manualReview) void saveNow()
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        resetRow(index)
                      }
                    }}
                  />
                  {manualReview && targetChanged && (
                    <small className={`glossary-row-impact ${targetMissing ? 'is-error' : impact ? 'is-previewed' : ''}`}>
                      {targetMissing ? (
                        <>
                          <span>统一写法不能为空</span>
                          {suggestion && (
                            <button className="glossary-keep-original" type="button" disabled={applying} onClick={() => updateValue(index, 'target', suggestion)}>
                              保留英文 {suggestion}
                            </button>
                          )}
                          <CueReferences cueIds={entry.cueIds} prefix="引用" />
                        </>
                      ) : impact ? (
                        <>
                          {changedCueIds.length > 0 && <CueReferences cueIds={changedCueIds} prefix="将修改" />}
                          {skippedCueIds.length > 0 && <CueReferences cueIds={skippedCueIds} prefix="未命中" />}
                          {!changedCueIds.length && unchangedCueIds.length > 0 && <CueReferences cueIds={unchangedCueIds} prefix="无需改写" />}
                        </>
                      ) : (
                        <CueReferences cueIds={entry.cueIds} prefix="待核对" />
                      )}
                    </small>
                  )}
                </>
              ) : (
                <span className="target">{entry.target}</span>
              )}
            </span>
          </article>
          )
        })}
      </div>
      {manualReview && editable && dirty && (
        <div className="glossary-manual-actions">
          <div>
            <strong>{incompleteEdits.length ? `${incompleteEdits.length} 条统一写法尚未完成` : preview ? `已预览 · 将修改 ${previewChangedCount} 条译文` : `${pendingEdits.length} 条术语有未应用修改`}</strong>
            <small>
              {incompleteEdits.length
                ? <><span>空值不会删除字幕；如不翻译，请选择“保留英文”。</span><CueReferences cueIds={incompleteCueIds} prefix="引用" /></>
                : preview
                  ? <CueReferences cueIds={previewChangedCueIds.length ? previewChangedCueIds : previewReferencedCueIds} prefix={previewChangedCueIds.length ? '影响' : '已核对'} />
                  : targetEdits.length ? `${targetEdits.length} 条统一写法变化；应用前必须核对影响范围。` : '仅修改原文术语，不会扩大引用范围或改写译文。'}
            </small>
          </div>
          <div className="glossary-manual-buttons">
            <button className="text-button" type="button" disabled={previewing || applying} onClick={loadLatest}>
              放弃草稿
            </button>
            {targetEdits.length ? (
              <>
                <button className="secondary-button" type="button" disabled={previewing || applying || blocked} onClick={() => incompleteEdits.length ? focusFirstIncompleteEdit(pendingEdits) : void previewManualImpact()}>
                  {previewing ? '正在预览…' : incompleteEdits.length ? `补全 ${incompleteEdits.length} 条统一写法` : preview ? '重新预览' : `预览 ${targetEdits.length} 条写法影响`}
                </button>
                <button className="primary-button" type="button" disabled={!preview || previewVersionRef.current !== versionRef.current || previewing || applying || blocked} onClick={() => void commitManualEdits()}>
                  {applying ? '正在应用…' : incompleteEdits.length ? '补全后预览' : preview ? previewChangedCount ? `应用到 ${previewChangedCount} 条匹配译文` : '保存统一写法（无需改写译文）' : '先预览再应用'}
                </button>
              </>
            ) : (
              <button className="primary-button" type="button" disabled={applying || blocked} onClick={() => void commitManualEdits()}>
                {applying ? '正在保存…' : '保存术语修改'}
              </button>
            )}
          </div>
        </div>
      )}
      {manualReview && preview && <ImpactDetails preview={preview} />}
      {manualReview && applyResult && <ImpactDetails preview={applyResult.preview} applied />}
    </div>
  )
}
