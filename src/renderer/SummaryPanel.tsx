import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ImageCapabilityInfo, SummaryPage, TaskDetail, ToolHealthSnapshot } from '../shared/ipc'
import { SUMMARY_DRAFT_IDS, SUMMARY_SCORE_KEYS, SUMMARY_SCORE_LABELS, summaryImageArtifactKey, type ModelSelection, type ProviderId } from '../shared/task-schema'
import { providerAvailability } from './provider-availability'
import { parseSummaryMarkdown, type InlineToken, type SummaryBlock } from './summary-markdown'
import { Icon, providerNames } from './ui'

type IllustrationChoice =
  | { mode: 'generate'; provider: ProviderId; model: ModelSelection }
  | { mode: 'skip' }

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

function SummaryTable({ block }: { block: Extract<SummaryBlock, { kind: 'table' }> }): React.JSX.Element {
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

function SummaryImage({
  taskId,
  block,
  page,
}: {
  taskId: string
  block: Extract<SummaryBlock, { kind: 'image' }>
  page: SummaryPage
}): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState<string>()
  const state = page.images.find((image) => image.filename === block.filename)
  const sha256 = state?.sha256

  useEffect(() => {
    if (!sha256) {
      setDataUrl(undefined)
      return
    }
    let cancelled = false
    void window.etch.summaryImage(taskId, block.filename, sha256).then((value) => {
      if (!cancelled) setDataUrl(value)
    }).catch(() => {
      if (!cancelled) setDataUrl(undefined)
    })
    return () => { cancelled = true }
  }, [taskId, block.filename, sha256])

  if (!sha256 || !dataUrl) {
    return (
      <figure className="summary-image is-pending">
        <div className="summary-image-placeholder">
          <Icon name="empty" />
          <span>{block.alt || block.filename}</span>
          <small>{state?.reason ?? '待生成'}</small>
        </div>
      </figure>
    )
  }
  return (
    <figure className="summary-image">
      <img src={dataUrl} alt={block.alt || block.filename} />
      <figcaption>{block.alt || block.filename}</figcaption>
    </figure>
  )
}

function SummaryBody({ taskId, page }: { taskId: string; page: SummaryPage }): React.JSX.Element {
  const blocks = useMemo(() => parseSummaryMarkdown(page.markdown), [page.markdown])
  return (
    <article className="summary-article">
      {blocks.map((block, index) => {
        if (block.kind === 'image') return <SummaryImage taskId={taskId} block={block} page={page} key={index} />
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
        if (block.kind === 'table') return <SummaryTable block={block} key={index} />
        return <p key={index}><Inline tokens={block.inline} /></p>
      })}
    </article>
  )
}

export function useSummaryPage(taskId: string | undefined, revision: number): { page?: SummaryPage; error: string } {
  const [page, setPage] = useState<SummaryPage>()
  const [error, setError] = useState('')

  useEffect(() => {
    if (!taskId) {
      setPage(undefined)
      return
    }
    let cancelled = false
    void window.etch.summaryPage(taskId).then((value) => {
      if (cancelled) return
      setPage(value)
      setError('')
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [taskId, revision])

  return { page, error }
}

export function SummaryPanel({ taskId, page, error }: { taskId: string; page?: SummaryPage; error: string }): React.JSX.Element {
  const [exportNotice, setExportNotice] = useState('')
  const [exporting, setExporting] = useState(false)

  const exportSummary = useCallback(async () => {
    setExporting(true)
    setExportNotice('')
    try {
      const result = await window.etch.exportSummary(taskId)
      setExportNotice(result.cancelled ? '' : `已导出到 ${result.directory}，含 ${result.images} 张配图`)
    } catch (reason) {
      setExportNotice(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setExporting(false)
    }
  }, [taskId])

  if (error) return <p className="review-error transcript-error" role="alert">{error}</p>
  if (!page) return <div className="review-placeholder">正在读取总结…</div>
  if (page.availability === 'not-ready') return <div className="review-placeholder">{page.message}</div>
  const pending = page.images.filter((image) => image.status === 'pending')

  return (
    <div className="summary-panel-body">
      <div className="summary-toolbar">
        <span className="summary-image-state" role="status">
          配图 {page.images.length - pending.length} / {page.images.length}
          {pending.length ? ` · ${pending.length} 张待补` : ''}
        </span>
      </div>
      {exportNotice && <p className="summary-notice" role="status">{exportNotice}</p>}
      <SummaryBody taskId={taskId} page={page} />
      {pending.length > 0 && (
        <section className="summary-pending" aria-label="待补配图">
          <h3>待补配图</h3>
          <ul>
            {pending.map((image) => (
              <li key={image.filename}>
                <strong>{image.filename}</strong>
                <span>{image.alt}</span>
                <small>{image.reason}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      <footer className="summary-actions">
        <button className="secondary-button" type="button" onClick={() => { void window.etch.revealTask(taskId) }}>
          在 Finder 中显示
        </button>
        <button className="primary-button" type="button" disabled={exporting} onClick={() => { void exportSummary() }}>
          {exporting ? '正在导出…' : '导出总结'}
        </button>
      </footer>
    </div>
  )
}

export function SummaryDraftsPanel({ page }: { page?: SummaryPage }): React.JSX.Element {
  const record = page?.draftRecord
  if (!record) return <div className="review-placeholder">三稿执行记录还没生成。</div>
  return (
    <div className="summary-drafts">
      <section>
        <h3>素材分析包</h3>
        <p>{record.analysisNote}</p>
      </section>
      <section>
        <h3>评分表</h3>
        <table className="summary-score-table">
          <thead>
            <tr>
              <th>稿</th>
              {SUMMARY_SCORE_KEYS.map((key) => <th key={key}>{SUMMARY_SCORE_LABELS[key]}</th>)}
              <th>总分</th>
            </tr>
          </thead>
          <tbody>
            {SUMMARY_DRAFT_IDS.map((id) => {
              const score = record.scores[id]
              const total = score ? SUMMARY_SCORE_KEYS.reduce((sum, key) => sum + score[key], 0) : 0
              return (
                <tr key={id} data-base={record.baseDraft === id ? 'true' : undefined}>
                  <th scope="row">{id}{record.baseDraft === id ? '（底稿）' : ''}</th>
                  {SUMMARY_SCORE_KEYS.map((key) => <td key={key}>{score ? score[key] : '—'}</td>)}
                  <td>{total}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p>{record.baseReason}</p>
      </section>
      <section>
        <h3>候选稿证据</h3>
        {record.drafts.map((draft) => (
          <article className="summary-draft" key={draft.id}>
            <h4>候选稿 {draft.id}：{draft.title}</h4>
            <p><b>章节</b>：{draft.sections.join(' / ')}</p>
            <p><b>开场主线</b>：{draft.opening}</p>
            <p><b>最后评论判断</b>：{draft.finalThesis}</p>
            <ul>{draft.contributions.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </article>
        ))}
      </section>
      <section>
        <h3>遗漏清单</h3>
        {record.omissions.length
          ? <ul>{record.omissions.map((item, index) => <li key={index}>{item}</li>)}</ul>
          : <p>{record.omissionNote || '（空）'}</p>}
      </section>
      <section>
        <h3>终稿自检</h3>
        <p>{record.selfCheck}</p>
      </section>
    </div>
  )
}

interface IllustrationCheckpointEditorProps {
  detail: TaskDetail
  capabilities: readonly ImageCapabilityInfo[]
  toolHealth: readonly ToolHealthSnapshot[]
  busy: boolean
  onResolveAgent: (choice: IllustrationChoice) => Promise<void>
  onResolveCover: (decision: 'accept' | 'retry-with-agent' | 'skip') => Promise<void>
}

export function IllustrationCheckpointEditor({
  detail,
  capabilities,
  toolHealth,
  busy,
  onResolveAgent,
  onResolveCover,
}: IllustrationCheckpointEditorProps): React.JSX.Element | null {
  const stage = detail.manifest.pipeline.stages.illustrate
  const checkpointId = stage?.status === 'checkpoint' ? stage.checkpointId : undefined
  // 有图像能力不等于本机 CLI 就绪，两者都满足才能选。
  const options = capabilities.map((capability) => {
    const cli = providerAvailability(capability.provider, toolHealth)
    return {
      ...capability,
      selectable: capability.available && cli.available,
      note: !capability.available
        ? capability.reason ?? '不具备配图能力'
        : cli.available
          ? cli.summary ?? '已就绪'
          : `CLI 不可用：${cli.summary ?? '环境尚未检测'}`,
    }
  })
  const available = options.filter((option) => option.selectable)
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>()
  const provider = selectedProvider ?? available[0]?.provider
  const [modelId, setModelId] = useState('')
  const [coverCollapsed, setCoverCollapsed] = useState(false)
  const coverSha = detail.manifest.artifacts[summaryImageArtifactKey('00-cover.png')]?.sha256
  const [coverUrl, setCoverUrl] = useState<string>()
  const [coverState, setCoverState] = useState<'loading' | 'ready' | 'error'>('loading')
  const taskId = detail.manifest.taskId

  useEffect(() => {
    let cancelled = false
    if (checkpointId !== 'illustration-cover' || !coverSha) {
      setCoverUrl(undefined)
      setCoverState('loading')
      return () => { cancelled = true }
    }
    setCoverUrl(undefined)
    setCoverState('loading')
    void window.etch.summaryImage(taskId, '00-cover.png', coverSha)
      .then((url) => {
        if (cancelled) return
        setCoverUrl(url)
        if (!url) setCoverState('error')
      })
      .catch(() => {
        if (cancelled) return
        setCoverUrl(undefined)
        setCoverState('error')
      })
    return () => { cancelled = true }
  }, [checkpointId, coverSha, taskId])

  if (!checkpointId) return null

  if (checkpointId === 'illustration-agent') {
    return (
      <section className="audit-checkpoint illustration-checkpoint" role="region" aria-labelledby="illustration-title" aria-busy={busy}>
        <div className="head">
          <Icon name="warning" />
          <span id="illustration-title">配图需要具备图像生成能力的 agent，请确认并选择</span>
        </div>
        <p className="illustration-copy">
          Etch 的翻译与写作调用是纯文本隔离的；只有你在这里显式选定的 agent 会被允许调用图像生成工具，并且只能往本次配图目录写文件。
        </p>
        <div className="illustration-providers" role="radiogroup" aria-label="配图 agent">
          {options.map((option) => (
            <label className="illustration-provider" data-disabled={option.selectable ? undefined : 'true'} key={option.provider}>
              <input
                type="radio"
                name="illustration-provider"
                value={option.provider}
                checked={provider === option.provider}
                disabled={busy || !option.selectable}
                onChange={() => setSelectedProvider(option.provider)}
              />
              <span>
                <strong>{providerNames[option.provider]}</strong>
                <small>{option.note}</small>
              </span>
            </label>
          ))}
        </div>
        <label className="illustration-model" htmlFor="illustration-model">
          <span>模型 <small>留空使用 CLI 默认模型</small></span>
          <input
            className="field-input"
            id="illustration-model"
            value={modelId}
            disabled={busy || !provider}
            placeholder="例如 claude-sonnet-4-5"
            onChange={(event) => setModelId(event.target.value)}
          />
        </label>
        <div className="audit-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={() => { void onResolveAgent({ mode: 'skip' }) }}>
            跳过配图
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || !provider}
            onClick={() => {
              if (!provider) return
              void onResolveAgent({
                mode: 'generate',
                provider,
                model: modelId.trim() ? { source: 'user-entered', modelId: modelId.trim() } : { source: 'cli-default' },
              })
            }}
          >
            {busy ? '正在提交…' : '确认并生成封面试片'}
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="audit-checkpoint illustration-checkpoint" role="region" aria-labelledby="illustration-cover-title" aria-busy={busy}>
      <div className="head">
        <Icon name="warning" />
        <span id="illustration-cover-title">封面已生成，请验收后决定是否生成其余配图</span>
        <button
          className="illustration-collapse"
          type="button"
          aria-controls="illustration-cover-body"
          aria-expanded={!coverCollapsed}
          onClick={() => setCoverCollapsed((collapsed) => !collapsed)}
        >
          <span>{coverCollapsed ? '展开配图' : '收起配图'}</span>
          <Icon name="chevron" />
        </button>
      </div>
      <div id="illustration-cover-body" hidden={coverCollapsed}>
        <div className="illustration-cover">
          {coverUrl
            ? <img
                key={coverSha}
                src={coverUrl}
                alt="封面试片"
                onLoad={() => setCoverState('ready')}
                onError={() => setCoverState('error')}
              />
            : <div className="summary-image-placeholder"><Icon name="empty" /><span>{coverState === 'error' ? '封面读取或解码失败' : '正在读取封面…'}</span></div>}
          <ul className="illustration-cover-checklist">
            <li>暖白纸面、明亮背景，不是暗色或霓虹</li>
            <li>手绘马克笔轮廓与铅笔排线，不是 3D 或摄影</li>
            <li>中文手写大标题 + 红色下划线 + 3-6 个可读短标签</li>
            <li>一眼能解释全篇主线</li>
          </ul>
        </div>
        <div className="audit-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={() => { void onResolveCover('skip') }}>
            跳过剩余配图
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => { void onResolveCover('retry-with-agent') }}>
            换 agent 重做封面
          </button>
          <button className="primary-button" type="button" disabled={busy || coverState !== 'ready'} onClick={() => { void onResolveCover('accept') }}>
            {busy ? '正在提交…' : '接受并生成其余配图'}
          </button>
        </div>
      </div>
    </section>
  )
}
