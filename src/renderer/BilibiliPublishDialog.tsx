import { useEffect, useRef, useState } from 'react'
import type { BilibiliAccount, BilibiliCopyright, BilibiliPartition } from '../shared/bilibili'
import type { TaskDetail } from '../shared/ipc'
import type { AppSettings } from '../shared/settings-schema'
import { initialBilibiliPublishForm, publishBilibiliDraftAndRemember, reconcileBilibiliPartitionTid, type BilibiliPublishFormState } from './bilibili-publish-form'
import { loadBilibiliPublishPreferences } from './bilibili-publish-preferences'

interface BilibiliPublishDialogProps {
  task: TaskDetail | undefined
  settings: AppSettings
  account: BilibiliAccount
  open: boolean
  onClose: () => void
  onUpdated: (detail: TaskDetail) => void
}

export function BilibiliPublishDialog({ task, settings, account, open, onClose, onUpdated }: BilibiliPublishDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [form, setForm] = useState<BilibiliPublishFormState>()
  const [partitions, setPartitions] = useState<BilibiliPartition[]>([])
  const [loadingPartitions, setLoadingPartitions] = useState(false)
  const [choosingCover, setChoosingCover] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!open || !task) return
    setForm(initialBilibiliPublishForm(task, settings, loadBilibiliPublishPreferences(() => window.localStorage)))
    setError('')
    const thumbnail = task.manifest.artifacts.thumbnail
    if (thumbnail?.valid) {
      void window.etch.taskThumbnail(task.manifest.taskId, thumbnail.sha256).then((dataUrl) => {
        setForm((current) => current && current.coverRelativePath === thumbnail.relativePath ? { ...current, coverDataUrl: dataUrl } : current)
      }).catch(() => undefined)
    }
  }, [open, task?.manifest.taskId])

  useEffect(() => {
    if (!open || account.status !== 'connected') return
    let cancelled = false
    setPartitions([])
    setLoadingPartitions(true)
    void window.etch.bilibiliPartitions()
      .then((items) => {
        if (cancelled) return
        setPartitions(items)
        setForm((current) => {
          if (!current) return current
          const tid = reconcileBilibiliPartitionTid(
            current.tid,
            items,
            settings.bilibiliPublishTemplate.tid,
            Boolean(task?.manifest.publication.draft)
          )
          return tid === current.tid ? current : { ...current, tid }
        })
      })
      .catch((caught) => {
        if (!cancelled) {
          setPartitions([])
          setForm((current) => current ? { ...current, tid: '' } : current)
          setError(caught instanceof Error ? caught.message : 'B站分区读取失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPartitions(false)
      })
    return () => { cancelled = true }
  }, [open, account.status, account.mid, settings.bilibiliPublishTemplate.tid, task?.manifest.taskId, task?.manifest.publication.draft?.tid])

  const close = (): void => {
    if (submitting || choosingCover) return
    onClose()
  }

  const chooseCover = async (): Promise<void> => {
    if (!task || choosingCover) return
    setChoosingCover(true)
    setError('')
    try {
      const selected = await window.etch.selectBilibiliCover(task.manifest.taskId)
      if (!selected.cancelled && selected.coverRelativePath) {
        setForm((current) => current ? { ...current, coverRelativePath: selected.coverRelativePath, coverDataUrl: selected.dataUrl } : current)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '封面选择失败')
    } finally {
      setChoosingCover(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!task || !form || submitting) return
    if (account.status !== 'connected') {
      setError('请先在设置中扫码连接 B站账号')
      return
    }
    const tags = form.tags.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean)
    if (!form.title.trim()) return setError('请填写投稿标题')
    if (!form.tid) return setError('请选择投稿分区')
    if (!partitions.some((partition) => partition.tid === Number(form.tid))) return setError('请选择有效的投稿分区')
    if (!tags.length) return setError('至少填写一个投稿标签')
    if (form.copyright === 'repost' && !form.source.trim()) return setError('转载稿件必须填写来源')
    const final = task.manifest.artifacts.final
    if (!final?.valid) return setError('当前任务没有可投稿的有效成片')
    setSubmitting(true)
    setError('')
    try {
      const partition = partitions.find((item) => item.tid === Number(form.tid))
      const draft = {
        title: form.title.trim(),
        tid: Number(form.tid),
        partitionName: partition ? `${partition.parentName ? `${partition.parentName} · ` : ''}${partition.name}` : settings.bilibiliPublishTemplate.partitionName,
        tags,
        description: form.description.trim(),
        copyright: form.copyright,
        source: form.copyright === 'repost' ? form.source.trim() : '',
        coverRelativePath: form.coverRelativePath,
        finalSha256: final.sha256
      }
      const detail = await publishBilibiliDraftAndRemember(
        (taskId, publicationDraft) => window.etch.publishToBilibili(taskId, publicationDraft),
        () => window.localStorage,
        task.manifest.taskId,
        draft
      )
      onUpdated(detail)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '投稿启动失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <dialog
      className="bilibili-publish-dialog"
      ref={dialogRef}
      aria-labelledby="bilibili-publish-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onPointerDown={(event) => {
        if (event.currentTarget === event.target) close()
      }}
    >
      {task && form && (
        <form className="bilibili-publish-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
          <header className="new-task-heading">
            <div>
              <p className="eyebrow">本地投稿</p>
              <h2 id="bilibili-publish-title">投稿到 B站</h2>
            </div>
            <button className="new-task-close" type="button" aria-label="关闭 B站投稿" disabled={submitting} onClick={close}>×</button>
          </header>
          <p className="new-task-copy">提交成功后请到 B站创作中心查看审核状态。Etch 不会修改或删除已经提交的稿件。</p>

          <div className="bilibili-publish-grid">
            <label>
              <span>标题 <small>{Array.from(form.title).length} / 80</small></span>
              <input className="field-input" maxLength={80} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
            </label>
            <label>
              <span>分区</span>
              <select className="field-select" disabled={loadingPartitions} value={form.tid} onChange={(event) => setForm({ ...form, tid: event.target.value })}>
                <option value="">{loadingPartitions ? '正在读取分区…' : '请选择分区'}</option>
                {partitions.map((partition) => <option value={partition.tid} key={partition.tid}>{partition.parentName ? `${partition.parentName} · ` : ''}{partition.name}</option>)}
              </select>
            </label>
            <label>
              <span>标签 <small>逗号分隔</small></span>
              <input className="field-input" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
            </label>
            <label>
              <span>版权类型</span>
              <select className="field-select" value={form.copyright} onChange={(event) => setForm({ ...form, copyright: event.target.value as BilibiliCopyright })}>
                <option value="repost">转载</option>
                <option value="original">自制</option>
              </select>
            </label>
            {form.copyright === 'repost' && (
              <label className="bilibili-publish-wide">
                <span>转载来源</span>
                <input className="field-input" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} />
              </label>
            )}
            <label className="bilibili-publish-wide">
              <span>简介 <small>{form.description.length} / 2000</small></span>
              <textarea className="field-area" rows={4} maxLength={2_000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </label>
          </div>

          <div className="bilibili-cover-row">
            <span className="bilibili-cover-preview">
              {form.coverDataUrl ? <img src={form.coverDataUrl} alt="投稿封面预览" /> : <i>默认任务封面</i>}
            </span>
            <span>
              <strong>投稿封面</strong>
              <small>{form.coverRelativePath ?? '没有任务封面，可选择本地图片'}</small>
            </span>
            <button className="secondary-button" type="button" disabled={choosingCover || submitting} onClick={() => { void chooseCover() }}>
              {choosingCover ? '正在选择…' : '更换封面'}
            </button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer className="new-task-actions">
            <button className="secondary-button" type="button" disabled={submitting} onClick={close}>取消</button>
            <button className="primary-button" type="submit" disabled={submitting || loadingPartitions || account.status !== 'connected'}>
              {submitting ? '正在加入投稿队列…' : '确认投稿'}
            </button>
          </footer>
        </form>
      )}
    </dialog>
  )
}
