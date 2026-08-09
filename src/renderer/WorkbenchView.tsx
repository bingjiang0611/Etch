import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { BilibiliAccount } from '../shared/bilibili'
import type { GlossaryApplyResult, GlossaryImpactPreview, ChromeCookieAccess, PipelineActivity, TaskDetail, TaskReviewPage, ToolHealthSnapshot } from '../shared/ipc'
import { POOL_BY_STAGE, POOL_LABELS, STAGE_ORDER } from '../shared/pipeline'
import type { AppSettings } from '../shared/settings-schema'
import { SHARED_STAGE_IDS, lastStageForKind, taskInputName, type ProviderId, type StageId } from '../shared/task-schema'
import { AuditGlossary, type GlossaryEdit } from './AuditGlossary'
import { IllustrationCheckpointEditor, SummaryDraftsPanel, SummaryPanel, useSummaryPage } from './SummaryPanel'
import { recoveredToolForStageFailure } from './tool-health'
import { DEFAULT_PROVIDER, PROVIDER_IDS, providerAvailability } from './provider-availability'
import {
  Icon,
  PresetDemo,
  VideoPreview,
  activeStageId,
  bilibiliPublicationText,
  completedStageCount,
  durationLabel,
  getStage,
  isStageDone,
  poolState,
  poolStateLabel,
  pools,
  providerNames,
  reviewTime,
  stageLabels,
  stageSubLabel,
  subtitleKindLabel,
  taskStages,
  type SubtitlePreset,
} from './ui'

const REVIEW_PAGE_SIZE = 100
type WorkspaceTab = 'review' | 'info' | 'glossary' | 'style' | 'summary' | 'drafts'
type AuditCheckpoint = NonNullable<TaskDetail['manifest']['translation']['auditCheckpoint']>
type AuditDecision = { cueId: number; translation: string }

function auditTextError(value: string, sourceAudit: boolean): string | undefined {
  const label = sourceAudit ? '建议字幕' : '建议译法'
  if (/[\t\r\n]/u.test(value)) return `${label}不能包含 Tab 或换行`
  if (!value.trim()) return `${label}不能为空`
  if (value.trim().length > 2000) return `${label}不能超过 2000 个字符`
  return undefined
}

interface WorkbenchViewProps {
  selected: TaskDetail | undefined
  relatedOutput: TaskDetail | undefined
  settings: AppSettings
  settingsLoaded: boolean
  taskActionError: string
  dirtyCount: number
  reviewPage: TaskReviewPage | undefined
  reviewLoading: boolean
  reviewError: string
  reviewOffset: number
  cueDrafts: Record<number, string>
  cueConflicts: Record<number, { english: string; chinese: string }>
  savingCues: boolean
  autoSaveBlocked: boolean
  cueSaveNotice: string
  resolvingAudit: boolean
  completingReview: boolean
  savingPreset: boolean
  glossaryBusy: boolean
  selectedIsRunning: boolean
  selectedWaitingStage: StageId | undefined
  activity: PipelineActivity
  selectedIsPaused: boolean
  stoppingTask: boolean
  creatingCompanion: boolean
  publicationActionBusy: boolean
  bilibiliAccount: BilibiliAccount
  needsRebuild: boolean
  chromeCookieAccess: ChromeCookieAccess
  toolHealth: readonly ToolHealthSnapshot[]
  videoRef: RefObject<HTMLVideoElement | null>
  onBack: () => void
  onOpenOutput: (taskId: string) => Promise<void>
  onCreateCompanion: (provider: ProviderId, styleNote: string) => Promise<void>
  onStart: () => Promise<void>
  onStop: () => Promise<void>
  onOpenPermissionGuide: () => void
  onPublish: () => void
  onStopPublication: () => Promise<void>
  onContinuePublication: () => Promise<void>
  onOpenCreatorCenter: () => Promise<void>
  onResolveAudit: (decisions: AuditDecision[]) => Promise<void>
  resolvingIllustration: boolean
  onResolveVideoCheckpoint: (decision: Parameters<typeof window.etch.resolveVideoCheckpoint>[2]) => Promise<void>
  onResolveResearchCheckpoint: (decision: Parameters<typeof window.etch.resolveResearchCheckpoint>[2]) => Promise<void>
  onResolveIllustrationAgent: (choice: Parameters<typeof window.etch.resolveIllustrationAgent>[2]) => Promise<void>
  onResolveIllustrationCover: (decision: Parameters<typeof window.etch.resolveIllustrationCover>[2]) => Promise<void>
  onCompleteReview: () => Promise<void>
  onPreset: (preset: SubtitlePreset) => Promise<void>
  onDiscardCues: () => void
  onSaveCues: () => Promise<void>
  onCueDraftChange: (cueId: number, value: string, saved: string, english: string) => void
  onReviewOffsetChange: (offset: number) => void
  onSaveGlossary: (taskId: string, expectedRevision: number, edits: GlossaryEdit[]) => Promise<number>
  onPreviewGlossaryImpact: (taskId: string, expectedRevision: number, edits: GlossaryEdit[]) => Promise<GlossaryImpactPreview>
  onApplyGlossaryToCues: (taskId: string, expectedRevision: number, impactFingerprint: string, edits: GlossaryEdit[]) => Promise<GlossaryApplyResult>
  onGlossaryBusyChange: (busy: boolean) => void
}

function StageRail({ detail, stages, numberOffset = 0 }: { detail: TaskDetail; stages: readonly StageId[]; numberOffset?: number }): React.JSX.Element {
  return (
    <div
      className="rail branch-rail"
      style={{ '--rail-columns': stages.length } as CSSProperties}
      role="list"
      aria-label={`${detail.manifest.kind === 'subtitle' ? '双语硬字幕' : '视频总结'}阶段`}
    >
      {stages.map((id, index) => {
        const stage = getStage(detail, id)
        return (
          <div className="rail-node" data-status={stage.status} data-done={isStageDone(stage) ? 'true' : undefined} role="listitem" key={id}>
            {stage.attempt > 1 && <span className="rail-attempt">×{stage.attempt}</span>}
            <span className="rail-dot">{stage.status === 'completed' ? <Icon name="check" /> : String(index + numberOffset + 1).padStart(2, '0')}</span>
            <span className="rail-label">{stageLabels[id]}</span>
            <span className="rail-sub" title={stageSubLabel(detail, id, stage) || undefined}>{stageSubLabel(detail, id, stage)}</span>
            {stage.status === 'running' && (
              <span className="rail-progress">
                <i style={{ width: `${Math.round((stage.progress ?? 0) * 100)}%` }} />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface AuditCheckpointEditorProps {
  checkpoint: AuditCheckpoint
  sourceAudit: boolean
  resolvingAudit: boolean
  onResolveAudit: (decisions: AuditDecision[]) => Promise<void>
  onSeek: (startMs: number) => void
}

function AuditCheckpointEditor({ checkpoint, sourceAudit, resolvingAudit, onResolveAudit, onSeek }: AuditCheckpointEditorProps): React.JSX.Element {
  const [recommendations, setRecommendations] = useState<Record<number, string>>(() =>
    Object.fromEntries(checkpoint.ambiguities.map((item) => [item.cueId, item.recommended])),
  )
  const [adoptedCueIds, setAdoptedCueIds] = useState<Set<number>>(() => new Set())
  const adoptedCount = checkpoint.ambiguities.filter((item) => adoptedCueIds.has(item.cueId)).length
  const invalidAdoptedCount = checkpoint.ambiguities.filter(
    (item) => adoptedCueIds.has(item.cueId) && auditTextError(recommendations[item.cueId] ?? '', sourceAudit),
  ).length
  const currentLabel = sourceAudit ? '当前字幕' : '当前译法'
  const recommendedLabel = sourceAudit ? '建议纠正为' : '建议统一为'
  const suggestionLabel = sourceAudit ? '纠正建议' : '建议译法'

  const updateRecommendation = (cueId: number, value: string): void => {
    setRecommendations((current) => ({ ...current, [cueId]: value }))
    setAdoptedCueIds((current) => {
      const next = new Set(current)
      next.add(cueId)
      return next
    })
  }

  const toggleRecommendation = (cueId: number): void => {
    setAdoptedCueIds((current) => {
      const next = new Set(current)
      if (next.has(cueId)) next.delete(cueId)
      else next.add(cueId)
      return next
    })
  }

  const submitDecisions = (): void => {
    if (invalidAdoptedCount) return
    void onResolveAudit(
      checkpoint.ambiguities.map((item) => ({
        cueId: item.cueId,
        translation: (adoptedCueIds.has(item.cueId) ? (recommendations[item.cueId] ?? item.recommended) : item.before).trim(),
      })),
    )
  }

  return (
    <section className="audit-checkpoint" role="region" aria-labelledby="audit-title" aria-busy={resolvingAudit}>
      <div className="head">
        <Icon name="warning" />
        <span id="audit-title">
          {sourceAudit ? '英文源字幕审计' : '术语审计'}发现 {checkpoint.ambiguities.length} 处歧义，等待你的裁决
        </span>
      </div>
      <div className="audit-actions">
        <div className="audit-resolution-summary" role="status" aria-live="polite">
          <strong>
            已采用 {adoptedCount} / {checkpoint.ambiguities.length} 条建议
          </strong>
          <span>其余 {checkpoint.ambiguities.length - adoptedCount} 条保留{currentLabel}</span>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={resolvingAudit}
          onClick={() => setAdoptedCueIds(new Set())}
        >
          全部保留{currentLabel}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={resolvingAudit}
          onClick={() => setAdoptedCueIds(new Set(checkpoint.ambiguities.map((item) => item.cueId)))}
        >
          全部采用{suggestionLabel}
        </button>
        <button className="primary-button" type="button" disabled={resolvingAudit || invalidAdoptedCount > 0} onClick={submitDecisions}>
          {resolvingAudit ? '正在提交…' : '确认裁决并继续'}
        </button>
      </div>
      <div className="audit-comparison-head">
        <span>{currentLabel}</span>
        <span>{recommendedLabel}</span>
      </div>
      {checkpoint.ambiguities.map((item) => {
        const recommendation = recommendations[item.cueId] ?? item.recommended
        const adopted = adoptedCueIds.has(item.cueId)
        const recommendationError = adopted ? auditTextError(recommendation, sourceAudit) : undefined
        const inputId = `audit-recommendation-${item.cueId}`
        const hasTiming = item.startMs !== undefined && item.endMs !== undefined
        return (
          <article className="audit-item" data-adopted={adopted ? 'true' : undefined} key={item.cueId}>
            <div className="audit-item-title">
              <div className="audit-item-identity">
                <strong>
                  Cue {item.cueId} · “{item.en}”
                </strong>
                {sourceAudit && (hasTiming ? (
                  <button
                    className="audit-cue-seek"
                    type="button"
                    aria-label={`定位并播放 Cue ${item.cueId}，${reviewTime(item.startMs!)} 至 ${reviewTime(item.endMs!)}`}
                    disabled={resolvingAudit}
                    onClick={() => onSeek(item.startMs!)}
                  >
                    <Icon name="play" />
                    {reviewTime(item.startMs!)} – {reviewTime(item.endMs!)}
                  </button>
                ) : (
                  <span className="audit-cue-time-empty">时间码 —</span>
                ))}
              </div>
              <span className="audit-item-state">{adopted ? '采用建议' : '保留当前'}</span>
            </div>
            <div className="cmp">
              <div className="before" data-label={currentLabel} data-selected={adopted ? undefined : 'true'}>
                <p>{item.before}</p>
              </div>
              <div className="after" data-label={recommendedLabel} data-selected={adopted ? 'true' : undefined}>
                <label className="sr-only" htmlFor={inputId}>
                  Cue {item.cueId} {recommendedLabel}
                </label>
                <div className="audit-recommendation-row">
                  <textarea
                    id={inputId}
                    className="audit-recommendation-input"
                    rows={1}
                    maxLength={2000}
                    value={recommendation}
                    aria-invalid={Boolean(recommendationError)}
                    aria-describedby={recommendationError ? `${inputId}-error` : undefined}
                    disabled={resolvingAudit}
                    onChange={(event) => updateRecommendation(item.cueId, event.currentTarget.value)}
                  />
                  <button
                    className="audit-adopt-button"
                    type="button"
                    aria-label={`Cue ${item.cueId} 采用${suggestionLabel}`}
                    aria-pressed={adopted}
                    disabled={resolvingAudit}
                    title={adopted ? `点击恢复${currentLabel}` : `采用这条${suggestionLabel}`}
                    onClick={() => toggleRecommendation(item.cueId)}
                  >
                    {adopted ? '已采用' : '采用'}
                  </button>
                </div>
                {recommendation !== item.recommended && <span className="audit-edited">已编辑</span>}
                {recommendationError && (
                  <span className="audit-input-error" id={`${inputId}-error`}>
                    {recommendationError}
                  </span>
                )}
              </div>
            </div>
            <small>{item.reason}</small>
          </article>
        )
      })}
    </section>
  )
}

export function WorkbenchView({
  selected,
  relatedOutput,
  settings,
  settingsLoaded,
  taskActionError,
  dirtyCount,
  reviewPage,
  reviewLoading,
  reviewError,
  reviewOffset,
  cueDrafts,
  cueConflicts,
  savingCues,
  autoSaveBlocked,
  cueSaveNotice,
  resolvingAudit,
  completingReview,
  savingPreset,
  glossaryBusy,
  selectedIsRunning,
  selectedWaitingStage,
  activity,
  selectedIsPaused,
  stoppingTask,
  creatingCompanion,
  publicationActionBusy,
  bilibiliAccount,
  needsRebuild,
  chromeCookieAccess,
  toolHealth,
  videoRef,
  onBack,
  onOpenOutput,
  onCreateCompanion,
  onStart,
  onStop,
  onOpenPermissionGuide,
  onPublish,
  onStopPublication,
  onContinuePublication,
  onOpenCreatorCenter,
  onResolveAudit,
  resolvingIllustration,
  onResolveVideoCheckpoint,
  onResolveResearchCheckpoint,
  onResolveIllustrationAgent,
  onResolveIllustrationCover,
  onCompleteReview,
  onPreset,
  onDiscardCues,
  onSaveCues,
  onCueDraftChange,
  onReviewOffsetChange,
  onSaveGlossary,
  onPreviewGlossaryImpact,
  onApplyGlossaryToCues,
  onGlossaryBusyChange,
}: WorkbenchViewProps): React.JSX.Element {
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('review')
  const [pipelineExpanded, setPipelineExpanded] = useState(true)
  const [activeCueId, setActiveCueId] = useState<number>()
  const [companionOpen, setCompanionOpen] = useState(false)
  const [companionProvider, setCompanionProvider] = useState<ProviderId>(DEFAULT_PROVIDER)
  const [companionStyleNote, setCompanionStyleNote] = useState('')
  const companionDialogRef = useRef<HTMLDialogElement>(null)
  const guidedReviewCheckpointRef = useRef<string | undefined>(undefined)
  const isSummaryTask = selected?.manifest.kind === 'summary'
  const summary = useSummaryPage(isSummaryTask ? selected?.manifest.taskId : undefined, selected?.manifest.revision ?? 0)
  const illustrateStage = selected ? getStage(selected, 'illustrate') : undefined
  const illustrationCheckpoint = illustrateStage?.status === 'checkpoint' ? illustrateStage.checkpointId : undefined
  const videoCheckpoint = selected?.manifest.video.checkpoint
  const researchCheckpoint = selected?.manifest.pipeline.stages.research?.status === 'checkpoint'
    && selected.manifest.summary.research.status === 'checkpoint'
  const selectedProvider = selected?.manifest.translation.selectedProvider
  const selectedStage = selected ? activeStageId(selected) : undefined
  const selectedCompletedCount = selected ? completedStageCount(selected) : 0
  const translationBatchTotal = selected?.manifest.translation.batches.length ?? 0
  const verifiedBatchCount = selected?.manifest.translation.batches.filter((batch) => batch.status === 'verified').length ?? 0
  const activeGeneration = selected?.manifest.translation.sessionGenerations.find((item) => item.id === selected.manifest.translation.activeGenerationId)
  const selectedModel = selected?.manifest.translation.selectedModel
  const selectedModelLabel = selectedModel?.source === 'cli-default' ? 'cli-default' : (selectedModel?.modelId ?? '—')
  const checkpoint = selected?.manifest.translation.auditCheckpoint
  const sourceAuditCheckpoint = Boolean(
    selected?.manifest.pipeline.stages.cues?.status === 'checkpoint'
      && selected.manifest.pipeline.stages.cues.checkpointId === 'english-source-ambiguity',
  )
  const checkpointCount = checkpoint?.ambiguities.length ?? 0
  const reviewStage = selected ? getStage(selected, 'review') : undefined
  const reviewCheckpoint = reviewStage?.status === 'checkpoint' && reviewStage.checkpointId === 'manual-review'
  const reviewCheckpointKey = reviewCheckpoint && reviewStage ? `${selected?.manifest.taskId}:${reviewStage.checkpointId}:${reviewStage.attempt}` : undefined
  const sourceStage = selected ? getStage(selected, 'source') : undefined
  const showChromeLoginHelp = sourceStage?.status === 'failed'
    && selected?.manifest.video.sourcePlatform === 'youtube'
    && chromeCookieAccess !== 'granted'
  const verifyCompleted = selected ? getStage(selected, isSummaryTask ? 'illustrate' : 'verify').status === 'completed' : false
  const waitingPool = selectedWaitingStage ? POOL_BY_STAGE[selectedWaitingStage] : undefined
  const waitingOccupancy = waitingPool ? activity.pools[waitingPool] : undefined
  const publication = selected?.manifest.publication
  const publicationRunning = publication ? ['queued', 'uploading', 'submitting'].includes(publication.status) : false
  const publicationCanContinue = publication ? ['paused', 'failed'].includes(publication.status) && Boolean(publication.draft) : false
  const publicationActionLabel = publicationRunning
    ? publicationActionBusy ? '正在停止投稿…' : '停止 B站投稿'
    : publication?.status === 'submitted'
      ? '查看 B站创作中心'
      : publication?.status === 'unknown'
        ? '确认 B站投稿结果'
        : publicationCanContinue
          ? publicationActionBusy ? '正在继续投稿…' : '继续 B站投稿'
          : bilibiliAccount.status === 'connected' ? '投稿到 B站' : '连接 B站并投稿'
  const activeStage = selected && selectedStage ? getStage(selected, selectedStage) : undefined
  const stages = selected ? taskStages(selected) : STAGE_ORDER
  const outputs = selected
    ? [selected, ...(relatedOutput && relatedOutput.manifest.taskId !== selected.manifest.taskId ? [relatedOutput] : [])]
        .sort((left, right) => left.manifest.kind === right.manifest.kind ? 0 : left.manifest.kind === 'subtitle' ? -1 : 1)
    : []
  const sharedCompletedCount = selected
    ? SHARED_STAGE_IDS.filter((stage) => getStage(selected, stage).status === 'completed').length
    : 0
  const sharedReady = sharedCompletedCount === SHARED_STAGE_IDS.length
  const companionKind = selected?.manifest.kind === 'subtitle' ? 'summary' : 'subtitle'
  const companionLabel = companionKind === 'subtitle' ? '双语硬字幕' : '视频总结'
  // 字幕任务不该看到配图池，总结任务也不该看到压制池。
  const taskPools = pools.filter((pool) => stages.some((id) => POOL_BY_STAGE[id] === pool))
  const overallProgress = Math.min(1, (selectedCompletedCount + (activeStage?.status === 'running' ? (activeStage.progress ?? 0) : 0)) / stages.length)
  const saveStateText = autoSaveBlocked ? '自动保存失败，需处理' : savingCues ? '正在自动保存…' : dirtyCount ? '等待自动保存…' : cueSaveNotice || '已自动保存'
  const primaryActionLabel = checkpoint
    ? '等待审计裁决'
    : videoCheckpoint
      ? '等待视频质量确认'
    : researchCheckpoint
      ? '等待外部核验决策'
    : illustrationCheckpoint
      ? '等待配图确认'
    : reviewCheckpoint
      ? completingReview ? '正在继续…' : '完成校对并继续'
      : selectedIsRunning
        ? stoppingTask ? '正在停止…' : '停止处理'
        : selectedWaitingStage
          ? stoppingTask ? '正在退出排队…' : '退出排队'
        : selectedIsPaused
          ? '继续处理'
        : needsRebuild
          ? '重新生成成片'
          : verifyCompleted ? (isSummaryTask ? '总结已完成' : '成片已是最新') : '开始处理'
  const reviewCompletionBlocked = completingReview || savingCues || autoSaveBlocked || Boolean(dirtyCount) || glossaryBusy || reviewLoading || reviewPage?.availability !== 'ready' || reviewPage.revision !== selected?.manifest.revision
  const primaryActionDisabled = checkpoint
    ? true
    : videoCheckpoint || researchCheckpoint
      ? true
    : illustrationCheckpoint
      ? true
    : reviewCheckpoint
      ? reviewCompletionBlocked
      : selectedIsRunning || selectedWaitingStage
        ? stoppingTask
      : resolvingAudit || savingCues || Boolean(dirtyCount) || glossaryBusy || (verifyCompleted && !needsRebuild)
  const seekVideo = (startMs: number, play = false): void => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = startMs / 1000
    video.dispatchEvent(new Event('timeupdate'))
    if (play) void video.play().catch(() => undefined)
  }
  const openCompanionDialog = (): void => {
    setCompanionProvider(selectedProvider ?? DEFAULT_PROVIDER)
    setCompanionStyleNote('')
    setCompanionOpen(true)
  }

  useEffect(() => {
    setWorkspaceTab(selected?.manifest.kind === 'summary' ? 'summary' : 'review')
    setActiveCueId(undefined)
    setPipelineExpanded(true)
  }, [selected?.manifest.taskId, selected?.manifest.kind])

  useEffect(() => {
    if (illustrationCheckpoint) setPipelineExpanded(true)
  }, [illustrationCheckpoint])

  useEffect(() => {
    if (checkpoint) setPipelineExpanded(true)
  }, [checkpoint])

  useEffect(() => {
    if (videoCheckpoint || researchCheckpoint) setPipelineExpanded(true)
  }, [videoCheckpoint, researchCheckpoint])

  useEffect(() => {
    if (selectedIsRunning) setPipelineExpanded(true)
  }, [selectedIsRunning])

  useEffect(() => {
    const dialog = companionDialogRef.current
    if (!dialog) return
    if (companionOpen && !dialog.open) dialog.showModal()
    else if (!companionOpen && dialog.open) dialog.close()
  }, [companionOpen])

  useEffect(() => {
    if (!reviewCheckpointKey || reviewPage?.availability !== 'ready' || guidedReviewCheckpointRef.current === reviewCheckpointKey) return
    guidedReviewCheckpointRef.current = reviewCheckpointKey
    // 人工校对是高频编辑区：状态仍保留在折叠摘要里，把垂直空间优先还给术语与 cue。
    setPipelineExpanded(false)
    setWorkspaceTab(reviewPage.glossaryState === 'ready' ? 'glossary' : 'review')
  }, [reviewCheckpointKey, reviewPage?.availability, reviewPage?.glossaryState])

  if (!selected)
    return (
      <section className="workbench-view" aria-label="任务工作台">
        <div className="empty-state workbench-empty">
          <div className="empty-icon" aria-hidden="true">
            <Icon name="empty" />
          </div>
          <h3>先从任务队列选择一个视频</h3>
          <p>工作台会显示视频预览、处理流水线和可编辑的中英 cue。</p>
          <button className="text-button" type="button" onClick={() => onBack()}>
            返回任务队列
          </button>
        </div>
      </section>
    )

  const taskSource = taskInputName(selected.manifest.input)
  const taskId = selected.manifest.taskId
  const failedStage = stages.find((id) => getStage(selected, id).status === 'failed')
  const failedErrorCode = failedStage ? getStage(selected, failedStage).errorCode : undefined
  const recoveredTool = selectedIsRunning || selectedWaitingStage ? undefined : recoveredToolForStageFailure(failedErrorCode, toolHealth)
  const glossaryCount = reviewPage?.glossaryState === 'ready' ? reviewPage.glossary.length : undefined
  const tabs: Array<{ id: WorkspaceTab; label: string; count?: number }> = isSummaryTask
    ? [
        { id: 'summary', label: '总结' },
        { id: 'info', label: '任务信息' },
        { id: 'drafts', label: '三稿记录' },
      ]
    : [
        { id: 'review', label: '校对', count: reviewPage?.total },
        { id: 'info', label: '任务信息' },
        { id: 'glossary', label: '审计术语', count: glossaryCount },
        { id: 'style', label: '样式' },
      ]

  return (
    <section className="workbench-view" aria-label="任务工作台">
      <header className="wb-header">
        <button className="back-link" type="button" onClick={() => onBack()}>
          <Icon name="back" />
          任务队列
        </button>
        <div className="wb-title-row">
          <div>
            <span className="provider-tag">
              {selectedProvider ? providerNames[selectedProvider] : 'Provider 未设置'} · {selectedStage ? stageLabels[selectedStage] : selected.manifest.runtime.currentMessage}
            </span>
            <h1>{selected.manifest.title || taskSource}</h1>
            <code className="task-source" title={taskSource}>
              <Icon name={selected.manifest.input.kind === 'url' ? 'link' : 'local'} />
              <span>{taskSource}</span>
            </code>
          </div>
          <div className="wb-actions">
            {!isSummaryTask && verifyCompleted && !needsRebuild && (
              <button
                className={publicationRunning ? 'danger-button' : 'secondary-button bilibili-publish-button'}
                type="button"
                disabled={publicationActionBusy}
                title={bilibiliAccount.status === 'connected' ? undefined : '前往设置连接 B站；登录成功后会自动返回并继续投稿'}
                onClick={() => {
                  if (publicationRunning) void onStopPublication()
                  else if (publication?.status === 'submitted' || publication?.status === 'unknown') void onOpenCreatorCenter()
                  else if (publicationCanContinue && bilibiliAccount.status === 'connected') void onContinuePublication()
                  else onPublish()
                }}
              >
                {publicationActionLabel}
              </button>
            )}
            <button
              className={selectedIsRunning || selectedWaitingStage ? 'danger-button wb-stop-button' : 'primary-button'}
              type="button"
              disabled={primaryActionDisabled}
              onClick={() => {
                void (selectedIsRunning || selectedWaitingStage ? onStop() : reviewCheckpoint ? onCompleteReview() : onStart())
              }}
            >
              {(selectedIsRunning || selectedWaitingStage) && <Icon name="pause" />}
              {primaryActionLabel}
            </button>
          </div>
        </div>
        <div className="wb-output-tabs" role="group" aria-label="视频成果">
          {outputs.map((output) => {
            const active = output.manifest.taskId === selected.manifest.taskId
            const complete = getStage(output, lastStageForKind(output.manifest.kind)).status === 'completed'
            return (
              <button
                className={active ? 'is-active' : ''}
                type="button"
                aria-pressed={active}
                aria-label={`切换到${output.manifest.kind === 'subtitle' ? '双语硬字幕' : '视频总结'}`}
                disabled={active}
                onClick={() => { void onOpenOutput(output.manifest.taskId) }}
                key={output.manifest.taskId}
              >
                <span>{output.manifest.kind === 'subtitle' ? '双语硬字幕' : '视频总结'}</span>
                <small>{complete ? '已完成' : output.manifest.runtime.currentMessage}</small>
              </button>
            )
          })}
        </div>
        {taskActionError && (
          <p className="task-action-error" role="alert">
            {taskActionError}
          </p>
        )}
        {selectedWaitingStage && waitingPool && waitingOccupancy && (
          <div className="permission-banner" role="status">
            <Icon name="warning" />
            <div>
              <strong>{POOL_LABELS[waitingPool]}并发已满（{waitingOccupancy.active}/{activity.limit} 运行中）</strong>
              <span>
                本任务的「{stageLabels[selectedWaitingStage]}」阶段已排队，其他任务释放槽位后会自动继续。
                {waitingOccupancy.waiting > 1 ? `同一个池里还有 ${waitingOccupancy.waiting - 1} 个任务在等。` : ''}
                想提前抢到槽位，可以先停止其他占用该阶段的任务。
              </span>
            </div>
          </div>
        )}
        {showChromeLoginHelp && (
          <div className="permission-banner" role="status">
            <Icon name="warning" />
            <div>
              <strong>{chromeCookieAccess === 'denied' ? 'Etch 未获授权读取 Chrome 登录状态' : '本机未找到 Chrome 登录资料'}</strong>
              <span>
                {chromeCookieAccess === 'denied'
                  ? '需要登录验证的 YouTube 视频会一直失败，完成系统授权后重试即可。'
                  : '请先安装 Chrome 并登录 YouTube，再重试此任务。'}
              </span>
            </div>
            <button className="secondary-button" type="button" onClick={onOpenPermissionGuide}>解决办法</button>
          </div>
        )}
        {recoveredTool && failedStage && (
          <div className="permission-banner" role="status">
            <Icon name="refresh" />
            <div>
              <strong>环境已恢复，可以重试「{stageLabels[failedStage]}」</strong>
              <span>
                上次失败原因：{failedErrorCode}。最新检测显示{recoveredTool.summaryZh}，重试会从这个阶段继续。
              </span>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={primaryActionDisabled}
              onClick={() => {
                void onStart()
              }}
            >
              重试
            </button>
          </div>
        )}
        {!isSummaryTask && publication && (publication.autoPublish || publication.status !== 'idle') && (
          <div className="publication-status-banner" data-status={publication.status} role="status">
            <strong>{bilibiliPublicationText(selected)}</strong>
            <span title={publication.lastError?.message}>
              {publication.status === 'failed' && publication.lastError
                ? publication.lastError.message
                : publication.phaseMessage ?? (publication.autoPublish ? '此任务已开启完成后自动投稿' : '等待手动投稿')}
            </span>
            {publication.receipt?.bvid && <code>{publication.receipt.bvid}</code>}
            {publication.status === 'submitted' && publication.draft && selected.manifest.artifacts.final?.sha256 !== publication.draft.finalSha256 && <em>已投稿的是旧成片</em>}
          </div>
        )}
      </header>

      {reviewCheckpoint && (
        <section className="review-checkpoint-banner" role="region" aria-labelledby="review-checkpoint-title">
          <div className="review-checkpoint-copy">
            <span className="review-checkpoint-icon" aria-hidden="true"><Icon name="pause" /></span>
            <div>
              <strong id="review-checkpoint-title">流水线已暂停在人工校对</strong>
              <span>先核对术语并把修改一次性同步到全部引用 cue，再检查具体译文。确认完成前不会生成 SRT 或压制成片。</span>
            </div>
          </div>
          <div className="review-checkpoint-steps" role="group" aria-label="人工校对步骤">
            <button className={workspaceTab === 'glossary' ? 'is-active' : ''} type="button" aria-pressed={workspaceTab === 'glossary'} aria-current={workspaceTab === 'glossary' ? 'step' : undefined} onClick={() => setWorkspaceTab('glossary')}>
              <span>1</span> 核对术语
            </button>
            <button className={workspaceTab === 'review' ? 'is-active' : ''} type="button" aria-pressed={workspaceTab === 'review'} aria-current={workspaceTab === 'review' ? 'step' : undefined} onClick={() => setWorkspaceTab('review')}>
              <span>2</span> 核对译文
            </button>
            <span className="review-checkpoint-status" role="status">
              {autoSaveBlocked ? '译文保存冲突或失败，需处理后继续' : glossaryBusy ? '术语草稿待预览并应用' : savingCues ? '正在保存译文…' : dirtyCount ? `${dirtyCount} 条译文等待自动保存` : '当前修改均已保存'}
            </span>
          </div>
        </section>
      )}

      <div className="workbench">
        <details
          className="pipeline-collapse"
          open={pipelineExpanded}
          onToggle={(event) => {
            setPipelineExpanded(event.currentTarget.open)
          }}
        >
          <summary>
            <span className="pipeline-chevron">
              <Icon name="chevron" />
            </span>
            <span className="pc-title">处理流水线</span>
            <span className="pc-mini">
              <span>
                {sharedCompletedCount} / {SHARED_STAGE_IDS.length} 共享 · {outputs.length} / 2 个成果 · {selected.manifest.runtime.currentMessage}
              </span>
              <span
                className="mini-bar"
                role="progressbar"
                aria-label="流水线总体进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(overallProgress * 100)}
              >
                <i style={{ width: `${Math.round(overallProgress * 100)}%` }} />
              </span>
              {checkpointCount > 0 && (
                <span className="warn">
                  <Icon name="warning" />
                  {checkpointCount} 处待裁决
                </span>
              )}
              {reviewCheckpoint && (
                <span className="warn review-waiting">
                  <Icon name="pause" />
                  人工校对待确认
                </span>
              )}
            </span>
          </summary>
          <div className="pc-body">
            <section className="pipeline" aria-label="处理流水线详情">
              <div className="shared-pipeline">
                <div className="pipeline-section-label">
                  <span>共享底稿</span>
                  <small>两个成果只执行一次</small>
                </div>
                <StageRail detail={selected} stages={SHARED_STAGE_IDS} />
              </div>
              <div className="pipeline-branch" aria-hidden="true"><i /></div>
              <div className="output-lanes">
                {outputs.map((output) => {
                  const active = output.manifest.taskId === selected.manifest.taskId
                  const outputStages = taskStages(output).filter((stage) => !(SHARED_STAGE_IDS as readonly string[]).includes(stage))
                  const complete = getStage(output, lastStageForKind(output.manifest.kind)).status === 'completed'
                  return (
                    <article className="output-lane" data-active={active || undefined} key={output.manifest.taskId}>
                      <button
                        className="output-lane-head"
                        type="button"
                        aria-label={`切换到${output.manifest.kind === 'subtitle' ? '双语硬字幕' : '视频总结'}成果`}
                        disabled={active}
                        onClick={() => { void onOpenOutput(output.manifest.taskId) }}
                      >
                        <span className="output-lane-mark" data-kind={output.manifest.kind}>{output.manifest.kind === 'subtitle' ? '译' : '总'}</span>
                        <span>
                          <strong>{output.manifest.kind === 'subtitle' ? '双语硬字幕' : '视频总结'}</strong>
                          <small>{complete ? '已完成' : output.manifest.runtime.currentMessage}</small>
                        </span>
                        {active && <em>当前</em>}
                      </button>
                      <StageRail detail={output} stages={outputStages} numberOffset={SHARED_STAGE_IDS.length} />
                    </article>
                  )
                })}
                {!relatedOutput && (
                  <button
                    className="output-lane output-lane-empty"
                    type="button"
                    disabled={!sharedReady || creatingCompanion}
                    onClick={openCompanionDialog}
                  >
                    <span className="output-lane-mark"><Icon name="plus" /></span>
                    <span>
                      <strong>追加{companionLabel}</strong>
                      <small>{sharedReady ? `直接复用前 4 步，只新增 ${companionKind === 'summary' ? 4 : 6} 步` : '等待共享底稿完成'}</small>
                    </span>
                  </button>
                )}
              </div>
              <div className="pipeline-pools">
                {taskPools.map((pool) => {
                  const status = poolState(selected, pool)
                  const queued = pool === waitingPool
                  return (
                    <span className="pool-tag" key={pool}>
                      <span className="dot" data-status={queued ? 'queued' : status} />
                      <b>{pool}</b>
                      {queued ? '排队中' : poolStateLabel(status)}
                    </span>
                  )
                })}
              </div>
            </section>

            {checkpoint && (
              <AuditCheckpointEditor
                checkpoint={checkpoint}
                sourceAudit={sourceAuditCheckpoint}
                resolvingAudit={resolvingAudit}
                onResolveAudit={onResolveAudit}
                onSeek={(startMs) => {
                  const video = videoRef.current
                  if (!video) return
                  seekVideo(startMs, true)
                  video.scrollIntoView({ block: 'center' })
                }}
                key={`${taskId}:${JSON.stringify(checkpoint.ambiguities)}`}
              />
            )}

            {videoCheckpoint && (
              <section className="audit-checkpoint" role="region" aria-labelledby="video-checkpoint-title" aria-busy={resolvingIllustration}>
                <div className="head">
                  <Icon name="warning" />
                  <span id="video-checkpoint-title">
                    {videoCheckpoint.kind === 'low-resolution'
                      ? '源视频低于 720p'
                      : videoCheckpoint.kind === 'whisper-quality'
                        ? 'Whisper 转录质量需要确认'
                        : '大批量翻译需要确认成本'}
                  </span>
                </div>
                <p className="illustration-copy">{videoCheckpoint.summary}</p>
                <div className="audit-actions">
                  <button className="secondary-button" type="button" disabled={resolvingIllustration} onClick={() => { void onResolveVideoCheckpoint('cancel') }}>暂停任务</button>
                  {videoCheckpoint.kind !== 'large-translation' && (
                    <button className="secondary-button" type="button" disabled={resolvingIllustration} onClick={() => { void onResolveVideoCheckpoint('retry') }}>重新执行</button>
                  )}
                  <button className="primary-button" type="button" disabled={resolvingIllustration} onClick={() => { void onResolveVideoCheckpoint('accept') }}>
                    {resolvingIllustration ? '正在提交…' : videoCheckpoint.kind === 'large-translation' ? '确认成本并开始' : '接受并继续'}
                  </button>
                </div>
              </section>
            )}

            {researchCheckpoint && (
              <section className="audit-checkpoint" role="region" aria-labelledby="research-checkpoint-title" aria-busy={resolvingIllustration}>
                <div className="head"><Icon name="warning" /><span id="research-checkpoint-title">外部核验能力暂不可用</span></div>
                <p className="illustration-copy">{getStage(selected, 'research').errorCode}</p>
                <div className="audit-actions">
                  <button className="secondary-button" type="button" disabled={resolvingIllustration} onClick={() => { void onResolveResearchCheckpoint('cancel') }}>暂停任务</button>
                  <button className="secondary-button" type="button" disabled={resolvingIllustration} onClick={() => { void onResolveResearchCheckpoint('retry') }}>重试核验</button>
                  <button className="primary-button" type="button" disabled={resolvingIllustration} onClick={() => { void onResolveResearchCheckpoint('continue-unverified') }}>
                    {resolvingIllustration ? '正在提交…' : '继续并标记未核验'}
                  </button>
                </div>
              </section>
            )}

            {illustrationCheckpoint && (
              <IllustrationCheckpointEditor
                detail={selected}
                capabilities={summary.page?.imageCapabilities ?? []}
                toolHealth={toolHealth}
                busy={resolvingIllustration}
                onResolveAgent={onResolveIllustrationAgent}
                onResolveCover={onResolveIllustrationCover}
                key={`${taskId}:${illustrationCheckpoint}:${illustrateStage?.attempt ?? 0}`}
              />
            )}
          </div>
        </details>

        <div className="editor-shell">
          <VideoPreview
            detail={selected}
            reviewPage={reviewPage}
            cueDrafts={cueDrafts}
            preset={settings.subtitlePreset}
            videoRef={videoRef}
            onActiveCueChange={setActiveCueId}
          />

          <aside className="transcript-panel" aria-label={isSummaryTask ? '总结工作区' : '字幕工作区'}>
            <div className="tp-tabs" role="tablist" aria-label="工作台面板">
              {tabs.map((tab) => (
                <button
                  className={`tp-tab ${workspaceTab === tab.id ? 'is-active' : ''}`}
                  id={`workbench-tab-${tab.id}`}
                  role="tab"
                  type="button"
                  aria-controls={`workbench-panel-${tab.id}`}
                  aria-selected={workspaceTab === tab.id}
                  onClick={() => setWorkspaceTab(tab.id)}
                  key={tab.id}
                >
                  {tab.label}
                  {tab.count !== undefined && <span className="n">{tab.count}</span>}
                </button>
              ))}
            </div>

            <div className="transcript-statebar">
              <span className="review-save-state" role="status">
                {isSummaryTask ? selected.manifest.runtime.currentMessage : saveStateText}
              </span>
              {workspaceTab === 'review' && dirtyCount > 0 && (
                <span className="review-inline-actions">
                  <button className="text-button" type="button" disabled={savingCues} onClick={() => onDiscardCues()}>
                    放弃修改
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={savingCues || selectedIsRunning}
                    onClick={() => {
                      void onSaveCues()
                    }}
                  >
                    {autoSaveBlocked ? '重试保存' : '立即保存'}
                  </button>
                </span>
              )}
            </div>

            {reviewError && (
              <p className="review-error transcript-error" role="alert">
                {reviewError}
              </p>
            )}

            {workspaceTab === 'summary' && (
              <section className="transcript-tabpanel summary-panel" id="workbench-panel-summary" role="tabpanel" aria-labelledby="workbench-tab-summary">
                <SummaryPanel taskId={taskId} page={summary.page} error={summary.error} />
              </section>
            )}

            {workspaceTab === 'drafts' && (
              <section className="transcript-tabpanel summary-drafts-panel" id="workbench-panel-drafts" role="tabpanel" aria-labelledby="workbench-tab-drafts">
                <SummaryDraftsPanel page={summary.page} />
              </section>
            )}

            {workspaceTab === 'review' && (
              <section className="transcript-tabpanel review-panel" id="workbench-panel-review" role="tabpanel" aria-labelledby="workbench-tab-review">
                {needsRebuild && (
                  <div className="review-stale-banner" role="status">
                    <Icon name="refresh" />
                    字幕修改已保存，等待重新生成成片。
                  </div>
                )}
                {reviewLoading && <div className="review-placeholder">正在读取字幕…</div>}
                {!reviewLoading && reviewPage?.availability === 'not-ready' && <div className="review-placeholder">{reviewPage.message}</div>}
                {!reviewLoading && reviewPage?.availability === 'ready' && (
                  <>
                    <div className="tp-colhead">
                      <span>
                        英文原文 · {reviewPage.total ? `0:00–${durationLabel(selected.manifest.runtime.durationSeconds)}` : '—'}
                      </span>
                      <span>中文译文 · 简体中文</span>
                    </div>
                    <div className="cue-scroll">
                      {reviewPage.items.map((cue) => {
                        const draft = cueDrafts[cue.cueId]
                        const conflict = cueConflicts[cue.cueId]
                        const changed = draft !== undefined
                        const current = activeCueId === cue.cueId
                        return (
                          <article className={`cue-row ${current ? 'is-current' : ''}`} data-changed={changed || undefined} aria-current={current ? 'true' : undefined} key={cue.cueId}>
                            <button
                              className="cue-source cue-col cue-en-col"
                              type="button"
                              onClick={() => {
                                seekVideo(cue.startMs)
                              }}
                            >
                              <span className="cue-meta">
                                <span className="stamp">
                                  <b>#{cue.cueId}</b>
                                  {reviewTime(cue.startMs)} – {reviewTime(cue.endMs)}
                                </span>
                                <span className="cue-play">
                                  <Icon name="play" />
                                </span>
                              </span>
                              <span className="cue-en">{cue.english}</span>
                            </button>
                            <label className="cue-translation cue-col cue-zh-col">
                              <textarea
                                aria-label={`Cue ${cue.cueId} 中文译文`}
                                disabled={selectedIsRunning}
                                maxLength={2000}
                                value={draft ?? cue.chinese}
                                onChange={(event) => onCueDraftChange(cue.cueId, event.target.value, cue.chinese, cue.english)}
                              />
                              <span className="edit-hint">
                                {changed ? (savingCues ? '正在保存' : autoSaveBlocked ? '保存失败' : '已修改 · 自动保存') : `Cue ${cue.cueId}`}
                              </span>
                              {conflict && (
                                <span className="cue-conflict-baseline" role="status">
                                  最新基线译文：{conflict.chinese}
                                </span>
                              )}
                            </label>
                          </article>
                        )
                      })}
                    </div>
                    <footer className="pagination">
                      <span className="mono">{reviewPage.total ? `${reviewPage.offset + 1}–${Math.min(reviewPage.offset + REVIEW_PAGE_SIZE, reviewPage.total)} / ${reviewPage.total}` : '0 / 0'}</span>
                      <div>
                        <button className="secondary-button" type="button" disabled={reviewOffset === 0 || Boolean(dirtyCount)} onClick={() => onReviewOffsetChange(Math.max(0, reviewOffset - REVIEW_PAGE_SIZE))}>
                          上一页
                        </button>
                        <button className="secondary-button" type="button" disabled={reviewOffset + REVIEW_PAGE_SIZE >= reviewPage.total || Boolean(dirtyCount)} onClick={() => onReviewOffsetChange(reviewOffset + REVIEW_PAGE_SIZE)}>
                          下一页
                        </button>
                      </div>
                    </footer>
                  </>
                )}
              </section>
            )}

            {workspaceTab === 'info' && (
              <section className="transcript-tabpanel task-info-panel" id="workbench-panel-info" role="tabpanel" aria-labelledby="workbench-tab-info">
                <div className="task-info-heading">
                  <span className="kind">{subtitleKindLabel(selected.manifest.runtime.subtitleKind)}</span>
                  <p>{selected.manifest.runtime.currentMessage}</p>
                </div>
                <dl className="inspector-grid">
                  <div>
                    <dt>Provider</dt>
                    <dd>{selectedProvider ? `${providerNames[selectedProvider]} · ${selectedModelLabel}` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>{activeGeneration?.externalSessionId ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>来源</dt>
                    <dd>{taskSource}</dd>
                  </div>
                  <div>
                    <dt>发布时间</dt>
                    <dd>{selected.manifest.runtime.uploadDate ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>画面</dt>
                    <dd>
                      {selected.manifest.runtime.width ?? '—'} × {selected.manifest.runtime.height ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>时长</dt>
                    <dd>{durationLabel(selected.manifest.runtime.durationSeconds)}</dd>
                  </div>
                  <div>
                    <dt>翻译批次</dt>
                    <dd>{translationBatchTotal ? `${verifiedBatchCount} / ${translationBatchTotal} 已验证` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Token</dt>
                    <dd>—</dd>
                  </div>
                  <div>
                    <dt>审计术语</dt>
                    <dd className={reviewPage?.glossaryState === 'ready' ? 'ok' : ''}>{reviewPage?.glossaryState === 'ready' ? `${reviewPage.glossary.length} 条` : reviewPage?.glossaryState === 'empty' ? '审计完成 · 无术语' : '—'}</dd>
                  </div>
                  <div>
                    <dt>B站投稿</dt>
                    <dd className={publication?.status === 'submitted' ? 'ok' : ''}>{publication ? bilibiliPublicationText(selected) : '—'}</dd>
                  </div>
                  {selected.manifest.runtime.finalRelativePath && (
                    <div>
                      <dt>成片</dt>
                      <dd>
                        {selected.taskDirectory}/{selected.manifest.runtime.finalRelativePath}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
            )}

            <section className="transcript-tabpanel workbench-glossary" id="workbench-panel-glossary" role="tabpanel" aria-labelledby="workbench-tab-glossary" hidden={workspaceTab !== 'glossary'}>
                <header className="workbench-glossary-heading">
                  <div>
                    <span className="eyebrow-blue">{reviewPage?.glossaryState === 'ready' ? `${reviewPage.glossary.length} 条术语` : '当前任务审计结果'}</span>
                    <h2>审计术语表</h2>
                    <p>{reviewCheckpoint ? '统一写法修改先保存在本机草稿；预览影响后一次性应用到全部引用 cue，并同步历史术语表。' : '修改会自动保存并同步到历史术语表；引用 cue 保持只读。'}</p>
                  </div>
                </header>
                <div className="workbench-glossary-scroll">
                  {reviewError && !reviewPage ? null : (
                    <AuditGlossary
                      key={`${taskId}:${reviewCheckpoint ? 'manual-review' : 'standard'}`}
                      page={reviewPage}
                      loading={reviewLoading}
                      onSave={onSaveGlossary}
                      onBusyChange={onGlossaryBusyChange}
                      manualReview={reviewCheckpoint}
                      onPreviewImpact={onPreviewGlossaryImpact}
                      onApplyToCues={onApplyGlossaryToCues}
                      onApplied={(result) => {
                        const hasUnmatchedCue = result?.preview.impacts.some((impact) =>
                          impact.cues.some((cue) => !cue.matched && cue.reason === 'target-not-found')) ?? false
                        if (!hasUnmatchedCue) setWorkspaceTab('review')
                      }}
                    />
                  )}
                </div>
            </section>

            {workspaceTab === 'style' && (
              <section className="transcript-tabpanel style-panel" id="workbench-panel-style" role="tabpanel" aria-labelledby="workbench-tab-style">
                <div className="style-heading">
                  <span className="eyebrow-blue">硬字幕预览</span>
                  <h2>字幕字号</h2>
                  <p>只修改当前任务；会立即影响左侧预览，并使成片等待重新压制。</p>
                </div>
                <div className="preset-row" role="group" aria-label="硬字幕字号预设">
                  {(['compact', 'standard', 'large'] as SubtitlePreset[]).map((preset) => (
                    <PresetDemo
                      className="preset-chip"
                      preset={preset}
                      active={settings.subtitlePreset === preset}
                      disabled={!settingsLoaded || savingPreset}
                      onClick={() => {
                        if (settings.subtitlePreset !== preset) void onPreset(preset)
                      }}
                      key={preset}
                    />
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
      <dialog
        className="new-task-dialog companion-dialog"
        ref={companionDialogRef}
        aria-labelledby="companion-dialog-title"
        onClose={() => setCompanionOpen(false)}
      >
        <form
          className="new-task-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (creatingCompanion || !providerAvailability(companionProvider, toolHealth).available) return
            void onCreateCompanion(companionProvider, companionStyleNote).then(() => setCompanionOpen(false))
          }}
        >
          <header className="new-task-heading">
            <div>
              <p className="eyebrow">追加成果</p>
              <h2 id="companion-dialog-title">生成{companionLabel}</h2>
            </div>
            <button className="new-task-close" type="button" aria-label="关闭追加成果" disabled={creatingCompanion} onClick={() => setCompanionOpen(false)}>×</button>
          </header>
          <p className="new-task-copy">同一条视频不需要重新抓取和清理。Etch 会复用已经审计过的英文底稿，只运行新成果需要的阶段。</p>
          <div className="companion-reuse-card">
            <strong><Icon name="check" />直接复用 4 个已完成阶段</strong>
            <div>{SHARED_STAGE_IDS.map((stage) => <span key={stage}>{stageLabels[stage]}</span>)}</div>
            <small>本次只新增 {companionKind === 'summary' ? '素材分析、外部核验、长文整理、配图' : '翻译、术语审计、人工校对、SRT、压制、验证'}</small>
          </div>
          <label className="new-task-field" htmlFor="companion-provider">
            <span>{companionKind === 'summary' ? '总结 Provider' : '翻译 Provider'} <small>{providerAvailability(companionProvider, toolHealth).summary}</small></span>
            <select className="field-select" id="companion-provider" value={companionProvider} disabled={creatingCompanion} onChange={(event) => setCompanionProvider(event.target.value as ProviderId)}>
              {PROVIDER_IDS.map((providerId) => {
                const availability = providerAvailability(providerId, toolHealth)
                return <option value={providerId} disabled={!availability.available} key={providerId}>{providerNames[providerId]}{!availability.available ? `（${availability.summary}）` : ''}</option>
              })}
            </select>
          </label>
          <label className="new-task-field" htmlFor="companion-style-note">
            <span>{companionKind === 'summary' ? '总结要求' : '翻译风格'} <small>选填</small></span>
            <textarea
              className="field-area"
              id="companion-style-note"
              maxLength={1000}
              placeholder={companionKind === 'summary' ? '例如：重点写商业模式与数字，多保留对话锋芒' : '例如：简洁自然，术语沿用统一术语表'}
              value={companionStyleNote}
              disabled={creatingCompanion}
              onChange={(event) => setCompanionStyleNote(event.target.value)}
            />
          </label>
          <footer className="new-task-actions">
            <button className="secondary-button" type="button" disabled={creatingCompanion} onClick={() => setCompanionOpen(false)}>取消</button>
            <button className="primary-button" type="submit" disabled={creatingCompanion || !providerAvailability(companionProvider, toolHealth).available}>
              {creatingCompanion ? '正在复用底稿…' : settings.queuePaused ? `加入暂停队列 · 只跑 ${companionKind === 'summary' ? 4 : 6} 步` : `开始处理 · 只跑 ${companionKind === 'summary' ? 4 : 6} 步`}
            </button>
          </footer>
        </form>
      </dialog>
    </section>
  )
}
