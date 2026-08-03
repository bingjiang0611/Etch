import { useEffect, useRef, useState } from 'react'
import type { BilibiliAccount, BilibiliPartition, BilibiliQrState } from '../shared/bilibili'
import type { AppSettings } from '../shared/settings-schema'

interface BilibiliSettingsCardProps {
  account: BilibiliAccount
  settings: AppSettings
  disabled: boolean
  onAccountChange: (account: BilibiliAccount) => void
  onSettingsChange: (settings: AppSettings) => void
}

export function BilibiliSettingsCard({ account, settings, disabled, onAccountChange, onSettingsChange }: BilibiliSettingsCardProps): React.JSX.Element {
  const [partitions, setPartitions] = useState<BilibiliPartition[]>([])
  const [partitionsLoading, setPartitionsLoading] = useState(false)
  const [qrState, setQrState] = useState<BilibiliQrState>()
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const qrDialogRef = useRef<HTMLDialogElement>(null)
  const template = settings.bilibiliPublishTemplate

  useEffect(() => {
    const dialog = qrDialogRef.current
    if (!dialog) return
    if (qrState && !dialog.open) dialog.showModal()
    if (!qrState && dialog.open) dialog.close()
  }, [qrState])

  useEffect(() => {
    if (account.status !== 'connected') {
      setPartitions([])
      return
    }
    let cancelled = false
    setPartitionsLoading(true)
    setError('')
    void window.etch.bilibiliPartitions()
      .then((items) => {
        if (!cancelled) setPartitions(items)
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'B站分区读取失败')
      })
      .finally(() => {
        if (!cancelled) setPartitionsLoading(false)
      })
    return () => { cancelled = true }
  }, [account.status, account.mid])

  useEffect(() => {
    if (!qrState || !['waiting', 'scanned'].includes(qrState.status)) return
    const timer = window.setInterval(() => {
      void window.etch.pollBilibiliQrLogin(qrState.sessionId)
        .then((next) => {
          setQrState(next)
          if (next.account) onAccountChange(next.account)
        })
        .catch((caught) => setQrState((current) => current ? { ...current, status: 'failed', message: caught instanceof Error ? caught.message : '扫码状态读取失败' } : current))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [qrState?.sessionId, qrState?.status, onAccountChange])

  const connect = async (): Promise<void> => {
    if (connecting) return
    setConnecting(true)
    setError('')
    try {
      setQrState(await window.etch.startBilibiliQrLogin())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法获取 B站登录二维码')
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    if (disconnecting) return
    setDisconnecting(true)
    setError('')
    try {
      onAccountChange(await window.etch.disconnectBilibili())
      setQrState(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'B站账号退出失败')
    } finally {
      setDisconnecting(false)
    }
  }

  const updateTemplate = (next: Partial<AppSettings['bilibiliPublishTemplate']>): void => {
    onSettingsChange({ ...settings, bilibiliPublishTemplate: { ...template, ...next } })
  }

  return (
    <>
      <section className="panel settings-card bilibili-settings-card">
        <div className="settings-card-heading">
          <div>
            <h2>B站投稿</h2>
            <p>普通 B站账号扫码登录；凭证由 macOS 安全存储加密，只在本机调用内置 biliup。</p>
          </div>
          {account.status === 'connected' ? (
            <button className="secondary-button" type="button" disabled={disabled || disconnecting} onClick={() => { void disconnect() }}>
              {disconnecting ? '正在退出…' : '退出登录'}
            </button>
          ) : (
            <button className="primary-button" type="button" disabled={disabled || connecting} onClick={() => { void connect() }}>
              {connecting ? '正在获取二维码…' : account.status === 'expired' ? '重新扫码' : '扫码登录'}
            </button>
          )}
        </div>

        <div className="bilibili-account" data-status={account.status}>
          <span className="bilibili-avatar" aria-hidden="true">
            {account.avatarDataUrl ? <img src={account.avatarDataUrl} alt="" /> : account.name?.trim().slice(0, 1) || 'B'}
          </span>
          <span>
            <strong>{account.status === 'connected' ? account.name : account.status === 'expired' ? '登录已失效' : '尚未连接 B站'}</strong>
            <small>{account.mid ? `UID ${account.mid}` : account.message ?? '连接后可手动投稿，并配置任务完成后自动投稿。'}</small>
          </span>
          <i>{account.status === 'connected' ? '已连接' : account.status === 'expired' ? '需重新登录' : '未连接'}</i>
        </div>

        <div className="bilibili-template-grid" aria-disabled={account.status !== 'connected'}>
          <label>
            <span>默认分区</span>
            <select
              className="field-select"
              disabled={disabled || account.status !== 'connected' || partitionsLoading}
              value={template.tid ?? ''}
              onChange={(event) => {
                const tid = Number(event.target.value)
                const partition = partitions.find((item) => item.tid === tid)
                updateTemplate({ tid: tid || undefined, partitionName: partition ? `${partition.parentName ? `${partition.parentName} · ` : ''}${partition.name}` : '' })
              }}
            >
              <option value="">{partitionsLoading ? '正在读取分区…' : '请选择投稿分区'}</option>
              {partitions.map((partition) => (
                <option value={partition.tid} key={partition.tid}>{partition.parentName ? `${partition.parentName} · ` : ''}{partition.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>默认标签 <small>逗号分隔，至少一个</small></span>
            <input
              className="field-input"
              disabled={disabled || account.status !== 'connected'}
              value={template.tags.join(', ')}
              placeholder="字幕, 双语, 视频"
              onChange={(event) => updateTemplate({ tags: event.target.value.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean).slice(0, 10) })}
            />
          </label>
          <label className="bilibili-description-template">
            <span>默认简介 <small>支持 {'{title}'} 与 {'{source_url}'}</small></span>
            <textarea
              className="field-area"
              disabled={disabled || account.status !== 'connected'}
              maxLength={2_000}
              value={template.descriptionTemplate}
              onChange={(event) => updateTemplate({ descriptionTemplate: event.target.value })}
            />
          </label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>

      <dialog
        className="bilibili-qr-dialog"
        ref={qrDialogRef}
        aria-labelledby="bilibili-qr-title"
        onCancel={(event) => {
          event.preventDefault()
          if (!connecting) setQrState(undefined)
        }}
      >
        <section className="bilibili-qr-panel">
          <header>
            <div>
              <p className="eyebrow">账号连接</p>
              <h2 id="bilibili-qr-title">使用哔哩哔哩 App 扫码</h2>
            </div>
            <button className="new-task-close" type="button" aria-label="关闭 B站扫码登录" onClick={() => setQrState(undefined)}>×</button>
          </header>
          {qrState?.qrDataUrl ? <img src={qrState.qrDataUrl} alt="B站登录二维码" /> : <div className="bilibili-qr-placeholder">{qrState?.status === 'complete' ? '登录完成' : '二维码不可用'}</div>}
          <p role="status">{qrState?.message}</p>
          {qrState && ['expired', 'failed'].includes(qrState.status) && (
            <button className="primary-button" type="button" onClick={() => { void connect() }}>刷新二维码</button>
          )}
          {qrState?.status === 'complete' && (
            <button className="primary-button" type="button" onClick={() => setQrState(undefined)}>完成</button>
          )}
        </section>
      </dialog>
    </>
  )
}
