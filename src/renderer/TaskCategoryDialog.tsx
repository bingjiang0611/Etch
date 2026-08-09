import { useEffect, useRef, useState } from 'react'
import { TASK_CATEGORY_COLORS, TASK_CATEGORY_NAME_MAX, type TaskCategory } from '../shared/settings-schema'
import { createCategoryDraft, moveCategory, renameCategoryDraft } from './task-categories'
import { Icon } from './ui'

export function TaskCategoryDialog({
  open,
  categories,
  counts,
  saving,
  saveError,
  onSave,
  onClose
}: {
  open: boolean
  categories: readonly TaskCategory[]
  counts: Record<string, number>
  saving: boolean
  saveError: string
  onSave(next: TaskCategory[]): void
  onClose(): void
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const newNameRef = useRef<HTMLInputElement>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<TaskCategory>()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      window.requestAnimationFrame(() => newNameRef.current?.focus())
    }
    if (!open && dialog.open) dialog.close()
    if (!open) {
      setNewName('')
      setError('')
      setPendingDelete(undefined)
    }
  }, [open])

  const commit = (next: TaskCategory[]): void => {
    setError('')
    onSave(next)
  }

  const addCategory = (): void => {
    const result = createCategoryDraft(categories, newName)
    if ('error' in result) {
      setError(result.error)
      return
    }
    setNewName('')
    commit([...categories, result.category])
  }

  const rename = (id: string, name: string): void => {
    const result = renameCategoryDraft(categories, id, name)
    if ('error' in result) {
      setError(result.error)
      return
    }
    commit(result)
  }

  return (
    <dialog
      className="task-category-dialog"
      ref={dialogRef}
      aria-labelledby="task-category-title"
      onCancel={(event) => {
        event.preventDefault()
        if (pendingDelete) setPendingDelete(undefined)
        else onClose()
      }}
      onPointerDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <div className="task-category-body">
        <header className="task-category-heading">
          <div>
            <p className="eyebrow">队列</p>
            <h2 id="task-category-title">管理分类</h2>
          </div>
          <button className="new-task-close" type="button" aria-label="关闭管理分类" onClick={onClose}>×</button>
        </header>
        <p className="new-task-copy">分类只是任务的归档位：改名、换色、删除都不动任务目录和任何产物。tab 顺序跟这里的顺序一致。</p>
        {categories.length ? (
          <div className="task-category-list">
            {categories.map((category, index) => (
              <div className="task-category-row" data-category-color={category.color} key={category.id}>
                <i className="cat-dot" aria-hidden="true" />
                <input
                  className="task-category-name"
                  type="text"
                  maxLength={TASK_CATEGORY_NAME_MAX}
                  defaultValue={category.name}
                  aria-label={`分类名称：${category.name}`}
                  disabled={saving}
                  onBlur={(event) => {
                    if (event.target.value.trim() === category.name) return
                    if (!event.target.value.trim()) event.target.value = category.name
                    else rename(category.id, event.target.value)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      event.currentTarget.value = category.name
                      event.currentTarget.blur()
                    }
                  }}
                />
                <span className="task-category-count mono">{counts[category.id] ?? 0} 个任务</span>
                <span className="task-category-colors" role="group" aria-label="分类颜色">
                  {TASK_CATEGORY_COLORS.map((color) => (
                    <button
                      className="task-category-color"
                      data-category-color={color}
                      type="button"
                      key={color}
                      aria-label={`把「${category.name}」设为第 ${TASK_CATEGORY_COLORS.indexOf(color) + 1} 种颜色`}
                      aria-pressed={category.color === color}
                      disabled={saving}
                      onClick={() => commit(categories.map((item) => (item.id === category.id ? { ...item, color } : item)))}
                    >
                      <i aria-hidden="true" />
                    </button>
                  ))}
                </span>
                <button
                  className="task-category-icon-button"
                  type="button"
                  aria-label={`上移「${category.name}」`}
                  disabled={saving || index === 0}
                  onClick={() => commit(moveCategory(categories, category.id, -1))}
                >
                  <Icon name="chevron" />
                </button>
                <button
                  className="task-category-icon-button is-down"
                  type="button"
                  aria-label={`下移「${category.name}」`}
                  disabled={saving || index === categories.length - 1}
                  onClick={() => commit(moveCategory(categories, category.id, 1))}
                >
                  <Icon name="chevron" />
                </button>
                <button
                  className="task-category-icon-button is-danger"
                  type="button"
                  aria-label={`删除分类「${category.name}」`}
                  disabled={saving}
                  onClick={() => setPendingDelete(category)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="task-category-empty">还没有分类。先建一个，比如「AI 访谈」或「技术讲座」。</p>
        )}
        <div className="task-category-add">
          <input
            ref={newNameRef}
            className="field-input"
            type="text"
            maxLength={TASK_CATEGORY_NAME_MAX}
            placeholder="新分类名称"
            value={newName}
            disabled={saving}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              addCategory()
            }}
          />
          <button className="secondary-button" type="button" disabled={saving || !newName.trim()} onClick={addCategory}>新建分类</button>
        </div>
        {(error || saveError) && <p className="form-error" role="alert">{error || saveError}</p>}
        <div className="task-category-footer">
          <p>分类保存在应用设置里，不写入任务目录；改名不会让任务跑丢。</p>
          <button className="primary-button" type="button" onClick={onClose}>完成</button>
        </div>
      </div>
      {pendingDelete && (
        <div className="task-category-confirm" role="alertdialog" aria-labelledby="task-category-confirm-title">
          <div className="task-category-confirm-card">
            <div className="task-delete-heading">
              <span className="task-delete-icon" data-mode="record-only" aria-hidden="true"><Icon name="warning" /></span>
              <div>
                <h2 id="task-category-confirm-title">删除分类「{pendingDelete.name}」？</h2>
                <p>
                  {counts[pendingDelete.id]
                    ? `该分类下的 ${counts[pendingDelete.id]} 个任务会回到「未分类」。`
                    : '这个分类下没有任务。'}
                </p>
              </div>
            </div>
            <p className="task-delete-description">删分类不动任务目录、不动任何中间产物，也不会中断正在跑的阶段。</p>
            <div className="task-delete-actions">
              <button className="secondary-button" type="button" autoFocus onClick={() => setPendingDelete(undefined)}>取消</button>
              <button
                className="danger-button is-confirming"
                type="button"
                disabled={saving}
                onClick={() => {
                  commit(categories.filter((category) => category.id !== pendingDelete.id))
                  setPendingDelete(undefined)
                }}
              >
                删除分类
              </button>
            </div>
          </div>
        </div>
      )}
    </dialog>
  )
}
