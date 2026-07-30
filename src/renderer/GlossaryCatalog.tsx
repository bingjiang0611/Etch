import { useEffect, useState } from 'react'
import type { GlossaryCatalogPage } from '../shared/ipc'
import { Icon } from './ui'

const PAGE_SIZE = 50

interface GlossaryCatalogProps {
  query: string
  offset: number
  catalog: GlossaryCatalogPage | undefined
  loading: boolean
  error: string
  onQueryChange: (query: string) => void
  onOffsetChange: (offset: number) => void
  onDelete: (entryId: string, expectedRevision: number) => Promise<void>
}

export function GlossaryCatalog({ query, offset, catalog, loading, error, onQueryChange, onOffsetChange, onDelete }: GlossaryCatalogProps): React.JSX.Element {
  const [confirmingId, setConfirmingId] = useState<string>()
  const [deletingId, setDeletingId] = useState<string>()
  const [deleteError, setDeleteError] = useState('')
  const visibleCatalog = !error && catalog?.query === query.trim() && catalog.offset === offset ? catalog : undefined

  useEffect(() => {
    setConfirmingId(undefined)
    setDeleteError('')
  }, [query, offset])

  const deleteEntry = async (entryId: string): Promise<void> => {
    if (!visibleCatalog || deletingId) return
    setDeletingId(entryId)
    setDeleteError('')
    try {
      await onDelete(entryId, visibleCatalog.revision)
      setConfirmingId(undefined)
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : '术语删除失败')
    } finally {
      setDeletingId(undefined)
    }
  }

  return (
    <section className="panel glossary-view glossary-catalog" aria-label="统一术语表">
      <header className="glossary-catalog-heading">
        <div>
          <div className="glossary-heading-line">
            <h2>全部术语</h2>
            {visibleCatalog && <span className="glossary-count">{visibleCatalog.total} 条</span>}
          </div>
          <p>新完成任务的审计术语会自动合并；相同原文与译法只保留一条。</p>
        </div>
        <label className="glossary-search">
          <span className="sr-only">搜索统一术语表</span>
          <Icon name="search" />
          <input type="search" placeholder="搜索原文术语或统一写法" value={query} onChange={(event) => onQueryChange(event.target.value)} />
        </label>
      </header>
      {(error || deleteError) && (
        <p className="review-error" role="alert">
          {deleteError || error}
        </p>
      )}
      {loading && !visibleCatalog && <div className="review-placeholder">正在读取统一术语表…</div>}
      {!loading && visibleCatalog?.items.length === 0 && (
        <div className="review-placeholder">
          {query.trim() ? '没有匹配的术语。' : '还没有术语；任务完成后会自动汇入这里。'}
        </div>
      )}
      {visibleCatalog?.items.length ? (
        <div className="global-glossary-table" role="table" aria-label="统一术语表">
          <div className="global-glossary-row global-glossary-table-heading" role="row">
            <span role="columnheader">原文术语</span>
            <span role="columnheader">统一写法</span>
            <span role="columnheader">来源</span>
            <span className="sr-only" role="columnheader">操作</span>
          </div>
          {visibleCatalog.items.map((item) => {
            const confirming = confirmingId === item.id
            const deleting = deletingId === item.id
            const sourceLabel = `来自 ${item.sourceCount} 个视频`
            return (
              <div className={`global-glossary-row ${confirming ? 'is-confirming' : ''}`} role="row" key={item.id}>
                <strong role="cell">{item.source}</strong>
                <span className="target" role="cell">{item.target}</span>
                <span className="global-glossary-source" role="cell" title={item.sourceTitles.join('\n')}>
                  <span>{sourceLabel}</span>
                  <small>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</small>
                </span>
                <div className="global-glossary-actions" role="cell">
                  {confirming ? (
                    <>
                      <button className="text-button" type="button" disabled={deleting} onClick={() => setConfirmingId(undefined)}>取消</button>
                      <button className="danger-button glossary-delete-confirm" type="button" disabled={deleting} onClick={() => { void deleteEntry(item.id) }}>
                        {deleting ? '删除中…' : '确认删除'}
                      </button>
                    </>
                  ) : (
                    <button className="glossary-delete-button" type="button" aria-label={`删除术语 ${item.source}`} title="删除术语" onClick={() => { setDeleteError(''); setConfirmingId(item.id) }}>
                      <Icon name="trash" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {visibleCatalog && visibleCatalog.total > 0 && (
        <footer className="pagination">
          <span className="mono">
            {visibleCatalog.offset + 1}–{Math.min(visibleCatalog.offset + PAGE_SIZE, visibleCatalog.total)} / {visibleCatalog.total}
          </span>
          <div>
            <button className="secondary-button" type="button" disabled={offset === 0 || loading || Boolean(deletingId)} onClick={() => onOffsetChange(Math.max(0, offset - PAGE_SIZE))}>
              上一页
            </button>
            <button className="secondary-button" type="button" disabled={offset + PAGE_SIZE >= visibleCatalog.total || loading || Boolean(deletingId)} onClick={() => onOffsetChange(offset + PAGE_SIZE)}>
              下一页
            </button>
          </div>
        </footer>
      )}
    </section>
  )
}
