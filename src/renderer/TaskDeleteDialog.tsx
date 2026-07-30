import { useEffect, useRef } from 'react'
import type { DeleteTaskMode } from '../shared/ipc'
import { Icon } from './ui'

export type TaskDeleteRequest = {
  taskId: string
  title: string
  taskDirectory: string
  mode: DeleteTaskMode
}

export function TaskDeleteDialog({
  request,
  deleting,
  error,
  onCancel,
  onConfirm,
  restoreFocus
}: {
  request: TaskDeleteRequest | undefined
  deleting: boolean
  error: string
  onCancel(): void
  onConfirm(): void
  restoreFocus(taskId: string): void
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!request) return
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    window.requestAnimationFrame(() => cancelRef.current?.focus())
    return () => {
      if (dialog?.open) dialog.close()
      restoreFocus(request.taskId)
    }
  }, [request?.taskId, request?.mode, restoreFocus])

  return (
    <dialog
      className="task-delete-dialog"
      ref={dialogRef}
      aria-labelledby="task-delete-title"
      aria-describedby="task-delete-description"
      onCancel={(event) => {
        event.preventDefault()
        if (!deleting) onCancel()
      }}
      onPointerDown={(event) => {
        if (event.currentTarget === event.target && !deleting) onCancel()
      }}
    >
      {request && (
        <>
          <div className="task-delete-heading">
            <span className="task-delete-icon" data-mode={request.mode} aria-hidden="true"><Icon name={request.mode === 'record-only' ? 'record-remove' : 'trash'} /></span>
            <div>
              <h2 id="task-delete-title">{request.mode === 'record-only' ? '仅删除任务记录？' : '删除任务及全部产物？'}</h2>
              <p>{request.title}</p>
            </div>
          </div>
          <p id="task-delete-description" className="task-delete-description">
            {request.mode === 'record-only'
              ? '任务文件会原样保留，但此 taskId 将永久从 Etch 的队列和历史记录中隐藏。需要保留路径时，建议先使用“在访达中显示”。'
              : '下列 Etch 任务目录、中间文件、字幕和成片将整体移入 macOS 废纸篓。工作区外的本地原视频不会被删除。'}
          </p>
          <code className="task-delete-path">{request.taskDirectory}</code>
          {error && <p className="task-delete-error" role="alert">{error}</p>}
          <div className="task-delete-actions">
            <button ref={cancelRef} className="secondary-button" type="button" autoFocus disabled={deleting} onClick={onCancel}>取消</button>
            <button className={request.mode === 'record-only' ? 'secondary-button task-record-confirm' : 'danger-button is-confirming'} type="button" disabled={deleting} onClick={onConfirm}>
              {deleting ? '正在删除…' : request.mode === 'record-only' ? '仅删除任务记录' : '删除任务及全部产物'}
            </button>
          </div>
        </>
      )}
    </dialog>
  )
}
