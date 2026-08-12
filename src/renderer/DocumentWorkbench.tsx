import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { DocumentImageState, DocumentPage, TaskDetail } from '../shared/ipc'
import type { StageId } from '../shared/task-schema'
import { parseSummaryMarkdown, type InlineToken, type SummaryBlock } from './summary-markdown'
import { Icon, providerNames } from './ui'

const DASH = '—'
const DOCUMENT_STAGES = [
  { id: 'source', label: '抓取' },
  { id: 'inspect', label: '正文清洗' },
  { id: 'translate', label: '文档翻译' },
  { id: 'review', label: '文档校对' },
  { id: 'verify', label: '完整性验证' },
] as const satisfies readonly { id: StageId; label: string }[]

type DocumentTab = 'compare' | 'preview' | 'info'
type PendingAction = 'open-source' | 'complete-review' | 'export' | 'start' | 'stop' | 'resolve-cost'
type StageState = TaskDetail['manifest']['pipeline']['stages'][string]

const STAGE_STATUS_LABELS: Record<StageState['status'], string> = {
  pending: '等待中',
  ready: '可处理',
  running: '处理中',
  checkpoint: '待确认',
  failed: '失败',
  paused: '已暂停',
  completed: '已完成',
  stale: '待重建',
  skipped: '已跳过',
}

const SOURCE_KIND_LABELS = {
  web: '普通网页',
  'x-post': 'X 单条帖子',
  'x-article': 'X Article',
} as const

const PROCESSING_MODE_LABELS = {
  auto: '自动判断',
  convert: '转为 Markdown',
  translate: '翻译为中文',
} as const

const editorStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  minHeight: 320,
  maxHeight: 'none',
  resize: 'none',
  border: 0,
  borderRadius: 0,
}

function isStageDone(stage: StageState): boolean {
  return stage.status === 'completed' || stage.status === 'skipped'
}

function stageState(detail: TaskDetail, id: StageId): StageState {
  return detail.manifest.pipeline.stages[id] ?? { status: 'pending', attempt: 0 }
}

function modelLabel(detail: TaskDetail): string {
  const model = detail.manifest.translation.selectedModel
  if (!model) return DASH
  return model.source === 'cli-default' ? 'CLI 默认模型' : model.modelId
}

function inputLabel(detail: TaskDetail): string {
  const input = detail.manifest.input
  return input.kind === 'url' ? input.url : input.sourcePath
}

function sourceUrl(detail: TaskDetail, page?: DocumentPage): string | undefined {
  return page?.metadata?.sourceUrl ?? (detail.manifest.input.kind === 'url' ? detail.manifest.input.url : undefined)
}

function Inline({ tokens }: { tokens: readonly InlineToken[] }): React.JSX.Element {
  return (
    <>
      {tokens.map((token, index) =>
        token.kind === 'strong'
          ? <strong key={index}>{token.text}</strong>
          : token.kind === 'code'
            ? <code key={index}>{token.text}</code>
            : token.kind === 'link'
              ? <a href={token.href} key={index} rel="noreferrer" target="_blank">{token.text}</a>
              : <span key={index}>{token.text}</span>,
      )}
    </>
  )
}

function DocumentImage({ taskId, block, image }: {
  taskId: string
  block: Extract<SummaryBlock, { kind: 'image' }>
  image?: DocumentImageState
}): React.JSX.Element {
  const requestKey = image ? `${taskId}:${image.mediaId}:${image.sha256}` : ''
  const figureRef = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [loaded, setLoaded] = useState<{ key: string; dataUrl: string }>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const node = figureRef.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    setVisible(false)
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      setVisible(true)
      observer.disconnect()
    }, { rootMargin: '240px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [requestKey])

  useEffect(() => {
    setLoaded(undefined)
    setFailed(false)
    if (!image || !visible) {
      return
    }
    let cancelled = false
    void window.etch.documentImage(taskId, image.mediaId, image.sha256).then((value) => {
      if (cancelled) return
      if (value) setLoaded({ key: requestKey, dataUrl: value })
      else setFailed(true)
    }).catch(() => {
      if (!cancelled) setFailed(true)
    })
    return () => { cancelled = true }
  }, [image, requestKey, taskId, visible])

  if (loaded?.key === requestKey) {
    return (
      <figure className="summary-image document-image" ref={figureRef}>
        <img
          src={loaded.dataUrl}
          alt={block.alt || image?.alt || block.filename}
          loading="lazy"
          onError={() => {
            setLoaded(undefined)
            setFailed(true)
          }}
        />
        <figcaption>{block.alt || image?.alt || block.filename}</figcaption>
      </figure>
    )
  }
  return (
    <figure className="summary-image is-pending" ref={figureRef}>
      <div className="summary-image-placeholder">
        <Icon name="empty" />
        <span>{block.alt || block.filename}</span>
        <small>{image ? failed ? '本地图片读取失败' : visible ? '正在读取本地图片…' : '滚动到此处时加载' : '图片未登记或不可用'}</small>
      </div>
    </figure>
  )
}

function MarkdownTable({ block }: { block: Extract<SummaryBlock, { kind: 'table' }> }): React.JSX.Element {
  const headerRows = block.rows.filter((row) => row.header)
  const bodyRows = block.rows.filter((row) => !row.header)
  return (
    <div className="summary-table-scroll">
      <table>
        {headerRows.length > 0 && (
          <thead>
            {headerRows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.cells.map((cell, cellIndex) => <th key={cellIndex}><Inline tokens={cell} /></th>)}</tr>
            ))}
          </thead>
        )}
        {bodyRows.length > 0 && (
          <tbody>
            {bodyRows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.cells.map((cell, cellIndex) => <td key={cellIndex}><Inline tokens={cell} /></td>)}</tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  )
}

function MarkdownArticle({ taskId, markdown, images }: { taskId: string; markdown: string; images: readonly DocumentImageState[] }): React.JSX.Element {
  const imagePaths = useMemo(() => new Set(images.map((image) => image.localPath)), [images])
  const imageByPath = useMemo(() => new Map(images.map((image) => [image.localPath, image])), [images])
  const blocks = useMemo(() => parseSummaryMarkdown(markdown, imagePaths), [imagePaths, markdown])
  if (!markdown.trim()) return <div className="review-placeholder">{DASH}</div>

  return (
    <article className="summary-article">
      {blocks.map((block, index) => {
        if (block.kind === 'image') {
          const image = imageByPath.get(block.filename)
          return <DocumentImage taskId={taskId} block={block} image={image} key={`${taskId}:${image?.mediaId ?? block.filename}:${image?.sha256 ?? index}`} />
        }
        if (block.kind === 'divider') return <hr key={index} />
        if (block.kind === 'heading') {
          const Tag = (block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3') as 'h1' | 'h2' | 'h3'
          return <Tag key={index}><Inline tokens={block.inline} /></Tag>
        }
        if (block.kind === 'quote') return <blockquote key={index}><Inline tokens={block.inline} /></blockquote>
        if (block.kind === 'list') {
          const items = block.items.map((item, itemIndex) => <li key={itemIndex}><Inline tokens={item} /></li>)
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
        }
        if (block.kind === 'table') return <MarkdownTable block={block} key={index} />
        return <p key={index}><Inline tokens={block.inline} /></p>
      })}
    </article>
  )
}

function DocumentPipeline({ detail }: { detail: TaskDetail }): React.JSX.Element {
  const stages = DOCUMENT_STAGES.map((stage) => ({ ...stage, state: stageState(detail, stage.id) }))
  const completed = stages.filter((stage) => isStageDone(stage.state)).length
  const active = stages.find((stage) => ['running', 'checkpoint', 'failed', 'paused', 'stale'].includes(stage.state.status))
  const progress = `${Math.round((completed / DOCUMENT_STAGES.length) * 100)}%`
  const statusText = active?.label ?? (detail.manifest.runtime.currentMessage || DASH)

  return (
    <details className="pipeline-collapse" open>
      <summary>
        <span className="pipeline-chevron"><Icon name="chevron" /></span>
        <span className="pc-title">处理流水线</span>
        <span className="pc-mini">
          <span>{completed} / {DOCUMENT_STAGES.length} · {statusText}</span>
          <span className="mini-bar"><i style={{ width: progress }} /></span>
          {active?.state.status === 'failed' && <span className="error"><Icon name="warning" />处理失败</span>}
        </span>
      </summary>
      <div className="pc-body">
        <div className="pipeline" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <div
            className="rail"
            role="list"
            aria-label="网页翻译阶段"
            style={{ '--rail-columns': DOCUMENT_STAGES.length } as CSSProperties}
          >
            {stages.map((stage, index) => (
              <div
                className="rail-node"
                data-status={stage.state.status}
                data-done={isStageDone(stage.state) || undefined}
                role="listitem"
                key={stage.id}
              >
                <span className="rail-dot">
                  {stage.state.status === 'completed'
                    ? <Icon name="check" />
                    : stage.state.status === 'failed'
                      ? <Icon name="warning" />
                      : String(index + 1).padStart(2, '0')}
                </span>
                <span className="rail-label">{stage.label}</span>
                <span className="rail-sub">{stage.state.errorCode ?? STAGE_STATUS_LABELS[stage.state.status]}</span>
                {stage.state.progress !== undefined && (
                  <span className="rail-progress"><i style={{ width: `${Math.round(stage.state.progress * 100)}%` }} /></span>
                )}
                {stage.state.attempt > 1 && <span className="rail-attempt">×{stage.state.attempt}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </details>
  )
}

export interface DocumentWorkbenchProps {
  detail: TaskDetail
  page?: DocumentPage
  loading?: boolean
  error?: string
  onBack: () => void
  onTranslationDraftChange?: (markdown: string) => void
  onStart?: () => unknown | Promise<unknown>
  onStop?: () => unknown | Promise<unknown>
  onOpenSource?: (taskId: string) => unknown | Promise<unknown>
  onCompleteReview?: (taskId: string, expectedRevision: number) => unknown | Promise<unknown>
  onResolveTranslationCost?: (taskId: string, expectedRevision: number, decision: 'proceed' | 'cancel') => unknown | Promise<unknown>
  onExport?: (taskId: string) => unknown | Promise<unknown>
}

export function DocumentWorkbench({
  detail,
  page,
  loading = false,
  error = '',
  onBack,
  onTranslationDraftChange,
  onStart,
  onStop,
  onOpenSource,
  onCompleteReview,
  onResolveTranslationCost,
  onExport,
}: DocumentWorkbenchProps): React.JSX.Element {
  const taskId = detail.manifest.taskId
  const documentState = detail.manifest.document
  const matchingPage = page?.taskId === taskId ? page : undefined
  const readyPage = matchingPage?.availability === 'ready' ? matchingPage : undefined
  const pageMarkdown = readyPage?.translatedMarkdown ?? ''
  const images = readyPage?.images ?? []
  const [activeTab, setActiveTab] = useState<DocumentTab>('compare')
  const [draft, setDraft] = useState(pageMarkdown)
  const [pendingAction, setPendingAction] = useState<PendingAction>()
  const [actionError, setActionError] = useState('')
  const baselineRef = useRef(pageMarkdown)
  const taskRef = useRef(taskId)

  useEffect(() => {
    const previousBaseline = baselineRef.current
    const taskChanged = taskRef.current !== taskId
    baselineRef.current = pageMarkdown
    taskRef.current = taskId
    setDraft((current) => taskChanged || current === previousBaseline ? pageMarkdown : current)
  }, [taskId, matchingPage?.revision, pageMarkdown])

  useEffect(() => {
    setActiveTab('compare')
    setActionError('')
  }, [taskId])

  const metadata = matchingPage?.metadata
  const verification = matchingPage?.verification
  const resolvedSource = metadata?.contentType ?? documentState.resolvedSource
  const isX = resolvedSource === 'x-post' || resolvedSource === 'x-article'
  const originalUrl = sourceUrl(detail, matchingPage)
  const title = metadata?.sourceTitle.trim() || detail.manifest.title.trim() || DASH
  const failedStage = DOCUMENT_STAGES.find((stage) => stageState(detail, stage.id).status === 'failed')
  const runningStage = DOCUMENT_STAGES.find((stage) => stageState(detail, stage.id).status === 'running')
  const pausedStage = DOCUMENT_STAGES.find((stage) => stageState(detail, stage.id).status === 'paused')
  const checkpointStage = DOCUMENT_STAGES.find((stage) => stageState(detail, stage.id).status === 'checkpoint')
  const costCheckpoint = documentState.translationCostCheckpoint
  const identityError = page && page.taskId !== taskId ? '文档页与当前任务不匹配。' : ''
  const failureMessage = identityError
    || (failedStage ? stageState(detail, failedStage.id).errorCode ?? (detail.manifest.runtime.currentMessage || DASH) : '')
    || (!readyPage ? error.trim() : '')
  const reviewStage = stageState(detail, 'review')
  const verifyStage = stageState(detail, 'verify')
  const reviewCompleted = Boolean(documentState.reviewCompletedAt) || reviewStage.status === 'completed'
  const pageReady = Boolean(readyPage)
  const draftDirty = readyPage ? draft !== readyPage.translatedMarkdown : false
  const pageStale = readyPage ? readyPage.revision !== detail.manifest.revision : false
  const provider = detail.manifest.translation.selectedProvider
  const sourceLanguage = documentState.sourceLanguage ?? DASH
  const convertOnly = documentState.processingMode === 'convert'
    || (documentState.processingMode === 'auto' && /^zh(?:-|$)/iu.test(documentState.sourceLanguage ?? ''))
  const outputLabel = convertOnly ? '成品 Markdown' : '中文译文'
  const sourceKindLabel = resolvedSource ? SOURCE_KIND_LABELS[resolvedSource] : DASH
  const validArtifactCount = Object.values(detail.manifest.artifacts).filter((artifact) => artifact.valid).length
  const artifactCount = Object.keys(detail.manifest.artifacts).length
  const taskRunning = Boolean(runningStage)
  const taskPaused = detail.manifest.runtime.userPaused || Boolean(pausedStage)
  const taskActionLabel = taskRunning
    ? pendingAction === 'stop' ? '正在停止…' : '停止处理'
    : failedStage
      ? pendingAction === 'start' ? '正在重试…' : '重试处理'
      : taskPaused
        ? pendingAction === 'start' ? '正在继续…' : '继续处理'
        : checkpointStage
          ? costCheckpoint ? '等待确认翻译成本' : '等待完成校对'
          : verifyStage.status === 'completed'
            ? '处理已完成'
            : pendingAction === 'start' ? '正在开始…' : '开始处理'
  const taskActionDisabled = Boolean(pendingAction)
    || (taskRunning ? !onStop : Boolean(checkpointStage) || verifyStage.status === 'completed' || !onStart)
  const reviewStatusMessage = reviewCompleted
    ? documentState.reviewCompletedAt ?? STAGE_STATUS_LABELS[reviewStage.status]
    : !verification
      ? '完整性检查尚未生成，暂不能完成校对。'
      : !verification.valid
        ? '完整性检查未通过，请先处理检查结果。'
        : draftDirty
          ? `${outputLabel}修改尚未写回任务，保存后才能完成校对。`
          : pageStale
            ? '文档页 revision 已过期，请刷新后继续。'
            : '检查已通过，可以完成校对。'

  const runAction = async (kind: PendingAction, action: () => unknown | Promise<unknown>): Promise<void> => {
    setPendingAction(kind)
    setActionError('')
    try {
      await action()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPendingAction(undefined)
    }
  }

  const tabs: readonly { id: DocumentTab; label: string }[] = [
    { id: 'compare', label: '对照校对' },
    { id: 'preview', label: convertOnly ? '成品预览' : '中文预览' },
    { id: 'info', label: '任务信息' },
  ]
  const tabPrefix = `document-${taskId}`

  return (
    <section className="workbench-view document-workbench" aria-busy={loading || Boolean(pendingAction)}>
      <header className="wb-header">
        <button className="back-link" type="button" onClick={onBack}>
          <Icon name="back" /> 返回任务列表
        </button>
        <div className="wb-title-row">
          <div>
            <span className="provider-tag">{convertOnly ? '无需 Provider' : provider ? providerNames[provider] : DASH} · 网页翻译</span>
            <h1>{title}</h1>
            <code className="task-source">
              <Icon name={detail.manifest.input.kind === 'url' ? 'link' : 'local'} />
              <span>{originalUrl ?? (inputLabel(detail) || DASH)}</span>
            </code>
          </div>
          <div className="wb-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={!originalUrl || !onOpenSource || Boolean(pendingAction)}
              onClick={() => {
                if (onOpenSource) void runAction('open-source', () => onOpenSource(taskId))
              }}
            >
              <Icon name="link" />
              {pendingAction === 'open-source' ? '正在打开…' : '打开原网页'}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={verifyStage.status !== 'completed' || !verification?.valid || !onExport || Boolean(pendingAction)}
              onClick={() => {
                if (onExport) void runAction('export', () => onExport(taskId))
              }}
            >
              <Icon name="folder" />
              {pendingAction === 'export' ? '正在导出…' : '导出 Markdown'}
            </button>
            <button
              className={taskRunning ? 'danger-button wb-stop-button' : 'primary-button'}
              type="button"
              disabled={taskActionDisabled}
              onClick={() => {
                if (taskRunning && onStop) void runAction('stop', onStop)
                else if (onStart) void runAction('start', onStart)
              }}
            >
              {taskRunning
                ? <Icon name="pause" />
                : (failedStage || taskPaused) && <Icon name="refresh" />}
              {taskActionLabel}
            </button>
          </div>
        </div>
      </header>

      {(actionError || (readyPage && error.trim())) && <p className="task-action-error" role="alert">{actionError || error}</p>}

      <div className="workbench">
        <DocumentPipeline detail={detail} />

        {costCheckpoint && (
          <section className="audit-checkpoint" role="region" aria-labelledby={`${tabPrefix}-cost-title`}>
            <div className="head"><Icon name="warning" /><span id={`${tabPrefix}-cost-title`}>长文翻译需要确认成本</span></div>
            <p className="illustration-copy">正文共 {costCheckpoint.characterCount.toLocaleString('zh-CN')} 个字符，需要 {costCheckpoint.batchCount} 个翻译批次。确认后会按批次持久保存，失败重试不会重跑已验证批次。</p>
            <div className="audit-actions">
              <button className="secondary-button" type="button" disabled={Boolean(pendingAction)} onClick={() => {
                if (onResolveTranslationCost) void runAction('resolve-cost', () => onResolveTranslationCost(taskId, detail.manifest.revision, 'cancel'))
              }}>暂停任务</button>
              <button className="primary-button" type="button" disabled={!onResolveTranslationCost || Boolean(pendingAction)} onClick={() => {
                if (onResolveTranslationCost) void runAction('resolve-cost', () => onResolveTranslationCost(taskId, detail.manifest.revision, 'proceed'))
              }}>{pendingAction === 'resolve-cost' ? '正在提交…' : '确认成本并开始'}</button>
            </div>
          </section>
        )}

        {failureMessage ? (
          <section className="audit-checkpoint document-failure" role="alert" aria-labelledby={`${tabPrefix}-failure-title`}>
            <div className="head">
              <Icon name="warning" />
              <span id={`${tabPrefix}-failure-title`}>{failedStage ? `${failedStage.label}失败` : '文档读取失败'}</span>
            </div>
            <p className="task-action-error">{failureMessage || DASH}</p>
            <dl className="inspector-grid">
              <div><dt>原始 URL</dt><dd>{originalUrl ?? DASH}</dd></div>
              <div><dt>失败阶段</dt><dd>{failedStage?.label ?? DASH}</dd></div>
              <div><dt>错误码</dt><dd>{failedStage ? stageState(detail, failedStage.id).errorCode ?? DASH : DASH}</dd></div>
              <div><dt>任务 revision</dt><dd>{detail.manifest.revision}</dd></div>
            </dl>
          </section>
        ) : (
          <div className="editor-shell document-editor-shell" style={{ minHeight: 0, gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <section className="transcript-panel document-panel" aria-label="网页翻译工作台">
              <div className="tp-tabs" role="tablist" aria-label="文档工作台面板">
                {tabs.map((tab) => (
                  <button
                    className={`tp-tab ${activeTab === tab.id ? 'is-active' : ''}`}
                    id={`${tabPrefix}-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-controls={`${tabPrefix}-panel-${tab.id}`}
                    aria-selected={activeTab === tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    key={tab.id}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="transcript-statebar">
                <span className="review-save-state" role="status">
                  {!pageReady
                    ? DASH
                    : pageStale
                      ? `页面 revision ${readyPage?.revision ?? DASH} · 任务 revision ${detail.manifest.revision}`
                      : draftDirty
                        ? `${outputLabel}有未保存修改`
                        : `已载入 revision ${readyPage?.revision ?? DASH}`}
                </span>
                <span className="mono">{sourceKindLabel}</span>
              </div>

              {loading && <div className="review-placeholder">正在读取文档…</div>}
              {!loading && !page && <div className="review-placeholder">{DASH}</div>}
              {!loading && matchingPage?.availability === 'not-ready' && <div className="review-placeholder">{matchingPage.message ?? DASH}</div>}

              {!loading && pageReady && activeTab === 'compare' && (
                <section
                  className="transcript-tabpanel review-panel document-compare"
                  id={`${tabPrefix}-panel-compare`}
                  role="tabpanel"
                  aria-labelledby={`${tabPrefix}-tab-compare`}
                >
                  <div className="tp-colhead">
                    <span>原文 · {sourceLanguage}</span>
                    <span>{convertOnly ? '成品' : '译文'} · {convertOnly ? 'Markdown' : documentState.targetLanguage}</span>
                  </div>
                  <div className="editor-shell document-columns" style={{ minHeight: 0 }}>
                    <section className="transcript-panel document-pane" aria-label="原文 Markdown">
                      <textarea
                        className="field-area mono"
                        aria-label="原文 Markdown"
                        readOnly
                        spellCheck={false}
                        value={readyPage?.sourceMarkdown || DASH}
                        style={editorStyle}
                      />
                    </section>
                    <section className="transcript-panel document-pane" aria-label={outputLabel}>
                      <textarea
                        className="field-area mono"
                        aria-label={outputLabel}
                        maxLength={5_000_000}
                        placeholder={DASH}
                        readOnly={!onTranslationDraftChange || reviewCompleted}
                        spellCheck={false}
                        value={draft}
                        style={editorStyle}
                        onChange={(event) => {
                          const next = event.currentTarget.value
                          setDraft(next)
                          onTranslationDraftChange?.(next)
                        }}
                      />
                    </section>
                  </div>
                  <footer className="review-checkpoint-banner">
                    <div className="review-checkpoint-copy">
                      <span className="review-checkpoint-icon"><Icon name={reviewCompleted ? 'check' : 'warning'} /></span>
                      <div>
                        <strong>{reviewCompleted ? '校对已完成' : '校对 checkpoint'}</strong>
                        <span>{reviewStatusMessage}</span>
                      </div>
                    </div>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={
                        reviewCompleted
                        || draftDirty
                        || pageStale
                        || !draft.trim()
                        || !verification?.valid
                        || !onCompleteReview
                        || Boolean(pendingAction)
                      }
                      onClick={() => {
                        if (onCompleteReview) {
                          void runAction('complete-review', () => onCompleteReview(taskId, detail.manifest.revision))
                        }
                      }}
                    >
                      <Icon name="check" />
                      {pendingAction === 'complete-review' ? '正在确认…' : reviewCompleted ? '校对已完成' : '完成校对'}
                    </button>
                  </footer>
                </section>
              )}

              {!loading && pageReady && activeTab === 'preview' && (
                <section
                  className="transcript-tabpanel summary-panel"
                  id={`${tabPrefix}-panel-preview`}
                  role="tabpanel"
                  aria-labelledby={`${tabPrefix}-tab-preview`}
                >
                  <div className="summary-panel-body">
                    <MarkdownArticle taskId={taskId} markdown={draft} images={images} />
                  </div>
                </section>
              )}

              {!loading && pageReady && activeTab === 'info' && (
                <section
                  className="transcript-tabpanel task-info-panel"
                  id={`${tabPrefix}-panel-info`}
                  role="tabpanel"
                  aria-labelledby={`${tabPrefix}-tab-info`}
                >
                  <div className="task-info-heading">
                    <span className="kind">{sourceKindLabel}</span>
                    <p>{detail.manifest.runtime.currentMessage || DASH}</p>
                  </div>
                  <dl className="inspector-grid">
                    <div><dt>内容类型</dt><dd>{sourceKindLabel}</dd></div>
                    <div><dt>来源 URL</dt><dd>{originalUrl ?? DASH}</dd></div>
                    <div><dt>站点</dt><dd>{metadata?.siteName ?? DASH}</dd></div>
                    <div><dt>作者</dt><dd>{metadata?.author ?? DASH}</dd></div>
                    <div><dt>X 账号</dt><dd>{metadata?.screenName ? (metadata.screenName.startsWith('@') ? metadata.screenName : `@${metadata.screenName}`) : DASH}</dd></div>
                    <div><dt>发布时间</dt><dd>{metadata?.publishedAt ?? DASH}</dd></div>
                    <div><dt>处理方式</dt><dd>{PROCESSING_MODE_LABELS[documentState.processingMode]}</dd></div>
                    <div><dt>来源语言</dt><dd>{sourceLanguage}</dd></div>
                    <div><dt>目标语言</dt><dd>{convertOnly ? '保持原语言' : documentState.targetLanguage}</dd></div>
                    <div><dt>Provider</dt><dd>{convertOnly ? '无需 Provider' : provider ? providerNames[provider] : DASH}</dd></div>
                    <div><dt>模型</dt><dd>{convertOnly ? '无需模型' : modelLabel(detail)}</dd></div>
                    <div><dt>{convertOnly ? '处理要求' : '翻译要求'}</dt><dd>{detail.manifest.translation.styleNote || DASH}</dd></div>
                    <div><dt>原文 blocks</dt><dd>{verification?.sourceBlocks ?? documentState.blockCount}</dd></div>
                    <div><dt>{convertOnly ? '成品' : '译文'} blocks</dt><dd>{verification?.translatedBlocks ?? documentState.translatedBlockCount}</dd></div>
                    <div><dt>标题结构</dt><dd>{verification ? `${verification.translatedHeadings} / ${verification.sourceHeadings}` : DASH}</dd></div>
                    <div><dt>本地媒体</dt><dd>{verification ? `${verification.localizedMedia} / ${verification.expectedMedia}` : metadata ? `${metadata.mediaLocalized} / ${metadata.mediaExpected}` : DASH}</dd></div>
                    <div><dt>完整性验证</dt><dd className={verification?.valid ? 'ok' : ''}>{verification ? (verification.valid ? '通过' : '未通过') : DASH}</dd></div>
                    <div><dt>校对完成</dt><dd className={reviewCompleted ? 'ok' : ''}>{documentState.reviewCompletedAt ?? (reviewCompleted ? STAGE_STATUS_LABELS[reviewStage.status] : DASH)}</dd></div>
                    <div><dt>Artifacts</dt><dd>{validArtifactCount} / {artifactCount} 有效</dd></div>
                    <div><dt>Task ID</dt><dd>{taskId}</dd></div>
                    <div><dt>Revision</dt><dd>{detail.manifest.revision}</dd></div>
                    <div><dt>更新时间</dt><dd>{detail.manifest.updatedAt || DASH}</dd></div>
                  </dl>

                  {isX && (
                    <>
                      <div className="task-info-heading">
                        <span className="kind">X 互动快照</span>
                        <p>{metadata?.publishedAt ?? DASH}</p>
                      </div>
                      <dl className="inspector-grid">
                        <div><dt>回复</dt><dd>{metadata?.engagement?.replies?.toLocaleString('zh-CN') ?? DASH}</dd></div>
                        <div><dt>转帖</dt><dd>{metadata?.engagement?.retweets?.toLocaleString('zh-CN') ?? DASH}</dd></div>
                        <div><dt>喜欢</dt><dd>{metadata?.engagement?.likes?.toLocaleString('zh-CN') ?? DASH}</dd></div>
                        <div><dt>书签</dt><dd>{metadata?.engagement?.bookmarks?.toLocaleString('zh-CN') ?? DASH}</dd></div>
                        <div><dt>浏览</dt><dd>{metadata?.engagement?.views?.toLocaleString('zh-CN') ?? DASH}</dd></div>
                      </dl>
                    </>
                  )}
                </section>
              )}
            </section>
          </div>
        )}
      </div>
    </section>
  )
}
