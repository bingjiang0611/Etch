import { useCallback, useEffect, useRef, useState } from 'react'
import { publicationTemplateReady, type BilibiliAccount } from '../shared/bilibili'
import type { Bootstrap, ChromeCookieAccess, DeleteTaskMode, DocumentPage, GlossaryApplyResult, GlossaryCatalogPage, GlossaryImpactPreview, InstallableTool, QueuePage, RecoveryState, TaskDetail, TaskReviewPage, ToolHealthSnapshot } from '../shared/ipc'
import { InstallableToolSchema } from '../shared/ipc'
import { STAGE_ORDER } from '../shared/pipeline'
import { defaultSettings, type AppSettings, type TaskCategory, type ThemePreference, type ToolId } from '../shared/settings-schema'
import { lastStageForKind, taskThumbnailArtifact, type DocumentProcessingMode, type ModelSelection, type ProviderId, type StageId, type TaskKind } from '../shared/task-schema'
import type { GlossaryEdit } from './AuditGlossary'
import { glossaryImpactCounts } from './glossary-impact'
import { GlossaryCatalog } from './GlossaryCatalog'
import { DEFAULT_PROVIDER, PROVIDER_IDS, providerAvailability, providerOrDefault } from './provider-availability'
import { loadLastNewTaskProvider, resolveNewTaskProvider, saveLastNewTaskProvider } from './new-task-provider'
import { loadLastNewTaskModels, modelFieldSelection, modelFieldStateFor, resolveNewTaskModel, saveLastNewTaskModel, type ModelFieldState } from './model-selection'
import { ModelField, useModelCatalog } from './ModelField'
import { CLI_DEFAULT_MODEL, defaultModelForProvider } from '../shared/model-catalog'
import { detectInitialToolsWithRetry } from './tool-detection'
import { mergeToolHealth } from './tool-health'
import { parseTaskUrls } from './task-input'
import { ALL_TASKS_TAB, UNSORTED_TAB, categoryCounts, createCategoryDraft, effectiveCategory, findCategory, resolveTab, taskMatchesTab, type CategoryTab } from './task-categories'
import { TaskCategoryDialog } from './TaskCategoryDialog'
import { TaskDeleteDialog, type TaskDeleteRequest } from './TaskDeleteDialog'
import { deleteFocusNeighborId } from './task-delete-focus'
import { DocumentWorkbench } from './DocumentWorkbench'
import { WorkbenchView } from './WorkbenchView'
import { BilibiliPublishDialog } from './BilibiliPublishDialog'
import { BilibiliSettingsCard } from './BilibiliSettingsCard'
import { readableRemoteError } from './readable-error'
import { permissionGuideCopy } from './permission-guide'
import { Icon, PresetDemo, SwitchControl, bilibiliPublicationText, completedStageCount, durationLabel, getStage, providerNames, subtitleKindLabel, taskKindLabel, taskStages, taskStatusText, type SubtitlePreset } from './ui'

const tools: ToolId[] = ['yt-dlp', 'ffmpeg', 'ffprobe', 'python', 'mlx_whisper', 'claude', 'codex', 'qoder', 'opencode']
const INSTALLABLE_TOOLS = new Set<string>(InstallableToolSchema.options)
const REVIEW_PAGE_SIZE = 100
const GLOSSARY_CATALOG_PAGE_SIZE = 50
const CUE_AUTO_SAVE_DELAY_MS = 800
const QUEUE_DETAIL_RETRY_MS = 3_000
const MANUAL_GLOSSARY_NAV_MESSAGE = '术语草稿尚未处理，请先预览并应用，或重置修改后再离开。'
const THEME_OPTIONS: readonly (readonly [ThemePreference, string])[] = [
  ['system', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色']
]

function glossaryMatchesEdits(glossary: TaskReviewPage['glossary'], edits: readonly GlossaryEdit[]): boolean {
  return edits.every((edit) => {
    const entry = glossary[edit.index]
    return entry?.source === edit.expectedSource && entry.target === edit.expectedTarget
  })
}

type View = 'queue' | 'workbench' | 'glossary' | 'settings'
type BilibiliSettingsIntent = 'publish' | 'auto' | 'template'
type TaskContextMenuState = { taskId: string; title: string; x: number; y: number; running: boolean; taskIds: string[] }
type TaskThumbnailState = { sha256: string; dataUrl?: string }

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('queue')
  const [bootstrap, setBootstrap] = useState<Bootstrap>()
  const [diagnosticsDismissed, setDiagnosticsDismissed] = useState(false)
  const [queue, setQueue] = useState<QueuePage>({ items: [], total: 0 })
  const [queueError, setQueueError] = useState('')
  const [queueDetails, setQueueDetails] = useState<Record<string, TaskDetail>>({})
  const [queueDetailFailures, setQueueDetailFailures] = useState<Record<string, true>>({})
  const [queueDetailRetry, setQueueDetailRetry] = useState(0)
  const [openingTaskId, setOpeningTaskId] = useState<string>()
  const [startingTaskIds, setStartingTaskIds] = useState<Record<string, true>>({})
  const [url, setUrl] = useState('')
  const [taskKind, setTaskKind] = useState<TaskKind>('subtitle')
  const [documentMode, setDocumentMode] = useState<DocumentProcessingMode>('auto')
  const [documentTranslationMode, setDocumentTranslationMode] = useState<'normal' | 'refined'>('normal')
  const [documentAudience, setDocumentAudience] = useState('general')
  const [documentWritingStyle, setDocumentWritingStyle] = useState('storytelling')
  const [styleNote, setStyleNote] = useState('')
  const [autoPublish, setAutoPublish] = useState(false)
  const [provider, setProvider] = useState<ProviderId>(DEFAULT_PROVIDER)
  const [modelField, setModelField] = useState<ModelFieldState>(() => modelFieldStateFor(CLI_DEFAULT_MODEL))
  const [creatingTask, setCreatingTask] = useState(false)
  const [creatingCompanion, setCreatingCompanion] = useState(false)
  const [stoppingTask, setStoppingTask] = useState(false)
  const [publicationActionBusy, setPublicationActionBusy] = useState(false)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [fullDiskAccessGuideOpen, setFullDiskAccessGuideOpen] = useState(false)
  const [openingFullDiskAccessSettings, setOpeningFullDiskAccessSettings] = useState(false)
  const [fullDiskAccessGuideError, setFullDiskAccessGuideError] = useState('')
  const [chromeCookieAccess, setChromeCookieAccess] = useState<ChromeCookieAccess>('granted')
  const [relaunchingApp, setRelaunchingApp] = useState(false)
  const [taskThumbnails, setTaskThumbnails] = useState<Record<string, TaskThumbnailState>>({})
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<TaskDetail>()
  const [recovery, setRecovery] = useState<RecoveryState>({ hold: true, interruptedTasks: 0 })
  const [settings, setSettings] = useState<AppSettings>(defaultSettings('~'))
  const [bilibiliAccount, setBilibiliAccount] = useState<BilibiliAccount>({ status: 'disconnected' })
  const [bilibiliSettingsIntent, setBilibiliSettingsIntent] = useState<BilibiliSettingsIntent>()
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [toolHealth, setToolHealth] = useState<ToolHealthSnapshot[]>([])
  const [detectingTools, setDetectingTools] = useState(false)
  const [toolDetectError, setToolDetectError] = useState('')
  const [installingTool, setInstallingTool] = useState<InstallableTool>()
  const [installNote, setInstallNote] = useState('')
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [taskContextMenu, setTaskContextMenu] = useState<TaskContextMenuState>()
  const [categoryTab, setCategoryTab] = useState<CategoryTab>(ALL_TASKS_TAB)
  const [newTaskCategory, setNewTaskCategory] = useState('')
  const [inlineCategoryOpen, setInlineCategoryOpen] = useState(false)
  const [inlineCategoryName, setInlineCategoryName] = useState('')
  const [inlineCategoryError, setInlineCategoryError] = useState('')
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [savingCategories, setSavingCategories] = useState(false)
  const [categoryError, setCategoryError] = useState('')
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [pickedTaskIds, setPickedTaskIds] = useState<string[]>([])
  const [deleteRequest, setDeleteRequest] = useState<TaskDeleteRequest>()
  const [taskDeleteError, setTaskDeleteError] = useState('')
  const [deletingTaskId, setDeletingTaskId] = useState<string>()
  const [taskActionError, setTaskActionError] = useState('')
  const [reviewPage, setReviewPage] = useState<TaskReviewPage>()
  const [documentPage, setDocumentPage] = useState<DocumentPage>()
  const [documentPageLoading, setDocumentPageLoading] = useState(false)
  const [documentPageError, setDocumentPageError] = useState('')
  const [reviewOffset, setReviewOffset] = useState(0)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [cueDrafts, setCueDrafts] = useState<Record<number, string>>({})
  const [cueConflicts, setCueConflicts] = useState<Record<number, { english: string; chinese: string }>>({})
  const [savingCues, setSavingCues] = useState(false)
  const [autoSaveBlocked, setAutoSaveBlocked] = useState(false)
  const [cueSaveNotice, setCueSaveNotice] = useState('')
  const [resolvingAudit, setResolvingAudit] = useState(false)
  const [resolvingIllustration, setResolvingIllustration] = useState(false)
  const [completingReview, setCompletingReview] = useState(false)
  const [savingPreset, setSavingPreset] = useState(false)
  const [glossaryQuery, setGlossaryQuery] = useState('')
  const [glossaryOffset, setGlossaryOffset] = useState(0)
  const [glossaryCatalog, setGlossaryCatalog] = useState<GlossaryCatalogPage>()
  const [glossaryCatalogLoading, setGlossaryCatalogLoading] = useState(false)
  const [glossaryCatalogError, setGlossaryCatalogError] = useState('')
  const [glossaryBusy, setGlossaryBusy] = useState(false)
  const draftVersionRef = useRef(0)
  const cueDraftsRef = useRef<Record<number, string>>({})
  const cueDraftBaselinesRef = useRef<Record<number, { english: string; chinese: string }>>({})
  const cueConflictsRef = useRef<Record<number, { english: string; chinese: string }>>({})
  const cueSaveNoticeTimerRef = useRef<number | undefined>(undefined)
  const initialToolDetectionStartedRef = useRef(false)
  const toolDetectionInFlightRef = useRef(false)
  const toolDetectionGenerationRef = useRef(0)
  const recoveryRef = useRef(recovery)
  const recoveryReleaseInFlightRef = useRef<Promise<void> | undefined>(undefined)
  const rendererMountedRef = useRef(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const queueDetailsRef = useRef<Record<string, TaskDetail>>({})
  const queueDetailGenerationRef = useRef(0)
  const queuePageGenerationRef = useRef(0)
  const queuePollInFlightRef = useRef(false)
  const queueStartsInFlightRef = useRef(new Set<string>())
  const openTaskGenerationRef = useRef(0)
  const glossaryBusyRef = useRef(false)
  const deferredGlossaryActionRef = useRef<(() => void) | undefined>(undefined)
  const glossarySaveQueuesRef = useRef(new Map<string, Promise<void>>())
  const cueSaveGenerationRef = useRef(0)
  const cueSaveInFlightRef = useRef(false)
  const auditSubmittingRef = useRef(false)
  const documentDraftTimerRef = useRef<number | undefined>(undefined)
  const documentSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const completingReviewRef = useRef(false)
  const createTaskInFlightRef = useRef(false)
  const settingsSaveInFlightRef = useRef(false)
  const categorySaveInFlightRef = useRef(false)
  const presetSaveInFlightRef = useRef(false)
  const presetSaveGenerationRef = useRef(0)
  const persistedSettingsRef = useRef(settings)
  const settingsDraftRef = useRef(settings)
  const providerEditVersionRef = useRef(0)
  const taskContextMenuRef = useRef<HTMLDivElement>(null)
  const taskContextTriggerRef = useRef<HTMLButtonElement | undefined>(undefined)
  const newTaskDialogRef = useRef<HTMLDialogElement>(null)
  const fullDiskAccessDialogRef = useRef<HTMLDialogElement>(null)
  const newTaskTriggerRef = useRef<HTMLButtonElement>(null)
  const deleteFocusNeighborRef = useRef<string | undefined>(undefined)
  const taskThumbnailsRef = useRef<Record<string, TaskThumbnailState>>({})
  const thumbnailRequestsRef = useRef(new Set<string>())
  const changeViewRef = useRef<(next: View) => void>(() => undefined)
  recoveryRef.current = recovery
  settingsDraftRef.current = settings

  useEffect(() => {
    rendererMountedRef.current = true
    return () => {
      rendererMountedRef.current = false
    }
  }, [])

  // 主题只靠翻 documentElement 上的 data-theme；system 即不写该属性，
  // 交回给 app.css 里的 color-scheme: light dark 跟随系统。
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') root.removeAttribute('data-theme')
    else root.dataset.theme = settings.theme
  }, [settings.theme])

  const ensureRecoveryReleased = useCallback(async (): Promise<void> => {
    if (!recoveryRef.current.hold) return
    recoveryReleaseInFlightRef.current ??= window.etch.releaseRecovery().then((next) => {
      recoveryRef.current = next
      setRecovery(next)
      if (next.hold) throw new Error('自动恢复尚未完成，请稍后重试。')
    })
    const inFlight = recoveryReleaseInFlightRef.current
    try {
      await inFlight
    } finally {
      if (recoveryReleaseInFlightRef.current === inFlight) recoveryReleaseInFlightRef.current = undefined
    }
  }, [])

  const closeTaskContextMenu = useCallback((restoreFocus = true): void => {
    setTaskContextMenu(undefined)
    setCategoryMenuOpen(false)
    if (restoreFocus) window.requestAnimationFrame(() => taskContextTriggerRef.current?.focus())
  }, [])

  const restoreDeleteFocus = useCallback((taskId: string): void => {
    window.requestAnimationFrame(() => {
      const trigger = taskContextTriggerRef.current
      if (trigger?.isConnected) {
        trigger.focus()
        return
      }
      const rows = [...document.querySelectorAll<HTMLElement>('[data-task-id]')]
      const openButton = (id: string | undefined): HTMLButtonElement | undefined =>
        (id ? rows.find((row) => row.dataset.taskId === id)?.querySelector<HTMLButtonElement>('.task-row-open') : null) ?? undefined
      // 删除后原任务行已消失，把焦点交给相邻卡片，否则回落到页头按钮会把整个队列滚回顶部。
      const taskRow = openButton(taskId) ?? openButton(deleteFocusNeighborRef.current)
      ;(taskRow ?? newTaskTriggerRef.current)?.focus()
    })
  }, [])

  useEffect(() => {
    if (!taskContextMenu) return
    taskContextMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const close = (): void => closeTaskContextMenu(false)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    document.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [taskContextMenu, closeTaskContextMenu])

  useEffect(() => {
    if (!categoryMenuOpen) return
    const submenu = taskContextMenuRef.current?.querySelector<HTMLElement>('.task-category-submenu')
    ;(submenu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? submenu?.querySelector<HTMLButtonElement>('button'))?.focus()
  }, [categoryMenuOpen])

  const handleGlossaryBusyChange = useCallback((busy: boolean): void => {
    glossaryBusyRef.current = busy
    setGlossaryBusy(busy)
    if (!busy) setReviewError((current) => current === MANUAL_GLOSSARY_NAV_MESSAGE ? '' : current)
  }, [])

  useEffect(() => {
    if (glossaryBusy || !deferredGlossaryActionRef.current) return
    const action = deferredGlossaryActionRef.current
    deferredGlossaryActionRef.current = undefined
    action()
  }, [glossaryBusy])

  const rememberDetail = useCallback((detail: TaskDetail): void => {
    const existing = queueDetailsRef.current[detail.manifest.taskId]
    if (existing && existing.manifest.revision >= detail.manifest.revision) return
    queueDetailsRef.current = { ...queueDetailsRef.current, [detail.manifest.taskId]: detail }
    setQueueDetails(queueDetailsRef.current)
    setQueueDetailFailures((current) => {
      if (!current[detail.manifest.taskId]) return current
      const next = { ...current }
      delete next[detail.manifest.taskId]
      return next
    })
  }, [])

  const commitQueuePage = useCallback((next: QueuePage): void => {
    queuePageGenerationRef.current += 1
    setQueue(next)
    setQueueError('')
  }, [])

  const refreshQueue = useCallback((): void => {
    if (queuePollInFlightRef.current) return
    queuePollInFlightRef.current = true
    const generation = ++queuePageGenerationRef.current
    void window.etch
      .queuePage()
      .then((next) => {
        if (generation !== queuePageGenerationRef.current) return
        setQueue(next)
        setQueueError('')
      })
      .catch((caught) => {
        if (generation !== queuePageGenerationRef.current) return
        const detail = caught instanceof Error && caught.message ? `：${caught.message}` : ''
        setQueueError(`任务队列刷新失败${detail}`)
      })
      .finally(() => {
        queuePollInFlightRef.current = false
      })
  }, [])

  const refreshChromeCookieAccess = useCallback((): Promise<void> => {
    return window.etch.chromeCookieAccess().then(setChromeCookieAccess).catch(() => undefined)
  }, [])

  useEffect(() => {
    void window.etch.bootstrap().then((next) => {
      setBootstrap(next)
      setChromeCookieAccess(next.chromeCookieAccess)
      setFullDiskAccessGuideOpen(next.showFullDiskAccessOnboarding)
    })
    refreshQueue()
    void window.etch.recoveryState().then(setRecovery)
    void window.etch
      .getSettings()
      .then((next) => {
        persistedSettingsRef.current = next
        const selectedProvider = providerOrDefault(next.defaultProvider)
        setSettings(next.defaultProvider === selectedProvider ? next : { ...next, defaultProvider: selectedProvider })
        setProvider(selectedProvider)
        setSettingsLoaded(true)
      })
      .catch((caught) => setSettingsError(caught instanceof Error ? caught.message : '设置读取失败'))
    void window.etch.bilibiliAccount()
      .then(setBilibiliAccount)
      .catch((caught) => setSettingsError(caught instanceof Error ? caught.message : 'B站账号状态读取失败'))
    if (!initialToolDetectionStartedRef.current) {
      initialToolDetectionStartedRef.current = true
      void detectTools(true)
    }
  }, [refreshQueue])

  useEffect(() => {
    let cancelled = false
    const selectedTaskId = selected?.manifest.taskId
    const timer = window.setInterval(() => {
      refreshQueue()
      if (selectedTaskId)
        void window.etch
          .taskDetail(selectedTaskId)
          .then((detail) => {
            rememberDetail(detail)
            if (cancelled) return
            setSelected((current) => {
              if (current?.manifest.taskId !== selectedTaskId || detail.manifest.taskId !== selectedTaskId) return current
              return current.manifest.revision >= detail.manifest.revision ? current : detail
            })
          })
          .catch(() => undefined)
    }, 1_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selected?.manifest.taskId, rememberDetail, refreshQueue])

  const queueDetailKey = queue.items.map((item) => `${item.taskId}:${item.revision}`).join('|')
  useEffect(() => {
    const generation = ++queueDetailGenerationRef.current
    let retryTimer: number | undefined
    const activeIds = new Set(queue.items.map((item) => item.taskId))
    const retained = Object.fromEntries(Object.entries(queueDetailsRef.current).filter(([taskId]) => activeIds.has(taskId)))
    if (Object.keys(retained).length !== Object.keys(queueDetailsRef.current).length) {
      queueDetailsRef.current = retained
      setQueueDetails(retained)
    }
    const pending = queue.items.filter((item) => {
      const cached = queueDetailsRef.current[item.taskId]
      return !cached || cached.manifest.revision < item.revision
    })
    if (!pending.length) return
    void Promise.allSettled(pending.map((item) => window.etch.taskDetail(item.taskId))).then((results) => {
      if (generation !== queueDetailGenerationRef.current) return
      const failures: Record<string, true> = {}
      const next = { ...queueDetailsRef.current }
      results.forEach((result, index) => {
        const summary = pending[index]
        if (result.status === 'fulfilled' && result.value.manifest.revision >= summary.revision) {
          const current = next[summary.taskId]
          if (!current || current.manifest.revision <= result.value.manifest.revision) next[summary.taskId] = result.value
        } else failures[summary.taskId] = true
      })
      queueDetailsRef.current = next
      setQueueDetails(next)
      setQueueDetailFailures(failures)
      if (Object.keys(failures).length) retryTimer = window.setTimeout(() => setQueueDetailRetry((current) => current + 1), QUEUE_DETAIL_RETRY_MS)
    })
    return () => {
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [queueDetailKey, queueDetailRetry])

  useEffect(() => {
    if (!selected || view !== 'workbench') return
    // 只有字幕任务使用 cue 校对页；文档有独立工作台。
    if (selected.manifest.kind !== 'subtitle') {
      setReviewPage(undefined)
      setReviewLoading(false)
      return
    }
    let cancelled = false
    setReviewLoading(true)
    if (!Object.keys(cueConflictsRef.current).length) setReviewError('')
    void window.etch
      .reviewPage(selected.manifest.taskId, reviewOffset, REVIEW_PAGE_SIZE)
      .then((page) => {
        if (!cancelled && page.taskId === selected.manifest.taskId) setReviewPage(page)
      })
      .catch((caught) => {
        if (!cancelled) {
          setReviewPage(undefined)
          setReviewError(caught instanceof Error ? caught.message : '字幕校对数据读取失败')
        }
      })
      .finally(() => {
        if (!cancelled) setReviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected?.manifest.taskId, selected?.manifest.revision, selected?.manifest.artifacts.audit?.sha256, selected?.manifest.artifacts.chineseCues?.sha256, reviewOffset, view])

  useEffect(() => {
    if (!selected || selected.manifest.kind !== 'document' || view !== 'workbench') {
      setDocumentPage(undefined)
      setDocumentPageLoading(false)
      setDocumentPageError('')
      return
    }
    let cancelled = false
    setDocumentPageLoading(true)
    setDocumentPageError('')
    void window.etch.documentPage(selected.manifest.taskId)
      .then((page) => {
        if (!cancelled && page.taskId === selected.manifest.taskId) setDocumentPage(page)
      })
      .catch((caught) => {
        if (!cancelled) {
          setDocumentPage(undefined)
          setDocumentPageError(caught instanceof Error ? caught.message : '文档读取失败')
        }
      })
      .finally(() => {
        if (!cancelled) setDocumentPageLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected?.manifest.taskId, selected?.manifest.revision, selected?.manifest.artifacts.sourceDocument?.sha256, selected?.manifest.artifacts.translatedDocument?.sha256, selected?.manifest.artifacts.documentVerification?.sha256, view])

  useEffect(() => () => {
    if (documentDraftTimerRef.current) window.clearTimeout(documentDraftTimerRef.current)
  }, [])

  useEffect(() => {
    const activeIds = new Set(queue.items.map((item) => item.taskId))
    const retained = Object.fromEntries(Object.entries(taskThumbnailsRef.current).filter(([taskId]) => activeIds.has(taskId)))
    if (Object.keys(retained).length !== Object.keys(taskThumbnailsRef.current).length) {
      taskThumbnailsRef.current = retained
      setTaskThumbnails(retained)
    }

    for (const [taskId, detail] of Object.entries(queueDetails)) {
      if (!activeIds.has(taskId)) continue
      const artifact = taskThumbnailArtifact(detail.manifest)
      if (!artifact?.valid || taskThumbnailsRef.current[taskId]?.sha256 === artifact.sha256) continue
      const requestKey = `${taskId}:${artifact.sha256}`
      if (thumbnailRequestsRef.current.has(requestKey)) continue
      thumbnailRequestsRef.current.add(requestKey)
      void window.etch
        .taskThumbnail(taskId, artifact.sha256)
        .then((dataUrl) => {
          const latestDetail = queueDetailsRef.current[taskId]
          const latestArtifact = latestDetail ? taskThumbnailArtifact(latestDetail.manifest) : undefined
          if (latestArtifact?.sha256 !== artifact.sha256) return
          const next = { ...taskThumbnailsRef.current, [taskId]: { sha256: artifact.sha256, dataUrl } }
          taskThumbnailsRef.current = next
          setTaskThumbnails(next)
        })
        .catch(() => {
          const next = { ...taskThumbnailsRef.current, [taskId]: { sha256: artifact.sha256 } }
          taskThumbnailsRef.current = next
          setTaskThumbnails(next)
        })
        .finally(() => thumbnailRequestsRef.current.delete(requestKey))
    }
  }, [queueDetailKey, queueDetails])

  useEffect(() => {
    if (view !== 'glossary') return
    let cancelled = false
    setGlossaryCatalogLoading(true)
    setGlossaryCatalogError('')
    const timer = window.setTimeout(() => {
      void window.etch
        .glossaryCatalogPage(glossaryQuery, glossaryOffset)
        .then((page) => {
          if (cancelled) return
          if (page.total > 0 && page.items.length === 0 && page.offset >= page.total) {
            setGlossaryOffset(Math.floor((page.total - 1) / GLOSSARY_CATALOG_PAGE_SIZE) * GLOSSARY_CATALOG_PAGE_SIZE)
            return
          }
          setGlossaryCatalog(page)
        })
        .catch((caught) => {
          if (!cancelled) setGlossaryCatalogError(caught instanceof Error ? caught.message : '统一术语表读取失败')
        })
        .finally(() => {
          if (!cancelled) setGlossaryCatalogLoading(false)
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [view, glossaryQuery, glossaryOffset, queueDetailKey, queue.total])

  useEffect(() => {
    if (settingsLoaded && settings !== persistedSettingsRef.current) setSettingsSaved(false)
  }, [settings, settingsLoaded])

  useEffect(() => {
    if (bilibiliAccount.status !== 'connected' || !publicationTemplateReady(settings.bilibiliPublishTemplate)) setAutoPublish(false)
  }, [bilibiliAccount.status, settings.bilibiliPublishTemplate])

  useEffect(() => {
    if (selected?.manifest.publication.lastError?.code !== 'auth-expired') return
    setBilibiliAccount((current) => ({
      ...current,
      status: 'expired',
      message: selected.manifest.publication.lastError?.message ?? 'B站登录已失效，请重新扫码登录'
    }))
  }, [selected?.manifest.publication.lastError])

  const newTaskModelCatalog = useModelCatalog(
    taskKind !== 'document' || documentMode !== 'convert' ? provider : undefined,
    newTaskOpen
  )
  const settingsModelCatalog = useModelCatalog(providerOrDefault(settings.defaultProvider), view === 'settings')
  const [settingsModelField, setSettingsModelField] = useState<ModelFieldState>(() => modelFieldStateFor(CLI_DEFAULT_MODEL))
  const settingsModelSeedRef = useRef('')

  useEffect(() => {
    const seedProvider = providerOrDefault(settings.defaultProvider)
    const seed = `${settingsLoaded ? 'loaded' : 'pending'}:${seedProvider}`
    if (settingsModelSeedRef.current === seed) return
    settingsModelSeedRef.current = seed
    setSettingsModelField(modelFieldStateFor(defaultModelForProvider(settings.defaultModelByProvider, seedProvider)))
  }, [settings.defaultProvider, settings.defaultModelByProvider, settingsLoaded])

  // Model ids are provider-specific, so switching provider reloads the remembered or configured
  // choice for that provider instead of carrying an id that the next CLI would reject.
  const seedModelField = (nextProvider: ProviderId): void => {
    setModelField(modelFieldStateFor(resolveNewTaskModel(
      loadLastNewTaskModels(() => window.localStorage),
      settings.defaultModelByProvider,
      nextProvider
    )))
  }

  const addUrl = async (): Promise<void> => {
    if (createTaskInFlightRef.current || !url.trim()) return
    let submittedUrls: string[]
    try {
      submittedUrls = parseTaskUrls(url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '链接格式无效')
      return
    }
    const submittedUrlText = url
    const submittedKind = taskKind
    const submittedStyleNote = submittedKind === 'document' && documentMode === 'convert' ? '' : styleNote
    const submittedAutoPublish = submittedKind === 'subtitle' ? autoPublish : false
    const submittedDocumentMode = documentMode
    const submittedDocumentTranslationMode = documentTranslationMode
    const submittedDocumentAudience = documentAudience
    const submittedDocumentWritingStyle = documentWritingStyle
    const submittedCategory = findCategory(settings.taskCategories, newTaskCategory) ? newTaskCategory : ''
    const submittedProvider = providerOrDefault(provider)
    const needsAgent = !(submittedKind === 'document' && submittedDocumentMode === 'convert')
    const chosenModel = modelFieldSelection(modelField)
    if (needsAgent && !chosenModel) {
      setError('模型 ID 无效，请修正后再创建任务。')
      return
    }
    const submittedModel = needsAgent ? chosenModel! : CLI_DEFAULT_MODEL
    createTaskInFlightRef.current = true
    setCreatingTask(true)
    try {
      setError('')
      await ensureRecoveryReleased()
      const next = await window.etch.createUrls(
        submittedUrls,
        submittedProvider,
        submittedStyleNote,
        submittedAutoPublish,
        submittedKind,
        submittedCategory,
        submittedDocumentMode,
        submittedDocumentTranslationMode,
        submittedDocumentAudience,
        submittedDocumentWritingStyle,
        submittedModel
      )
      commitQueuePage(next)
      if (needsAgent) {
        saveLastNewTaskProvider(() => window.localStorage, submittedProvider)
        saveLastNewTaskModel(() => window.localStorage, submittedProvider, submittedModel)
      }
      setUrl((current) => (current === submittedUrlText ? '' : current))
      setStyleNote((current) => (current === submittedStyleNote ? '' : current))
      setAutoPublish((current) => (current === submittedAutoPublish ? false : current))
      // 新建到某个分类时直接跳过去，否则任务会落在当前 tab 之外看不见。
      if (submittedCategory) setCategoryTab(submittedCategory)
      setNewTaskOpen(false)
      window.requestAnimationFrame(() => newTaskTriggerRef.current?.focus())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '任务创建失败，请检查链接与处理设置。')
    } finally {
      createTaskInFlightRef.current = false
      setCreatingTask(false)
    }
  }

  const openTask = async (taskId: string): Promise<void> => {
    const generation = ++openTaskGenerationRef.current
    cueSaveGenerationRef.current += 1
    setSavingCues(false)
    setOpeningTaskId(taskId)
    setTaskActionError('')
    try {
      const detail = await window.etch.taskDetail(taskId)
      if (generation !== openTaskGenerationRef.current) return
      rememberDetail(detail)
      setDeleteRequest(undefined)
      setReviewOffset(0)
      setReviewPage(undefined)
      setCueDrafts({})
      cueDraftsRef.current = {}
      cueDraftBaselinesRef.current = {}
      setCueConflicts({})
      cueConflictsRef.current = {}
      setSelected(detail)
      setView('workbench')
    } catch (caught) {
      if (generation === openTaskGenerationRef.current) setTaskActionError(caught instanceof Error ? caught.message : '任务读取失败')
    } finally {
      if (generation === openTaskGenerationRef.current) setOpeningTaskId(undefined)
    }
  }

  const createCompanion = async (provider: ProviderId, styleNote: string, model: ModelSelection): Promise<boolean> => {
    if (!selected || creatingCompanion) return false
    setCreatingCompanion(true)
    setTaskActionError('')
    try {
      await ensureRecoveryReleased()
      const detail = await window.etch.createCompanion(selected.manifest.taskId, provider, styleNote, false, model)
      rememberDetail(detail)
      refreshQueue()
      await openTask(detail.manifest.taskId)
      saveLastNewTaskModel(() => window.localStorage, provider, model)
      return true
    } catch (caught) {
      setTaskActionError(caught instanceof Error ? caught.message : '追加成果失败')
      return false
    } finally {
      setCreatingCompanion(false)
    }
  }

  const startSelected = async (): Promise<void> => {
    if (!selected) return
    if (selected.manifest.translation.auditCheckpoint || auditSubmittingRef.current) {
      const sourceAudit = selected.manifest.pipeline.stages.cues?.checkpointId === 'english-source-ambiguity'
      setTaskActionError(sourceAudit ? '请先完成英文源字幕裁决，再继续处理。' : '请先完成术语审计裁决，再继续处理。')
      return
    }
    if (Object.keys(cueDrafts).length || savingCues) {
      setTaskActionError('请先等待字幕修改保存完成，再开始处理。')
      return
    }
    const taskId = selected.manifest.taskId
    const selectionGeneration = openTaskGenerationRef.current
    try {
      setTaskActionError('')
      await ensureRecoveryReleased()
      if (selectionGeneration !== openTaskGenerationRef.current) return
      const detail = await window.etch.startTask(taskId)
      rememberDetail(detail)
      setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= detail.manifest.revision ? detail : current))
    } catch (caught) {
      if (selectionGeneration === openTaskGenerationRef.current) setTaskActionError(caught instanceof Error ? caught.message : '任务启动失败')
    }
  }

  const startQueuedTask = async (taskId: string): Promise<void> => {
    if (queueStartsInFlightRef.current.has(taskId)) return
    queueStartsInFlightRef.current.add(taskId)
    setStartingTaskIds((current) => ({ ...current, [taskId]: true }))
    try {
      setTaskActionError('')
      await ensureRecoveryReleased()
      const detail = await window.etch.startTask(taskId)
      rememberDetail(detail)
      setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= detail.manifest.revision ? detail : current))
      await window.etch.queuePage().then(commitQueuePage).catch(() => undefined)
    } catch (caught) {
      setTaskActionError(caught instanceof Error ? caught.message : '任务启动失败')
    } finally {
      queueStartsInFlightRef.current.delete(taskId)
      setStartingTaskIds((current) => {
        const next = { ...current }
        delete next[taskId]
        return next
      })
    }
  }

  const stopSelected = async (): Promise<void> => {
    if (!selected || stoppingTask) return
    const taskId = selected.manifest.taskId
    const selectionGeneration = openTaskGenerationRef.current
    setStoppingTask(true)
    try {
      setTaskActionError('')
      const detail = await window.etch.stopTask(taskId)
      rememberDetail(detail)
      if (selectionGeneration === openTaskGenerationRef.current) {
        setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= detail.manifest.revision ? detail : current))
      }
    } catch (caught) {
      if (selectionGeneration === openTaskGenerationRef.current) setTaskActionError(caught instanceof Error ? caught.message : '任务停止失败')
    } finally {
      setStoppingTask(false)
    }
  }

  const applyPublicationDetail = (detail: TaskDetail): void => {
    rememberDetail(detail)
    setSelected((current) => current?.manifest.taskId === detail.manifest.taskId && current.manifest.revision <= detail.manifest.revision ? detail : current)
  }

  const stopPublication = async (): Promise<void> => {
    if (!selected || publicationActionBusy) return
    setPublicationActionBusy(true)
    setTaskActionError('')
    try {
      applyPublicationDetail(await window.etch.stopBilibiliPublication(selected.manifest.taskId))
    } catch (caught) {
      setTaskActionError(readableRemoteError(caught, 'B站投稿停止失败'))
    } finally {
      setPublicationActionBusy(false)
    }
  }

  const continuePublication = async (): Promise<void> => {
    if (!selected || publicationActionBusy) return
    setPublicationActionBusy(true)
    setTaskActionError('')
    try {
      applyPublicationDetail(await window.etch.continueBilibiliPublication(selected.manifest.taskId))
    } catch (caught) {
      setTaskActionError(readableRemoteError(caught, 'B站投稿继续失败'))
    } finally {
      setPublicationActionBusy(false)
    }
  }

  const requestTaskDelete = async (taskId: string, title: string, mode: DeleteTaskMode): Promise<void> => {
    closeTaskContextMenu(false)
    if (selected?.manifest.taskId === taskId && auditSubmittingRef.current) {
      setTaskActionError('审计决策正在提交，请稍候再删除任务。')
      return
    }
    try {
      setTaskActionError('')
      setTaskDeleteError('')
      const detail = queueDetailsRef.current[taskId] ?? await window.etch.taskDetail(taskId)
      rememberDetail(detail)
      setDeleteRequest({ taskId, title, taskDirectory: detail.taskDirectory, mode, publicationSubmitted: detail.manifest.publication.status === 'submitted' })
    } catch (caught) {
      setTaskActionError(caught instanceof Error ? caught.message : '任务目录读取失败')
    }
  }

  const revealTask = async (taskId: string): Promise<void> => {
    closeTaskContextMenu()
    try {
      setTaskActionError('')
      await window.etch.revealTask(taskId)
    } catch (caught) {
      setTaskActionError(caught instanceof Error ? caught.message : '无法在访达中显示任务')
    }
  }

  const deleteTask = async (): Promise<void> => {
    if (!deleteRequest) return
    const { taskId, mode } = deleteRequest
    try {
      setTaskActionError('')
      setTaskDeleteError('')
      setDeletingTaskId(taskId)
      deleteFocusNeighborRef.current = deleteFocusNeighborId(queue.items.map((item) => item.taskId), taskId)
      commitQueuePage(await window.etch.deleteTask(taskId, mode))
      queueDetailGenerationRef.current += 1
      const nextDetails = { ...queueDetailsRef.current }
      delete nextDetails[taskId]
      queueDetailsRef.current = nextDetails
      setQueueDetails(nextDetails)
      setQueueDetailFailures((current) => {
        if (!current[taskId]) return current
        const next = { ...current }
        delete next[taskId]
        return next
      })
      if (selected?.manifest.taskId === taskId) {
        openTaskGenerationRef.current += 1
        setSelected(undefined)
        cueSaveGenerationRef.current += 1
        setReviewPage(undefined)
        setCueDrafts({})
        cueDraftsRef.current = {}
        setView('queue')
      }
      setDeleteRequest(undefined)
    } catch (caught) {
      const message = readableRemoteError(caught, '任务删除失败')
      setTaskActionError(message)
      setTaskDeleteError(message)
    } finally {
      setDeletingTaskId(undefined)
    }
  }

  const resolveAudit = async (decisions: Array<{ cueId: number; translation: string }>): Promise<void> => {
    const checkpoint = selected?.manifest.translation.auditCheckpoint
    if (!selected || !checkpoint || auditSubmittingRef.current) return
    const taskId = selected.manifest.taskId
    const selectionGeneration = openTaskGenerationRef.current
    auditSubmittingRef.current = true
    setResolvingAudit(true)
    try {
      setTaskActionError('')
      await ensureRecoveryReleased()
      if (selectionGeneration !== openTaskGenerationRef.current) return
      const expectedCueIds = new Set(checkpoint.ambiguities.map((item) => item.cueId))
      const decisionCueIds = new Set(decisions.map((item) => item.cueId))
      if (decisions.length !== expectedCueIds.size || decisionCueIds.size !== expectedCueIds.size || decisions.some((item) => !expectedCueIds.has(item.cueId))) {
        throw new Error('请为每条歧义选择保留当前内容或采用建议内容')
      }
      if (decisions.some((item) => !item.translation.trim() || item.translation.trim().length > 2000 || /[\t\r\n]/u.test(item.translation))) {
        throw new Error('审计内容不能为空、超过 2000 个字符，或包含 Tab/换行')
      }
      const detail = await window.etch.resolveAudit(
        taskId,
        decisions.map((item) => ({ ...item, translation: item.translation.trim() })),
      )
      rememberDetail(detail)
      setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= detail.manifest.revision ? detail : current))
    } catch (caught) {
      if (selectionGeneration === openTaskGenerationRef.current) setTaskActionError(readableRemoteError(caught, '审计决策提交失败'))
    } finally {
      auditSubmittingRef.current = false
      setResolvingAudit(false)
    }
  }

  const resolveIllustration = async (
    submit: (taskId: string, expectedRevision: number) => Promise<TaskDetail>
  ): Promise<void> => {
    if (!selected || resolvingIllustration) return
    const taskId = selected.manifest.taskId
    const expectedRevision = selected.manifest.revision
    const selectionGeneration = openTaskGenerationRef.current
    setResolvingIllustration(true)
    try {
      setTaskActionError('')
      await ensureRecoveryReleased()
      if (selectionGeneration !== openTaskGenerationRef.current) return
      const detail = await submit(taskId, expectedRevision)
      rememberDetail(detail)
      setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= detail.manifest.revision ? detail : current))
    } catch (caught) {
      if (selectionGeneration === openTaskGenerationRef.current) setTaskActionError(caught instanceof Error ? caught.message : '配图决议提交失败')
    } finally {
      setResolvingIllustration(false)
    }
  }

  const saveSettings = async (): Promise<void> => {
    if (!settingsLoaded || settingsSaveInFlightRef.current || presetSaveInFlightRef.current) return
    const submittedDraft = settings
    const submitted = settings
    const submittedProviderVersion = providerEditVersionRef.current
    settingsSaveInFlightRef.current = true
    setSavingSettings(true)
    try {
      setSettingsError('')
      const saved = await window.etch.updateSettings(submitted)
      const draftUnchanged = settingsDraftRef.current === submittedDraft
      persistedSettingsRef.current = saved
      setSettings((current) => (draftUnchanged && current === submittedDraft ? saved : current))
      if (providerEditVersionRef.current === submittedProviderVersion) setProvider(providerOrDefault(saved.defaultProvider))
      if (!saved.queuePaused) {
        setTaskActionError((current) => current.includes('队列已暂停') ? '' : current)
      }
      setSettingsSaved(draftUnchanged)
      window.setTimeout(() => setSettingsSaved(false), 1_500)
    } catch (caught) {
      setSettingsError(caught instanceof Error ? caught.message : '设置保存失败')
    } finally {
      settingsSaveInFlightRef.current = false
      setSavingSettings(false)
    }
  }

  // 分类要点一下就落盘，但不能顺手把设置页里没保存的草稿一起提交，所以只合并 taskCategories。
  const saveCategories = async (next: TaskCategory[]): Promise<TaskCategory[] | undefined> => {
    if (!settingsLoaded || categorySaveInFlightRef.current) return undefined
    categorySaveInFlightRef.current = true
    setSavingCategories(true)
    try {
      setCategoryError('')
      const saved = await window.etch.updateSettings({ ...persistedSettingsRef.current, taskCategories: next })
      persistedSettingsRef.current = saved
      setSettings((current) => ({ ...current, taskCategories: saved.taskCategories }))
      return saved.taskCategories
    } catch (caught) {
      setCategoryError(caught instanceof Error ? caught.message : '分类保存失败')
      return undefined
    } finally {
      categorySaveInFlightRef.current = false
      setSavingCategories(false)
    }
  }

  const moveTasksToCategory = async (taskIds: readonly string[], category: string): Promise<void> => {
    setPickedTaskIds([])
    try {
      setTaskActionError('')
      let page: QueuePage | undefined
      for (const taskId of taskIds) page = await window.etch.setTaskCategory(taskId, category)
      if (page) commitQueuePage(page)
    } catch (caught) {
      setTaskActionError(caught instanceof Error ? caught.message : '任务分类修改失败')
      await window.etch.queuePage().then(commitQueuePage).catch(() => undefined)
    }
  }

  const createCategoryFromName = async (name: string, onError: (message: string) => void): Promise<string | undefined> => {
    const result = createCategoryDraft(settings.taskCategories, name)
    if ('error' in result) {
      onError(result.error)
      return undefined
    }
    onError('')
    const saved = await saveCategories([...settings.taskCategories, result.category])
    return saved?.some((category) => category.id === result.category.id) ? result.category.id : undefined
  }

  const createInlineCategory = async (): Promise<void> => {
    const created = await createCategoryFromName(inlineCategoryName, setInlineCategoryError)
    if (!created) return
    setNewTaskCategory(created)
    setInlineCategoryName('')
    setInlineCategoryOpen(false)
  }

  const persistWorkbenchPreset = async (subtitlePreset: SubtitlePreset): Promise<void> => {
    if (!selected || presetSaveInFlightRef.current || settingsSaveInFlightRef.current) return
    if (selected.manifest.render.subtitlePreset === subtitlePreset) return
    const taskId = selected.manifest.taskId
    const expectedRevision = selected.manifest.revision
    const selectionGeneration = openTaskGenerationRef.current
    presetSaveInFlightRef.current = true
    setSavingPreset(true)
    const generation = ++presetSaveGenerationRef.current
    setTaskActionError('')
    try {
      const saved = await window.etch.updateSubtitlePreset(taskId, expectedRevision, subtitlePreset)
      if (generation !== presetSaveGenerationRef.current) return
      rememberDetail(saved)
      if (selectionGeneration !== openTaskGenerationRef.current) return
      setSelected((current) => current?.manifest.taskId === taskId && current.manifest.revision <= saved.manifest.revision ? saved : current)
    } catch (caught) {
      if (generation !== presetSaveGenerationRef.current || selectionGeneration !== openTaskGenerationRef.current) return
      setTaskActionError(caught instanceof Error ? caught.message : '字幕字号保存失败')
    } finally {
      presetSaveInFlightRef.current = false
      setSavingPreset(false)
    }
  }

  const updateToolOverride = (tool: ToolId, value: string): void => {
    setSettings((current) => {
      const toolOverrides = { ...current.toolOverrides }
      if (value.trim()) toolOverrides[tool] = value.trim()
      else delete toolOverrides[tool]
      return { ...current, toolOverrides }
    })
  }

  async function detectTools(retryInitial = false): Promise<void> {
    if (toolDetectionInFlightRef.current) return
    toolDetectionInFlightRef.current = true
    const generation = ++toolDetectionGenerationRef.current
    setDetectingTools(true)
    setToolDetectError('')
    try {
      const health = retryInitial
        ? await detectInitialToolsWithRetry(() => window.etch.detectTools(), {
            complete: (result) => tools.every((tool) => result.some((item) => item.tool === tool && item.status === 'ready')),
            shouldContinue: () => rendererMountedRef.current && generation === toolDetectionGenerationRef.current
          })
        : await window.etch.detectTools()
      if (rendererMountedRef.current && generation === toolDetectionGenerationRef.current) setToolHealth(health)
    } catch {
      if (rendererMountedRef.current && generation === toolDetectionGenerationRef.current) setToolDetectError('环境检测失败，请重试。')
    } finally {
      if (generation === toolDetectionGenerationRef.current) {
        toolDetectionInFlightRef.current = false
        if (rendererMountedRef.current) setDetectingTools(false)
      }
    }
  }

  async function runToolInstall(tool: InstallableTool): Promise<void> {
    if (installingTool) return
    setInstallingTool(tool)
    setInstallNote('')
    try {
      const result = await window.etch.installTool(tool)
      setInstallNote(result.outcome === 'homebrew-missing'
        ? '未检测到 Homebrew，已打开 brew.sh。装好 Homebrew 后再点安装。'
        : `已在终端开始安装 ${tool}，完成后回到这里点“重新检测”。`)
    } catch {
      setInstallNote(`无法启动 ${tool} 安装，请手动在终端执行 brew install。`)
    } finally {
      setInstallingTool(undefined)
    }
  }

  const dirtyCount = Object.keys(cueDrafts).length
  const selectedReviewPage = reviewPage?.taskId === selected?.manifest.taskId ? reviewPage : undefined
  const changeView = (next: View): void => {
    closeTaskContextMenu(false)
    if (!creatingTask) setNewTaskOpen(false)
    if ((dirtyCount || savingCues) && next !== 'workbench') {
      setReviewError('请先保存或放弃当前页的字幕修改。')
      return
    }
    if (glossaryBusyRef.current) {
      if (view === 'workbench') {
        deferredGlossaryActionRef.current = undefined
        setReviewError(MANUAL_GLOSSARY_NAV_MESSAGE)
        return
      }
      deferredGlossaryActionRef.current = () => changeView(next)
      return
    }
    if (next !== 'workbench') {
      openTaskGenerationRef.current += 1
      setOpeningTaskId(undefined)
      setPublishDialogOpen(false)
    }
    if (next !== 'settings') setBilibiliSettingsIntent(undefined)
    setReviewError('')
    setView(next)
  }

  changeViewRef.current = changeView

  const openBilibiliSettings = (intent: BilibiliSettingsIntent): void => {
    setBilibiliSettingsIntent(intent)
    changeView('settings')
  }

  const requestBilibiliPublish = (): void => {
    if (bilibiliAccount.status === 'connected') setPublishDialogOpen(true)
    else openBilibiliSettings('publish')
  }

  useEffect(() => {
    if (bilibiliSettingsIntent !== 'publish' || bilibiliAccount.status !== 'connected' || !selected) return
    setBilibiliSettingsIntent(undefined)
    changeViewRef.current('workbench')
    setPublishDialogOpen(true)
  }, [bilibiliSettingsIntent, bilibiliAccount.status, selected?.manifest.taskId])

  useEffect(() => window.etch.onOpenSettings(() => changeViewRef.current('settings')), [])

  useEffect(() => window.etch.onToolHealthChanged((health) => {
    setToolHealth((current) => mergeToolHealth(current, health))
  }), [])

  useEffect(() => {
    const dialog = newTaskDialogRef.current
    if (!dialog) return
    if (newTaskOpen && !dialog.open) {
      dialog.showModal()
      window.requestAnimationFrame(() => dialog.querySelector<HTMLTextAreaElement>('#content-url')?.focus())
    }
    if (!newTaskOpen && dialog.open) dialog.close()
  }, [newTaskOpen])

  useEffect(() => {
    const dialog = fullDiskAccessDialogRef.current
    if (!dialog) return
    if (fullDiskAccessGuideOpen && !dialog.open) dialog.showModal()
    if (!fullDiskAccessGuideOpen && dialog.open) dialog.close()
  }, [fullDiskAccessGuideOpen])

  // 用户去系统设置授完权回到 Etch 时重探；引导弹窗开着时额外轮询，
  // 让“已授权”在两个窗口并排时也能即时反映。
  useEffect(() => {
    const onFocus = (): void => {
      void refreshChromeCookieAccess()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshChromeCookieAccess])

  useEffect(() => {
    if (!fullDiskAccessGuideOpen) return
    const timer = window.setInterval(() => {
      void refreshChromeCookieAccess()
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [fullDiskAccessGuideOpen, refreshChromeCookieAccess])

  const openNewTask = (): void => {
    setError('')
    providerEditVersionRef.current += 1
    const nextProvider = resolveNewTaskProvider(loadLastNewTaskProvider(() => window.localStorage), settings.defaultProvider, toolHealth)
    setProvider(nextProvider)
    seedModelField(nextProvider)
    // 停在某个分类 tab 上新建时，默认就建到这个分类。
    setNewTaskCategory(findCategory(settings.taskCategories, categoryTab) ? categoryTab : '')
    setInlineCategoryOpen(false)
    setInlineCategoryName('')
    setInlineCategoryError('')
    setNewTaskOpen(true)
  }

  const closeNewTask = (): void => {
    if (creatingTask) return
    setNewTaskOpen(false)
    window.requestAnimationFrame(() => newTaskTriggerRef.current?.focus())
  }

  const closeFullDiskAccessGuide = (): void => {
    if (openingFullDiskAccessSettings || relaunchingApp) return
    setFullDiskAccessGuideOpen(false)
    // 只有仍未授权时才算“主动跳过”，避免下次启动继续打扰。
    if (chromeCookieAccess === 'denied') void window.etch.dismissFullDiskAccessGuide().catch(() => undefined)
  }

  const openFullDiskAccessGuide = (): void => {
    setFullDiskAccessGuideError('')
    setFullDiskAccessGuideOpen(true)
    void refreshChromeCookieAccess()
  }

  const requestChromeAccess = async (): Promise<void> => {
    if (openingFullDiskAccessSettings) return
    setOpeningFullDiskAccessSettings(true)
    setFullDiskAccessGuideError('')
    try {
      const completed = await window.etch.requestChromeCookieAccess()
      if (completed) setFullDiskAccessGuideOpen(false)
    } catch {
      setFullDiskAccessGuideError('无法打开系统设置，请手动前往“隐私与安全性 → 完全磁盘访问”。')
    } finally {
      setOpeningFullDiskAccessSettings(false)
    }
  }

  const relaunchEtch = async (): Promise<void> => {
    if (relaunchingApp) return
    setRelaunchingApp(true)
    setFullDiskAccessGuideError('')
    try {
      await window.etch.relaunchApp()
    } catch {
      setFullDiskAccessGuideError('自动重启失败，请手动完全退出并重新打开 Etch。')
      setRelaunchingApp(false)
    }
  }

  const updateCueDraft = (cueId: number, value: string, saved: string, english: string): void => {
    draftVersionRef.current += 1
    setCueSaveNotice('')
    setReviewError('')
    const nextConflicts = { ...cueConflictsRef.current }
    delete nextConflicts[cueId]
    cueConflictsRef.current = nextConflicts
    setCueConflicts(nextConflicts)
    setAutoSaveBlocked(Object.keys(nextConflicts).length > 0)
    if (value === saved) delete cueDraftBaselinesRef.current[cueId]
    else if (!cueDraftBaselinesRef.current[cueId]) cueDraftBaselinesRef.current[cueId] = { english, chinese: saved }
    const nextDrafts = { ...cueDraftsRef.current }
    if (value === saved) delete nextDrafts[cueId]
    else nextDrafts[cueId] = value
    cueDraftsRef.current = nextDrafts
    setCueDrafts(nextDrafts)
  }

  const saveCueEdits = async (): Promise<void> => {
    if (!selected || !selectedReviewPage || !dirtyCount || savingCues || cueSaveInFlightRef.current || selectedReviewPage.taskId !== selected.manifest.taskId) return
    cueSaveInFlightRef.current = true
    const taskId = selected.manifest.taskId
    const generation = ++cueSaveGenerationRef.current
    const submittedDrafts = { ...cueDraftsRef.current }
    const submittedBaselines = { ...cueDraftBaselinesRef.current }
    const submittedVersion = draftVersionRef.current
    const compareBaselines = (page: TaskReviewPage): { unchanged: boolean; conflicts: Record<number, { english: string; chinese: string }> } => {
      const latestByCue = new Map(page.items.map((cue) => [cue.cueId, cue]))
      const conflicts: Record<number, { english: string; chinese: string }> = {}
      let unchanged = true
      for (const cueIdText of Object.keys(submittedDrafts)) {
        const cueId = Number(cueIdText)
        const baseline = submittedBaselines[cueId]
        const latest = latestByCue.get(cueId)
        if (!baseline || !latest || latest.english !== baseline.english || latest.chinese !== baseline.chinese) {
          unchanged = false
          if (latest) conflicts[cueId] = { english: latest.english, chinese: latest.chinese }
        }
      }
      return { unchanged, conflicts }
    }
    const markBaselineConflict = (conflicts: Record<number, { english: string; chinese: string }>): void => {
      for (const [cueIdText, latest] of Object.entries(conflicts)) cueDraftBaselinesRef.current[Number(cueIdText)] = latest
      cueConflictsRef.current = conflicts
      setCueConflicts(conflicts)
      setAutoSaveBlocked(true)
    }
    try {
      setSavingCues(true)
      setAutoSaveBlocked(false)
      setReviewError('')
      const edits = Object.entries(submittedDrafts).map(([cueId, translation]) => ({ cueId: Number(cueId), translation }))
      let detail: TaskDetail
      try {
        const currentBaseline = compareBaselines(selectedReviewPage)
        if (!currentBaseline.unchanged) {
          markBaselineConflict(currentBaseline.conflicts)
          throw new Error('字幕基线已更新，请核对当前英文和译文后手动重试保存。')
        }
        detail = await window.etch.updateCues(taskId, selected.manifest.revision, edits)
      } catch (caught) {
        if (!(caught instanceof Error) || !caught.message.includes('任务已被更新')) throw caught
        const latestPage = await window.etch.reviewPage(taskId, reviewOffset, REVIEW_PAGE_SIZE)
        if (generation !== cueSaveGenerationRef.current || latestPage.taskId !== taskId) return
        const latestBaseline = compareBaselines(latestPage)
        if (!latestBaseline.unchanged) {
          markBaselineConflict(latestBaseline.conflicts)
          const latestDetail = await window.etch.taskDetail(taskId)
          if (generation !== cueSaveGenerationRef.current || latestDetail.manifest.taskId !== taskId) return
          rememberDetail(latestDetail)
          setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= latestDetail.manifest.revision ? latestDetail : current))
          setReviewPage(latestPage)
          throw new Error('字幕基线已更新，请核对当前英文和译文后手动重试保存。')
        }
        detail = await window.etch.updateCues(taskId, latestPage.revision, edits)
      }
      rememberDetail(detail)
      if (generation !== cueSaveGenerationRef.current) return
      setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= detail.manifest.revision ? detail : current))
      const nextDrafts = { ...cueDraftsRef.current }
      for (const [cueId, translation] of Object.entries(submittedDrafts)) {
        if (nextDrafts[Number(cueId)] === translation) {
          delete nextDrafts[Number(cueId)]
          delete cueDraftBaselinesRef.current[Number(cueId)]
          delete cueConflictsRef.current[Number(cueId)]
        }
      }
      cueDraftsRef.current = nextDrafts
      setCueDrafts(nextDrafts)
      setCueConflicts({ ...cueConflictsRef.current })
      const page = await window.etch.reviewPage(taskId, reviewOffset, REVIEW_PAGE_SIZE)
      if (generation !== cueSaveGenerationRef.current || page.taskId !== taskId) return
      setReviewPage(page)
      setCueSaveNotice('已自动保存')
      if (cueSaveNoticeTimerRef.current) window.clearTimeout(cueSaveNoticeTimerRef.current)
      cueSaveNoticeTimerRef.current = window.setTimeout(() => setCueSaveNotice(''), 2_000)
    } catch (caught) {
      if (generation === cueSaveGenerationRef.current) {
        setReviewError(caught instanceof Error ? caught.message : '字幕修改保存失败')
        if (draftVersionRef.current === submittedVersion) setAutoSaveBlocked(true)
      }
    } finally {
      cueSaveInFlightRef.current = false
      if (generation === cueSaveGenerationRef.current) setSavingCues(false)
    }
  }

  const saveGlossaryEdits = async (taskId: string, expectedRevision: number, edits: GlossaryEdit[]): Promise<number> => {
    const previous = glossarySaveQueuesRef.current.get(taskId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => gate)
    glossarySaveQueuesRef.current.set(taskId, queued)
    await previous

    const mergeLoadedPage = (current: TaskReviewPage | undefined, canonical: TaskReviewPage, revision: number): TaskReviewPage | undefined => {
      if (current?.taskId !== taskId || current.revision > revision) return current
      return {
        ...current,
        revision,
        glossary: canonical.glossary,
        glossaryState: canonical.glossaryState,
        glossaryEditable: canonical.glossaryEditable,
        glossaryEditMessage: canonical.glossaryEditMessage
      }
    }
    const syncCanonical = async (detail: TaskDetail): Promise<number> => {
      const canonical = await window.etch.reviewPage(taskId, 0, 1)
      const revision = canonical.revision
      rememberDetail(detail)
      setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= detail.manifest.revision ? detail : current))
      setReviewPage((current) => mergeLoadedPage(current, canonical, revision))
      return revision
    }

    try {
      let detail: TaskDetail
      try {
        detail = await window.etch.updateGlossary(taskId, expectedRevision, edits)
      } catch (caught) {
        if (!(caught instanceof Error) || !caught.message.includes('请刷新后重试')) throw caught
        const latestDetail = await window.etch.taskDetail(taskId)
        const latest = await window.etch.reviewPage(taskId, 0, 1)
        rememberDetail(latestDetail)
        setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= latestDetail.manifest.revision ? latestDetail : current))
        setReviewPage((current) => mergeLoadedPage(current, latest, latest.revision))
        if (!glossaryMatchesEdits(latest.glossary, edits)) throw new Error('术语表已在其他位置更新；当前草稿已保留，请选择载入最新版本或覆盖')
        detail = await window.etch.updateGlossary(taskId, latest.revision, edits)
      }
      return await syncCanonical(detail)
    } finally {
      release()
      if (glossarySaveQueuesRef.current.get(taskId) === queued) glossarySaveQueuesRef.current.delete(taskId)
    }
  }

  const previewGlossaryImpact = async (taskId: string, expectedRevision: number, edits: GlossaryEdit[]): Promise<GlossaryImpactPreview> => {
    if (selected?.manifest.taskId !== taskId) throw new Error('当前任务已切换，请重新打开术语表')
    if (dirtyCount || savingCues || autoSaveBlocked) throw new Error('请先等待当前字幕修改保存完成，再预览术语的全局影响')
    return window.etch.previewGlossaryApply(taskId, expectedRevision, edits)
  }

  const applyGlossaryToCues = async (
    taskId: string,
    expectedRevision: number,
    impactFingerprint: string,
    edits: GlossaryEdit[],
  ): Promise<GlossaryApplyResult> => {
    if (selected?.manifest.taskId !== taskId) throw new Error('当前任务已切换，请重新打开术语表')
    if (dirtyCount || savingCues || autoSaveBlocked) throw new Error('请先等待当前字幕修改保存完成，再应用术语修改')
    setReviewError('')
    const result = await window.etch.applyGlossary(taskId, expectedRevision, impactFingerprint, edits)
    rememberDetail(result.detail)
    setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= result.detail.manifest.revision ? result.detail : current))

    draftVersionRef.current += 1
    cueSaveGenerationRef.current += 1
    cueDraftsRef.current = {}
    cueDraftBaselinesRef.current = {}
    cueConflictsRef.current = {}
    setCueDrafts({})
    setCueConflicts({})
    setAutoSaveBlocked(false)

    try {
      const latestPage = await window.etch.reviewPage(taskId, reviewOffset, REVIEW_PAGE_SIZE)
      if (selected?.manifest.taskId === taskId && latestPage.taskId === taskId) setReviewPage(latestPage)
    } catch (caught) {
      setReviewError(`术语已应用，但字幕页刷新失败：${caught instanceof Error ? caught.message : '请稍后重试'}`)
    }

    const impactCounts = glossaryImpactCounts(result.preview)
    setCueSaveNotice(impactCounts.unmatched
      ? `已同步 ${impactCounts.changed} 条译文；${impactCounts.unmatched} 个 cue 含未命中术语，未命中片段保持不变`
      : `已同步 ${impactCounts.changed} 条译文`)
    if (cueSaveNoticeTimerRef.current) window.clearTimeout(cueSaveNoticeTimerRef.current)
    cueSaveNoticeTimerRef.current = window.setTimeout(() => setCueSaveNotice(''), 3_000)
    return result
  }

  const completeReview = async (): Promise<void> => {
    if (!selected || completingReviewRef.current) return
    const isDocument = selected.manifest.kind === 'document'
    const reviewStage = getStage(selected, 'review')
    const expectedCheckpoint = isDocument ? 'document-review' : 'manual-review'
    if (reviewStage.status !== 'checkpoint' || reviewStage.checkpointId !== expectedCheckpoint) {
      setTaskActionError('任务当前不在人工校对 checkpoint。')
      return
    }
    if (!isDocument && (dirtyCount || savingCues || autoSaveBlocked)) {
      setTaskActionError('请先等待字幕修改保存完成，并处理所有保存冲突。')
      return
    }
    if (!isDocument && glossaryBusyRef.current) {
      setTaskActionError('术语修改仍是草稿，请先预览并应用，或放弃修改。')
      return
    }
    if (!isDocument && (reviewLoading || selectedReviewPage?.availability !== 'ready' || selectedReviewPage.revision !== selected.manifest.revision)) {
      setTaskActionError('字幕校对数据尚未就绪，请等待加载完成。')
      return
    }

    const taskId = selected.manifest.taskId
    const selectionGeneration = openTaskGenerationRef.current
    completingReviewRef.current = true
    setCompletingReview(true)
    try {
      setTaskActionError('')
      await ensureRecoveryReleased()
      if (selectionGeneration !== openTaskGenerationRef.current) return
      const detail = await window.etch.completeReview(taskId, selected.manifest.revision)
      rememberDetail(detail)
      if (selectionGeneration === openTaskGenerationRef.current) {
        setSelected((current) => (current?.manifest.taskId === taskId && current.manifest.revision <= detail.manifest.revision ? detail : current))
      }
    } catch (caught) {
      if (selectionGeneration === openTaskGenerationRef.current) setTaskActionError(caught instanceof Error ? caught.message : `${isDocument ? '文档' : '字幕'}校对确认失败`)
    } finally {
      completingReviewRef.current = false
      if (selectionGeneration === openTaskGenerationRef.current) setCompletingReview(false)
    }
  }

  const queueDocumentTranslationSave = (markdown: string): void => {
    if (!selected || selected.manifest.kind !== 'document') return
    setDocumentPageError('')
    const taskId = selected.manifest.taskId
    const selectionGeneration = openTaskGenerationRef.current
    if (documentDraftTimerRef.current) window.clearTimeout(documentDraftTimerRef.current)
    documentDraftTimerRef.current = window.setTimeout(() => {
      documentSaveQueueRef.current = documentSaveQueueRef.current.then(async () => {
        const current = queueDetailsRef.current[taskId]
        if (!current || current.manifest.kind !== 'document') return
        try {
          setDocumentPageError('')
          await ensureRecoveryReleased()
          const detail = await window.etch.updateDocumentTranslation(taskId, current.manifest.revision, markdown)
          rememberDetail(detail)
          if (selectionGeneration === openTaskGenerationRef.current) {
            setSelected((active) => active?.manifest.taskId === taskId ? detail : active)
            const page = await window.etch.documentPage(taskId)
            if (selectionGeneration === openTaskGenerationRef.current) setDocumentPage(page)
          }
        } catch (caught) {
          if (selectionGeneration === openTaskGenerationRef.current) {
            setDocumentPageError(caught instanceof Error ? caught.message : '文档修改保存失败')
          }
        }
      })
    }, CUE_AUTO_SAVE_DELAY_MS)
  }

  const environmentSummary = detectingTools ? '环境检测中' : toolDetectError ? '环境检测失败' : toolHealth.length ? `环境 ${toolHealth.filter((item) => item.status === 'ready').length}/${tools.length} 可用` : '环境待检测'
  const environmentStatus = detectingTools ? 'checking' : toolDetectError ? 'error' : toolHealth.length === tools.length && toolHealth.every((item) => item.status === 'ready') ? 'ready' : 'warning'
  const defaultProvider = providerOrDefault(settings.defaultProvider)
  const defaultProviderAvailability = providerAvailability(defaultProvider, toolHealth)
  const selectedProviderAvailability = providerAvailability(provider, toolHealth)
  const taskNeedsAgent = taskKind !== 'document' || documentMode !== 'convert'
  const documentModeHint = documentMode === 'auto'
    ? '按正文语言自动决定'
    : documentMode === 'translate'
      ? '始终生成中文译文'
      : '仅提取与整理'
  const taskAgentHint = !taskNeedsAgent
    ? '当前模式只转换结构，不会调用 Agent'
    : taskKind === 'document' && documentMode === 'auto'
      ? `按需调用 · ${selectedProviderAvailability.summary ?? '运行时校验登录状态'}`
      : selectedProviderAvailability.summary ?? '使用本机 CLI；登录态在运行时校验'
  const selectedIsRunning = selected ? Object.values(selected.manifest.pipeline.stages).some((stage) => stage.status === 'running') : false
  const relatedSummary = selected
    ? queue.items.find((item) => selected.manifest.kind !== 'document'
      && item.kind !== 'document'
      && (item.rootTaskId ?? item.taskId) === selected.manifest.lineage.rootTaskId
      && item.kind !== selected.manifest.kind)
    : undefined
  const relatedOutput = relatedSummary ? queueDetails[relatedSummary.taskId] : undefined
  const runningTaskCount = queue.items.filter((item) => item.status === 'running').length
  const selectedIsPaused = Boolean(selected?.manifest.runtime.userPaused)
  const needsRebuild = selected?.manifest.kind === 'subtitle'
    ? (['srt', 'burn', 'verify'] as StageId[]).some((id) => getStage(selected, id).status === 'stale')
    : false
  const permissionGuide = permissionGuideCopy(chromeCookieAccess)
  const enteredUrlCount = new Set(url.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)).size
  const categories = settings.taskCategories
  const categoryTotals = categoryCounts(categories, queue.items)
  const activeCategoryTab = resolveTab(categories, categoryTab, categoryTotals.unsorted)
  const activeCategory = findCategory(categories, activeCategoryTab)
  const visibleTasks = queue.items.filter((item) => taskMatchesTab(categories, item.category, activeCategoryTab))
  const pickedVisibleTaskIds = pickedTaskIds.filter((taskId) => visibleTasks.some((item) => item.taskId === taskId))
  // 右键菜单只在单选时显示当前分类的勾选；批量归类的“当前值”本来就不唯一。
  const menuTask = taskContextMenu?.taskIds.length === 1 ? queue.items.find((item) => item.taskId === taskContextMenu.taskIds[0]) : undefined
  const currentMenuCategory = menuTask ? effectiveCategory(categories, menuTask.category) : undefined

  useEffect(() => {
    if (!dirtyCount || savingCues || autoSaveBlocked || selectedIsRunning || view !== 'workbench') return
    const timer = window.setTimeout(() => {
      void saveCueEdits()
    }, CUE_AUTO_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [cueDrafts, savingCues, autoSaveBlocked, selectedIsRunning, view, selected?.manifest.taskId, selected?.manifest.revision, selectedReviewPage?.revision])

  useEffect(
    () => () => {
      if (cueSaveNoticeTimerRef.current) window.clearTimeout(cueSaveNoticeTimerRef.current)
    },
    [],
  )

  const pageEyebrow = view === 'glossary' ? '跨任务一致性词库' : view === 'settings' ? '应用配置' : '本地双语字幕流水线'
  const pageTitle = view === 'queue' ? '任务队列' : view === 'glossary' ? '统一术语表' : '设置'

  const changeGlossaryQuery = (query: string): void => {
    setGlossaryQuery(query)
    setGlossaryOffset(0)
  }

  const changeGlossaryOffset = (offset: number): void => {
    setGlossaryOffset(offset)
  }

  const deleteGlobalGlossaryEntry = async (entryId: string, expectedRevision: number): Promise<void> => {
    try {
      await window.etch.deleteGlossaryEntry(entryId, expectedRevision)
    } catch (caught) {
      if (!(caught instanceof Error) || !caught.message.includes('术语库已更新')) throw caught
      setGlossaryCatalog(await window.etch.glossaryCatalogPage(glossaryQuery, glossaryOffset))
      throw new Error('术语库刚刚更新，请再次确认删除')
    }
    const page = await window.etch.glossaryCatalogPage(glossaryQuery, glossaryOffset)
    if (page.total > 0 && page.items.length === 0 && page.offset >= page.total) {
      setGlossaryOffset(Math.floor((page.total - 1) / GLOSSARY_CATALOG_PAGE_SIZE) * GLOSSARY_CATALOG_PAGE_SIZE)
      return
    }
    setGlossaryCatalog(page)
  }

  const glossaryCatalogPanel = (
    <GlossaryCatalog
      query={glossaryQuery}
      offset={glossaryOffset}
      catalog={glossaryCatalog}
      loading={glossaryCatalogLoading}
      error={glossaryCatalogError}
      onQueryChange={changeGlossaryQuery}
      onOffsetChange={changeGlossaryOffset}
      onDelete={deleteGlobalGlossaryEntry}
    />
  )
  const runtimeDiagnostics = bootstrap?.startupDiagnostics
  const runtimeDiagnosticCount = (runtimeDiagnostics?.discoveryErrors.length ?? 0)
    + (runtimeDiagnostics?.identityConflicts.length ?? 0)

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand" aria-label="Etch 首页">
          <span>Etch</span>
        </div>
        <nav>
          <button className={`nav-item ${view === 'queue' || view === 'workbench' ? 'is-active' : ''}`} type="button" onClick={() => changeView('queue')}>
            <Icon name="queue" />
            任务队列<span className="nav-count">{queue.total}</span>
          </button>
          <button className={`nav-item ${view === 'glossary' ? 'is-active' : ''}`} type="button" onClick={() => changeView('glossary')}>
            <Icon name="glossary" />
            统一术语表
          </button>
        </nav>
        <div className="runtime-state">
          <span className="status-dot" data-status={environmentStatus} aria-hidden="true" />
          <div>
            <strong>{environmentSummary}</strong>
            <span>{bootstrap ? `${bootstrap.arch} · v${bootstrap.version}` : '正在读取…'}</span>
          </div>
        </div>
      </aside>

      <main className={`main-panel is-${view}`}>
        {view !== 'workbench' && (
          <header className="page-header">
            <div>
              <p className="eyebrow">{pageEyebrow}</p>
              <h1>{pageTitle}</h1>
            </div>
            {view === 'queue' && (
              <button className="primary-button" ref={newTaskTriggerRef} type="button" onClick={openNewTask}>
                <Icon name="plus" />
                新建任务
              </button>
            )}
          </header>
        )}

        {view === 'queue' && (
          <>
            <section className="queue-section" aria-labelledby="queue-title">
              {runtimeDiagnosticCount > 0 && !diagnosticsDismissed && runtimeDiagnostics && (
                <aside className="runtime-diagnostics" aria-label="运行诊断">
                  <div>
                    <strong>有 {runtimeDiagnosticCount} 项运行诊断</strong>
                    {runtimeDiagnostics.discoveryErrors.map((diagnostic) => (
                      <p key={`${diagnostic.code}:${diagnostic.location}`}>{diagnostic.location}：{diagnostic.summary}</p>
                    ))}
                    {runtimeDiagnostics.identityConflicts.map((conflict) => (
                      <p key={conflict.taskId}>任务 ID {conflict.taskId} 存在 {conflict.locations.length} 个副本，已从正常队列隔离。</p>
                    ))}
                  </div>
                  <button type="button" className="secondary-button" onClick={() => setDiagnosticsDismissed(true)}>隐藏</button>
                </aside>
              )}
              {runtimeDiagnosticCount > 0 && diagnosticsDismissed && (
                <button type="button" className="diagnostics-reopen" onClick={() => setDiagnosticsDismissed(false)}>
                  查看 {runtimeDiagnosticCount} 项运行诊断
                </button>
              )}
              <div className="section-heading queue-heading">
                <h2 className="sr-only" id="queue-title">全部任务</h2>
                <div className="category-bar">
                  <div className="category-tabs" role="tablist" aria-label="任务分类">
                    <button
                      className="category-tab"
                      type="button"
                      role="tab"
                      aria-selected={activeCategoryTab === ALL_TASKS_TAB}
                      onClick={() => setCategoryTab(ALL_TASKS_TAB)}
                    >
                      全部任务<span className="tab-count mono">{queue.total}</span>
                    </button>
                    {(categoryTotals.unsorted > 0 || categories.length > 0) && <span className="category-tab-divider" aria-hidden="true" />}
                    {categoryTotals.unsorted > 0 && (
                      <button
                        className="category-tab"
                        type="button"
                        role="tab"
                        aria-selected={activeCategoryTab === UNSORTED_TAB}
                        onClick={() => setCategoryTab(UNSORTED_TAB)}
                      >
                        未分类<span className="tab-count mono">{categoryTotals.unsorted}</span>
                      </button>
                    )}
                    {categories.map((category) => (
                      <button
                        className="category-tab"
                        data-category-color={category.color}
                        type="button"
                        role="tab"
                        key={category.id}
                        aria-selected={activeCategoryTab === category.id}
                        onClick={() => setCategoryTab(category.id)}
                      >
                        <i className="cat-dot" aria-hidden="true" />
                        <span>{category.name}</span>
                        <span className="tab-count mono">{categoryTotals.byCategory[category.id] ?? 0}</span>
                      </button>
                    ))}
                  </div>
                  <button className="category-manage-button" type="button" onClick={() => setCategoryDialogOpen(true)}>
                    <Icon name="settings" />
                    {categories.length ? '管理' : '新建分类'}
                  </button>
                </div>
                <p className="sub">
                  {runningTaskCount ? `${runningTaskCount} 个运行中` : settings.queuePaused ? '队列已暂停' : '队列空闲'}
                </p>
              </div>
              {queueError && (
                <p className="review-error queue-error" role="alert">
                  {queueError}
                </p>
              )}
              {taskActionError && (
                <p className="review-error queue-error" role="alert">
                  {taskActionError}
                </p>
              )}
              {queue.items.length ? (
                <div className="task-list">
                  {visibleTasks.map((task) => {
                    const detail = queueDetails[task.taskId]
                    const stages = detail ? taskStages(detail) : STAGE_ORDER
                    const stageTotal = stages.length
                    const done = detail ? completedStageCount(detail) : 0
                    const progress = detail ? stages.reduce((total, id) => {
                      const stage = getStage(detail, id)
                      if (stage.status === 'completed' || stage.status === 'skipped') return total + 1
                      return stage.status === 'running' ? total + (stage.progress ?? 0) : total
                    }, 0) : 0
                    const status = detail?.manifest.translation.auditCheckpoint ? 'checkpoint' : task.status
                    const providerId = detail?.manifest.translation.selectedProvider
                    const thumbnailArtifact = detail ? taskThumbnailArtifact(detail.manifest) : undefined
                    const thumbnailState = taskThumbnails[task.taskId]
                    const thumbnailDataUrl = thumbnailArtifact?.valid && thumbnailState?.sha256 === thumbnailArtifact.sha256 ? thumbnailState.dataUrl : undefined
                    const isDocument = task.kind === 'document'
                    const sourceKind = isDocument
                      ? detail?.manifest.document.resolvedSource === 'x-article'
                        ? 'X Article'
                        : detail?.manifest.document.resolvedSource === 'x-post'
                          ? 'X 帖子'
                          : '网页'
                      : detail?.manifest.input.kind === 'local' ? '本地视频' : detail?.manifest.input.kind === 'url' ? 'URL 视频' : '来源读取中'
                    const sourceName = detail ? (detail.manifest.input.kind === 'url' ? detail.manifest.input.url : detail.manifest.input.sourcePath) : ''
                    const updatedAt = new Date(task.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
                    const taskIsStarting = task.taskId in startingTaskIds
                    const taskIsRunning = task.status === 'running' || Boolean(detail && Object.values(detail.manifest.pipeline.stages).some((stage) => stage.status === 'running'))
                    const taskHasCheckpoint = status === 'checkpoint' || Boolean(detail && Object.values(detail.manifest.pipeline.stages).some((stage) => stage.status === 'checkpoint'))
                    const taskNeedsRebuild = Boolean(detail?.manifest.kind === 'subtitle' && (['srt', 'burn', 'verify'] as StageId[]).some((id) => getStage(detail, id).status === 'stale'))
                    const taskIsComplete = task.status === 'completed' || Boolean(detail && getStage(detail, lastStageForKind(detail.manifest.kind)).status === 'completed' && !taskNeedsRebuild)
                    const queueActionLabel = taskIsRunning
                      ? '处理中'
                      : taskIsStarting
                        ? '正在启动…'
                        : taskHasCheckpoint
                          ? '需要确认'
                          : taskIsComplete
                            ? '已完成'
                            : detail?.manifest.runtime.userPaused
                              ? '继续处理'
                              : taskNeedsRebuild
                                ? '重新生成'
                                : '开始处理'
                    return (
                      <article
                        className={`task-row row-hover ${selected?.manifest.taskId === task.taskId ? 'is-selected' : ''} ${openingTaskId === task.taskId ? 'is-opening' : ''} ${taskContextMenu?.taskIds.includes(task.taskId) ? 'is-context' : ''} ${pickedVisibleTaskIds.includes(task.taskId) ? 'is-picked' : ''}`}
                        data-task-id={task.taskId}
                        aria-busy={openingTaskId === task.taskId}
                        key={task.taskId}
                      >
                        <button
                          className="task-row-open"
                          aria-label={`打开工作台：${task.title}`}
                          aria-haspopup="menu"
                          type="button"
                          onClick={(event) => {
                            // ⌘ / Ctrl 点击只多选，不进工作台；多选只用于批量归类。
                            if (event.metaKey || event.ctrlKey) {
                              setPickedTaskIds((current) => current.includes(task.taskId)
                                ? current.filter((taskId) => taskId !== task.taskId)
                                : [...current, task.taskId])
                              return
                            }
                            setPickedTaskIds([])
                            void openTask(task.taskId)
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            taskContextTriggerRef.current = event.currentTarget
                            const menuWidth = 270
                            const menuHeight = 180
                            const edge = 8
                            setCategoryMenuOpen(false)
                            setTaskContextMenu({
                              taskId: task.taskId,
                              title: task.title,
                              x: Math.max(edge, Math.min(event.clientX, window.innerWidth - menuWidth - edge)),
                              y: Math.max(edge, Math.min(event.clientY, window.innerHeight - menuHeight - edge)),
                              running: taskIsRunning,
                              taskIds: pickedVisibleTaskIds.length > 1 && pickedVisibleTaskIds.includes(task.taskId) ? [...pickedVisibleTaskIds] : [task.taskId]
                            })
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                            event.preventDefault()
                            const bounds = event.currentTarget.getBoundingClientRect()
                            taskContextTriggerRef.current = event.currentTarget
                            setCategoryMenuOpen(false)
                            setTaskContextMenu({
                              taskId: task.taskId,
                              title: task.title,
                              x: Math.min(bounds.left + 28, window.innerWidth - 278),
                              y: Math.min(bounds.top + 28, window.innerHeight - 188),
                              running: taskIsRunning,
                              taskIds: pickedVisibleTaskIds.length > 1 && pickedVisibleTaskIds.includes(task.taskId) ? [...pickedVisibleTaskIds] : [task.taskId]
                            })
                          }}
                        />
                        <span className={`thumb ${thumbnailDataUrl ? 'has-image' : ''}`} aria-hidden="true">
                          {thumbnailArtifact && thumbnailDataUrl && (
                            <img
                              src={thumbnailDataUrl}
                              alt=""
                              draggable={false}
                              onError={() => {
                                const current = taskThumbnailsRef.current[task.taskId]
                                if (current?.sha256 !== thumbnailArtifact.sha256 || !current.dataUrl) return
                                const next = { ...taskThumbnailsRef.current, [task.taskId]: { sha256: thumbnailArtifact.sha256 } }
                                taskThumbnailsRef.current = next
                                setTaskThumbnails(next)
                              }}
                            />
                          )}
                          {!thumbnailDataUrl && (
                            <span className="thumb-placeholder">
                              <Icon name={isDocument ? 'document' : 'play'} />
                              <small>{isDocument ? 'Markdown 文档' : '等待视频封面'}</small>
                            </span>
                          )}
                          <span className="pill task-cover-status" data-status={status}>
                            {taskStatusText(detail, task.status)}
                          </span>
                          {!isDocument && <span className="dur mono">{durationLabel(detail?.manifest.runtime.durationSeconds)}</span>}
                        </span>
                        <span className="task-meta">
                          <span className="task-card-overline">
                            <span>{detail?.manifest.kind === 'document' && detail.manifest.document.processingMode === 'convert'
                              ? '无需 Provider'
                              : providerId ? providerNames[providerId] : 'Provider 读取中'}</span>
                            <span className="dot-sep" />
                            <span>{taskKindLabel(task.kind)}</span>
                            <span className="dot-sep" />
                            <span>{sourceKind}</span>
                          </span>
                          <strong className="task-title" title={task.title}>
                            {task.title}
                          </strong>
                          <span className="task-card-message">
                            {detail ? detail.manifest.runtime.currentMessage : queueDetailFailures[task.taskId] ? '任务详情读取失败' : '正在读取任务详情'}
                          </span>
                          {sourceName && (
                            <span className="task-source-preview mono" title={sourceName}>
                              <Icon name={detail?.manifest.input.kind === 'local' ? 'local' : 'link'} />
                              <span>{sourceName}</span>
                            </span>
                          )}
                          <span className="task-card-tags">
                            {(() => {
                              const category = findCategory(categories, task.category)
                              return category
                                ? (
                                  <span className="category-chip" data-category-color={category.color} title={`分类：${category.name}`}>
                                    <i className="cat-dot" aria-hidden="true" />
                                    <span>{category.name}</span>
                                  </span>
                                )
                                : <span className="category-chip is-unsorted">未分类</span>
                            })()}
                            <span className="src-chip">
                              {detail ? <Icon name={detail.manifest.input.kind === 'local' ? 'local' : 'link'} /> : null}
                              {detail ? (detail.manifest.input.kind === 'url' ? 'URL' : '本地') : '来源 —'}
                            </span>
                            <span className="task-tag">{detail
                              ? detail.manifest.kind === 'document'
                                ? detail.manifest.document.sourceLanguage
                                  ? `${detail.manifest.document.sourceLanguage} → 中文`
                                  : '语言识别中'
                                : subtitleKindLabel(detail.manifest.runtime.subtitleKind)
                              : queueDetailFailures[task.taskId] ? '详情读取失败' : isDocument ? '正文读取中' : '字幕读取中'}</span>
                            {detail?.manifest.kind === 'subtitle' && (detail.manifest.publication.autoPublish || detail.manifest.publication.status !== 'idle') && (
                              <span className="publication-chip" data-status={detail.manifest.publication.status}>{bilibiliPublicationText(detail)}</span>
                            )}
                          </span>
                          <span className="task-card-footer">
                            <span className="id mono">{task.taskId.slice(0, 8)}</span>
                            {!isDocument && detail?.manifest.runtime.uploadDate && (
                              <span className="task-published mono" title="视频发布时间">发布 {detail.manifest.runtime.uploadDate}</span>
                            )}
                            <span className="task-updated mono">更新于 {updatedAt}</span>
                          </span>
                          <span className="task-card-action-row">
                            <span className="task-progress-copy">
                              <span>{done} / {stageTotal} 阶段</span>
                            </span>
                            <button
                              className="task-start-button"
                              type="button"
                              aria-label={`${queueActionLabel}：${task.title}`}
                              disabled={!detail || taskIsStarting || taskIsRunning || taskHasCheckpoint || taskIsComplete}
                              onClick={() => {
                                void startQueuedTask(task.taskId)
                              }}
                            >
                              <Icon name="play" />
                              {queueActionLabel}
                            </button>
                          </span>
                          <span className={`task-mini-progress ${done === stageTotal ? 'is-done' : ''}`}>
                            <i style={{ width: `${(progress / stageTotal) * 100}%` }} />
                          </span>
                        </span>
                      </article>
                    )
                  })}
                </div>
              ) : !queueError ? (
                <div className="empty-state">
                  <div className="empty-icon" aria-hidden="true">
                    <Icon name="empty" />
                  </div>
                  <h3>还没有内容任务</h3>
                  <p>粘贴一个视频、网页或 X 链接。Etch 会保留中间产物，并在可恢复边界提交结果。</p>
                  <button className="text-button" type="button" onClick={openNewTask}>
                    粘贴内容链接
                  </button>
                </div>
              ) : null}
              {queue.items.length > 0 && visibleTasks.length === 0 && activeCategory && (
                <div className="empty-state">
                  <div className="empty-icon" aria-hidden="true">
                    <Icon name="tag" />
                  </div>
                  <h3>「{activeCategory.name}」下还没有任务</h3>
                  <p>右键任意任务卡片选「移动到分类」，或者新建任务时直接选这个分类。分类只改归档位置，不会动任何产物。</p>
                  <button className="text-button" type="button" onClick={openNewTask}>
                    新建任务到「{activeCategory.name}」
                  </button>
                </div>
              )}
              {pickedVisibleTaskIds.length > 1 && (
                <div className="queue-selection-bar">
                  <div>
                    <strong>已选 {pickedVisibleTaskIds.length} 个任务</strong>
                    <span>⌘ 点击继续加选 · 右键选「移动到分类」批量归类</span>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => setPickedTaskIds([])}>取消选择</button>
                </div>
              )}
            </section>
          </>
        )}

        {view === 'workbench' && selected?.manifest.kind === 'document' && (
          <DocumentWorkbench
            detail={selected}
            page={documentPage}
            loading={documentPageLoading}
            error={documentPageError || taskActionError}
            onBack={() => changeView('queue')}
            onTranslationDraftChange={queueDocumentTranslationSave}
            onStart={startSelected}
            onStop={stopSelected}
            onOpenSource={(taskId) => window.etch.openDocumentSource(taskId)}
            onCompleteReview={() => completeReview()}
            onResolveTranslationCost={(_taskId, _revision, decision) => resolveIllustration((taskId, revision) => window.etch.resolveDocumentTranslationCost(taskId, revision, decision))}
            onExport={(taskId) => window.etch.exportDocument(taskId)}
          />
        )}
        {view === 'workbench' && selected?.manifest.kind !== 'document' && (
          <WorkbenchView
            selected={selected}
            relatedOutput={relatedOutput}
            settings={selected ? { ...settings, subtitlePreset: selected.manifest.render.subtitlePreset } : settings}
            settingsLoaded={settingsLoaded}
            taskActionError={taskActionError}
            dirtyCount={dirtyCount}
            reviewPage={selectedReviewPage}
            reviewLoading={reviewLoading}
            reviewError={reviewError}
            reviewOffset={reviewOffset}
            cueDrafts={cueDrafts}
            cueConflicts={cueConflicts}
            savingCues={savingCues}
            autoSaveBlocked={autoSaveBlocked}
            cueSaveNotice={cueSaveNotice}
            resolvingAudit={resolvingAudit}
            resolvingIllustration={resolvingIllustration}
            completingReview={completingReview}
            savingPreset={savingPreset || savingSettings}
            glossaryBusy={glossaryBusy}
            selectedIsRunning={selectedIsRunning}
            selectedIsPaused={selectedIsPaused}
            stoppingTask={stoppingTask}
            creatingCompanion={creatingCompanion}
            publicationActionBusy={publicationActionBusy}
            bilibiliAccount={bilibiliAccount}
            needsRebuild={needsRebuild}
            chromeCookieAccess={chromeCookieAccess}
            toolHealth={toolHealth}
            videoRef={videoRef}
            onBack={() => changeView('queue')}
            onOpenOutput={openTask}
            onCreateCompanion={createCompanion}
            onStart={startSelected}
            onStop={stopSelected}
            onOpenPermissionGuide={openFullDiskAccessGuide}
            onPublish={requestBilibiliPublish}
            onStopPublication={stopPublication}
            onContinuePublication={continuePublication}
            onOpenCreatorCenter={() => window.etch.openBilibiliCreatorCenter()}
            onResolveAudit={resolveAudit}
            onResolveVideoCheckpoint={(decision) => resolveIllustration((taskId, revision) => window.etch.resolveVideoCheckpoint(taskId, revision, decision))}
            onResolveResearchCheckpoint={(decision) => resolveIllustration((taskId, revision) => window.etch.resolveResearchCheckpoint(taskId, revision, decision))}
            onResolveIllustrationAgent={(choice) => resolveIllustration((taskId, revision) => window.etch.resolveIllustrationAgent(taskId, revision, choice))}
            onResolveIllustrationCover={(decision) => resolveIllustration((taskId, revision) => window.etch.resolveIllustrationCover(taskId, revision, decision))}
            onCompleteReview={completeReview}
            onPreset={persistWorkbenchPreset}
            onDiscardCues={() => {
              draftVersionRef.current += 1
              setCueDrafts({})
              cueDraftsRef.current = {}
              cueDraftBaselinesRef.current = {}
              setCueConflicts({})
              cueConflictsRef.current = {}
              setAutoSaveBlocked(false)
              setReviewError('')
            }}
            onSaveCues={saveCueEdits}
            onCueDraftChange={updateCueDraft}
            onReviewOffsetChange={setReviewOffset}
            onSaveGlossary={saveGlossaryEdits}
            onPreviewGlossaryImpact={previewGlossaryImpact}
            onApplyGlossaryToCues={applyGlossaryToCues}
            onGlossaryBusyChange={handleGlossaryBusyChange}
          />
        )}
        {view === 'glossary' && (
          <div className="glossary-page">
            {glossaryCatalogPanel}
          </div>
        )}

        {view === 'settings' && (
          <section className="settings-view" aria-label="Etch 设置">
            {settingsError && (
              <p className="review-error settings-error" role="alert">
                {settingsError}
              </p>
            )}
            <section className="panel settings-card">
              <h2>执行与存储</h2>
              <div className="setting-row">
                <label className="label" htmlFor="settings-workspace-root">
                  <strong>工作区</strong>
                  <small>所有任务目录、中间产物与成片的根路径</small>
                </label>
                <input id="settings-workspace-root" className="field-input" disabled={!settingsLoaded} value={settings.workspaceRoot} onChange={(event) => setSettings({ ...settings, workspaceRoot: event.target.value })} />
              </div>
              <div className="setting-row">
                <label className="label" htmlFor="settings-default-provider">
                  <strong>默认 Provider</strong>
                  <small>{defaultProviderAvailability.summary ?? '选择新任务默认使用的本地 CLI'}</small>
                </label>
                <select id="settings-default-provider" className="field-select" disabled={!settingsLoaded} value={defaultProvider} onChange={(event) => setSettings({ ...settings, defaultProvider: event.target.value as ProviderId })}>
                  {PROVIDER_IDS.map((providerId) => {
                    const availability = providerAvailability(providerId, toolHealth)
                    return <option value={providerId} disabled={!availability.available} key={providerId}>{providerNames[providerId]}{!availability.available ? `（${availability.summary}）` : ''}</option>
                  })}
                </select>
              </div>
              <div className="setting-row">
                <span className="label">
                  <strong>默认模型</strong>
                  <small>{providerNames[defaultProvider]} 新任务的默认模型；切换默认 Provider 可分别配置</small>
                </span>
                <div className="setting-model-field">
                  <ModelField
                    idPrefix="settings-default"
                    label="模型"
                    state={settingsModelField}
                    catalog={settingsModelCatalog.catalog}
                    loading={settingsModelCatalog.loading}
                    disabled={!settingsLoaded}
                    onChange={(next) => {
                      setSettingsModelField(next)
                      const resolved = modelFieldSelection(next)
                      if (!resolved) return
                      setSettings({
                        ...settings,
                        defaultModelByProvider: { ...settings.defaultModelByProvider, [defaultProvider]: resolved }
                      })
                    }}
                  />
                </div>
              </div>
              <div className="setting-row">
                <span className="label">
                  <strong>允许队列领取新阶段</strong>
                  <small>关闭后，当前原子步骤完成即停在下一阶段前</small>
                </span>
                <div className="toggle-line">
                  <span className="mono">{settings.queuePaused ? '已暂停' : '运行中'}</span>
                  <SwitchControl label="允许队列领取新阶段" checked={!settings.queuePaused} disabled={!settingsLoaded} onChange={(checked) => setSettings({ ...settings, queuePaused: !checked })} />
                </div>
              </div>
              <div className="setting-row">
                <span className="label">
                  <strong>处理时阻止休眠</strong>
                  <small>队列运行期间持有电源 assertion</small>
                </span>
                <div className="toggle-line">
                  <span className="mono">{settings.preventSleep ? '已开启' : '已关闭'}</span>
                  <SwitchControl label="处理时阻止休眠" checked={settings.preventSleep} disabled={!settingsLoaded} onChange={(checked) => setSettings({ ...settings, preventSleep: checked })} />
                </div>
              </div>
            </section>

            <section className="panel settings-card">
              <h2>外观</h2>
              <div className="setting-row">
                <span className="label">
                  <strong>主题</strong>
                  <small>跟随系统时随 macOS 外观切换；硬字幕预览与封面不受主题影响</small>
                </span>
                <span className="seg" role="group" aria-label="主题">
                  {THEME_OPTIONS.map(([value, label]) => (
                    <button className={settings.theme === value ? 'is-active' : ''} type="button" disabled={!settingsLoaded} aria-pressed={settings.theme === value} onClick={() => setSettings({ ...settings, theme: value })} key={value}>
                      {label}
                    </button>
                  ))}
                </span>
              </div>
            </section>

            <section className="panel settings-card">
              <h2>系统通知</h2>
              {(
                [
                  ['completion', '成片完成'],
                  ['failure', '任务失败'],
                  ['checkpoint', '审计 checkpoint 待确认'],
                ] as const
              ).map(([key, label]) => (
                <div className="setting-row" key={key}>
                  <span className="label">
                    <strong>{label}</strong>
                  </span>
                  <div className="toggle-line">
                    <span />
                    <SwitchControl label={label} checked={settings.notifications[key]} disabled={!settingsLoaded} onChange={(checked) => setSettings({ ...settings, notifications: { ...settings.notifications, [key]: checked } })} />
                  </div>
                </div>
              ))}
            </section>

            <section className="panel settings-card">
              <div className="settings-card-heading">
                <div>
                  <h2>硬字幕字号预设</h2>
                  <p>控制新建任务的默认字号；已有任务在各自工作台中单独调整。中文为主行、英文为辅行。</p>
                </div>
              </div>
              <div className="preset-grid">
                {(['compact', 'standard', 'large'] as SubtitlePreset[]).map((preset) => (
                  <PresetDemo className="preset-card" preset={preset} active={settings.subtitlePreset === preset} disabled={!settingsLoaded} onClick={() => setSettings({ ...settings, subtitlePreset: preset })} key={preset} />
                ))}
              </div>
            </section>

            <BilibiliSettingsCard
              account={bilibiliAccount}
              settings={settings}
              disabled={!settingsLoaded || savingSettings || savingPreset}
              guidance={bilibiliSettingsIntent}
              onAccountChange={setBilibiliAccount}
              onSettingsChange={setSettings}
            />

            <section className="panel settings-card tools-card">
              <div className="settings-card-heading">
                <div>
                  <h2>本地工具</h2>
                  <p>留空使用自动探测；覆盖项必须是绝对 executable 路径。</p>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={detectingTools}
                  onClick={() => {
                    void detectTools()
                  }}
                >
                  {detectingTools ? '检测中…' : '重新检测'}
                </button>
              </div>
              {toolDetectError && (
                <p className="form-error" role="alert">
                  {toolDetectError}
                </p>
              )}
              {installNote && (
                <p className="tools-install-note" role="status">
                  {installNote}
                </p>
              )}
              <div className="tools-list">
                {tools.map((tool) => {
                  const health = toolHealth.find((item) => item.tool === tool)
                  const override = settings.toolOverrides[tool] ?? ''
                  const detectedPath = health?.executable
                  const canInstall = INSTALLABLE_TOOLS.has(tool) && Boolean(health) && health?.status !== 'ready'
                  return (
                    <label className="tool-row" key={tool}>
                      <span className="tname">
                        <strong>{tool}</strong>
                        <small data-status={health?.status}>{health?.summaryZh ?? '尚未检测'}</small>
                      </span>
                      <input className="path" disabled={!settingsLoaded} value={override} placeholder={detectedPath ? `自动 · ${detectedPath}` : '自动'} data-auto-path={!override && detectedPath ? 'true' : undefined} title={!override && detectedPath ? `自动检测路径：${detectedPath}` : undefined} aria-label={`${tool} executable 路径`} onChange={(event) => updateToolOverride(tool, event.target.value)} />
                      <span className="tool-row-end">
                        {canInstall && (
                          <button
                            className="tool-install-button"
                            type="button"
                            disabled={Boolean(installingTool)}
                            aria-label={`安装 ${tool}`}
                            onClick={(event) => { event.preventDefault(); void runToolInstall(tool as InstallableTool) }}
                          >
                            {installingTool === tool ? '打开终端…' : '安装'}
                          </button>
                        )}
                        <span className="tool-mini-dot" data-status={health?.status ?? 'pending'} aria-hidden="true" />
                      </span>
                    </label>
                  )
                })}
              </div>
            </section>
            <div className="settings-actions">
              <span>{savingSettings || savingPreset ? '正在保存…' : settingsSaved ? '已保存' : settingsLoaded ? '' : settingsError ? '读取失败' : '正在读取设置…'}</span>
              <button
                className="primary-button"
                type="button"
                disabled={!settingsLoaded || savingSettings || savingPreset}
                onClick={() => {
                  void saveSettings()
                }}
              >
                {savingSettings || savingPreset ? '保存中…' : '保存设置'}
              </button>
            </div>
          </section>
        )}
      </main>
      <dialog
        className="permission-dialog"
        data-access={chromeCookieAccess}
        ref={fullDiskAccessDialogRef}
        aria-labelledby="full-disk-access-title"
        aria-describedby="full-disk-access-description"
        onCancel={(event) => {
          event.preventDefault()
          closeFullDiskAccessGuide()
        }}
        onPointerDown={(event) => {
          if (event.currentTarget === event.target) closeFullDiskAccessGuide()
        }}
      >
        <section className="permission-guide">
          <div className="permission-guide-icon" aria-hidden="true">
            <Icon name={chromeCookieAccess === 'granted' ? 'check' : 'settings'} />
          </div>
          <div className="permission-guide-heading">
            <p className="eyebrow">{permissionGuide.eyebrow}</p>
            <h2 id="full-disk-access-title">{permissionGuide.title}</h2>
          </div>
          <p className="permission-guide-copy" id="full-disk-access-description">
            {permissionGuide.body}
          </p>
          {permissionGuide.steps.length > 0 && (
            <ol className="permission-guide-steps">
              {permissionGuide.steps.map((step, index) => (
                <li key={step}><span>{index + 1}</span><p>{step}</p></li>
              ))}
            </ol>
          )}
          <p className="permission-guide-privacy">
            Chrome 登录状态只在本机用于视频下载，不会由 Etch 上传。
          </p>
          {fullDiskAccessGuideError && <p className="permission-guide-error" role="alert">{fullDiskAccessGuideError}</p>}
          <footer className="permission-guide-actions">
            <button className="secondary-button" type="button" disabled={openingFullDiskAccessSettings || relaunchingApp} onClick={closeFullDiskAccessGuide}>
              {permissionGuide.secondary}
            </button>
            {chromeCookieAccess === 'granted' ? (
              <button className="primary-button" type="button" autoFocus disabled={relaunchingApp} onClick={() => { void relaunchEtch() }}>
                <Icon name="refresh" />
                {relaunchingApp ? '正在重启…' : '重启 Etch'}
              </button>
            ) : chromeCookieAccess === 'denied' ? (
              <button className="primary-button" type="button" autoFocus disabled={openingFullDiskAccessSettings} onClick={() => { void requestChromeAccess() }}>
                <Icon name="settings" />
                {openingFullDiskAccessSettings ? '正在打开…' : '打开系统设置'}
              </button>
            ) : (
              <button className="primary-button" type="button" autoFocus onClick={closeFullDiskAccessGuide}>知道了</button>
            )}
          </footer>
        </section>
      </dialog>
      <dialog
        className="new-task-dialog"
        ref={newTaskDialogRef}
        aria-labelledby="new-task-title"
        onCancel={(event) => {
          event.preventDefault()
          closeNewTask()
        }}
        onPointerDown={(event) => {
          if (event.currentTarget === event.target) closeNewTask()
        }}
      >
        <form
          className="new-task-form"
          aria-busy={creatingTask}
          onSubmit={(event) => {
            event.preventDefault()
            void addUrl()
          }}
        >
          <header className="new-task-heading">
            <div>
              <h2 id="new-task-title">新建任务</h2>
              <p className="new-task-copy">
                {taskKind === 'document'
                  ? '每行一个网页或 X 链接，最多 50 个。提取正文与图片，并按所选模式生成 Markdown。'
                  : taskKind === 'summary'
                    ? '每行一个视频链接，最多 50 个。提取字幕并整理为中文长文。'
                    : '每行一个视频链接，最多 50 个。创建后自动进入处理队列。'}
              </p>
            </div>
            <button className="new-task-close" type="button" aria-label="关闭新建任务" disabled={creatingTask} onClick={closeNewTask}>
              ×
            </button>
          </header>
          <div className="new-task-body">
            <div className="new-task-kind" role="radiogroup" aria-label="任务类型">
              {([
                { id: 'subtitle' as const, label: '双语硬字幕', hint: '翻译、校对、压制成片' },
                { id: 'summary' as const, label: '视频总结', hint: '三稿择优长文 + 配图' },
                { id: 'document' as const, label: '网页翻译', hint: '网页 / X → Markdown' }
              ]).map((option) => (
                <label className="new-task-kind-option" data-selected={taskKind === option.id ? 'true' : undefined} key={option.id}>
                  <input
                    type="radio"
                    name="new-task-kind"
                    value={option.id}
                    checked={taskKind === option.id}
                    disabled={creatingTask}
                    onChange={() => setTaskKind(option.id)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.hint}</small>
                  </span>
                </label>
              ))}
            </div>
            <label className="new-task-field" htmlFor="content-url">
              <span>{taskKind === 'document' ? '网页或 X 链接' : '视频链接'} <small>{enteredUrlCount ? `已输入 ${enteredUrlCount} 个` : '支持批量新建'}</small></span>
              <textarea
                className="field-area new-task-urls"
                id="content-url"
                autoFocus
                inputMode="url"
                rows={4}
                placeholder={taskKind === 'document'
                  ? 'https://example.com/article\nhttps://x.com/author/status/…'
                  : 'https://www.youtube.com/watch?v=…\nhttps://vimeo.com/…'}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            {taskKind === 'document' && (
              <aside className="new-task-scope-note" aria-label="X 内容范围">
                <strong>X 内容范围</strong>
                <span>支持单条帖子与 X Article 的正文、作者和静态图片；线程、引用帖、投票与视频会标记为未展开。</span>
              </aside>
            )}
            <div className={taskKind === 'document' ? 'new-task-document-settings' : undefined}>
              {taskKind === 'document' && (
                <>
                  <label className="new-task-field" htmlFor="document-mode">
                    <span>处理模式 <small aria-live="polite">{documentModeHint}</small></span>
                    <select
                      className="field-select"
                      id="document-mode"
                      value={documentMode}
                      disabled={creatingTask}
                      onChange={(event) => setDocumentMode(event.target.value as DocumentProcessingMode)}
                    >
                      <option value="auto">自动判断（推荐）</option>
                      <option value="translate">强制翻译为中文</option>
                      <option value="convert">只转 Markdown，不翻译</option>
                    </select>
                  </label>
                  {documentMode !== 'convert' && (
                    <label className="new-task-field" htmlFor="document-translation-mode">
                      <span>翻译质量 <small>{documentTranslationMode === 'normal' ? '标准多阶段' : '含独立审校与润色'}</small></span>
                      <select
                        className="field-select"
                        id="document-translation-mode"
                        value={documentTranslationMode}
                        disabled={creatingTask}
                        onChange={(event) => setDocumentTranslationMode(event.target.value as 'normal' | 'refined')}
                      >
                        <option value="normal">标准翻译（推荐）</option>
                        <option value="refined">出版级精校</option>
                      </select>
                    </label>
                  )}
                </>
              )}
              <label className="new-task-field new-task-agent-field" data-inactive={!taskNeedsAgent ? 'true' : undefined} htmlFor="provider">
                <span>{taskKind === 'document' ? '翻译 Agent' : taskKind === 'summary' ? '总结 Provider' : '翻译 Provider'} <small aria-live="polite">{taskAgentHint}</small></span>
                <select
                  className="field-select"
                  id="provider"
                  value={taskNeedsAgent ? provider : 'none'}
                  disabled={creatingTask || !taskNeedsAgent}
                  onChange={(event) => {
                    providerEditVersionRef.current += 1
                    const nextProvider = event.target.value as ProviderId
                    setProvider(nextProvider)
                    seedModelField(nextProvider)
                  }}
                >
                  {!taskNeedsAgent
                    ? <option value="none">无需 Agent（仅转 Markdown）</option>
                    : PROVIDER_IDS.map((providerId) => {
                      const availability = providerAvailability(providerId, toolHealth)
                      return <option value={providerId} disabled={!availability.available} key={providerId}>{providerNames[providerId]}{!availability.available ? `（${availability.summary}）` : ''}</option>
                    })}
                </select>
              </label>
            </div>
            <ModelField
              idPrefix="new-task"
              label="模型"
              state={modelField}
              catalog={newTaskModelCatalog.catalog}
              loading={newTaskModelCatalog.loading}
              disabled={creatingTask}
              inactive={!taskNeedsAgent}
              onChange={setModelField}
            />
            <div className="new-task-field">
              <label htmlFor="task-category">分类 <small>选填 · 后续可修改</small></label>
              <div className="category-select-row">
                <span className="category-select-swatch" data-category-color={findCategory(categories, newTaskCategory)?.color} aria-hidden="true">
                  <i className={`cat-dot ${findCategory(categories, newTaskCategory) ? '' : 'is-placeholder'}`} />
                </span>
                <select
                  className="field-select"
                  id="task-category"
                  value={newTaskCategory}
                  disabled={creatingTask}
                  onChange={(event) => {
                    if (event.target.value === '__new') {
                      setInlineCategoryOpen(true)
                      setInlineCategoryError('')
                      return
                    }
                    setNewTaskCategory(event.target.value)
                    setInlineCategoryOpen(false)
                    setInlineCategoryError('')
                  }}
                >
                  <option value="">不分类（进未分类）</option>
                  {categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}
                  <option value="__new">+ 新建分类…</option>
                </select>
              </div>
              {inlineCategoryOpen && (
                <div className="inline-new-category">
                  <input
                    className="field-input"
                    type="text"
                    autoFocus
                    maxLength={20}
                    placeholder="分类名称，最多 20 字"
                    value={inlineCategoryName}
                    disabled={savingCategories}
                    onChange={(event) => setInlineCategoryName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      void createInlineCategory()
                    }}
                  />
                  <button className="secondary-button" type="button" disabled={savingCategories || !inlineCategoryName.trim()} onClick={() => { void createInlineCategory() }}>创建</button>
                </div>
              )}
              {(inlineCategoryError || categoryError) && <p className="form-error" role="alert">{inlineCategoryError || categoryError}</p>}
              {enteredUrlCount > 1 && <p className="new-task-field-note">这一批 {enteredUrlCount} 个任务会全部进同一个分类。</p>}
            </div>
            {!(taskKind === 'document' && documentMode === 'convert') && <label className="new-task-field" htmlFor="task-style-note">
              <span>{taskKind === 'summary' ? '总结要求' : taskKind === 'document' ? '文档处理要求' : '翻译风格'} <small>选填</small></span>
              <textarea
                className="field-area"
                id="task-style-note"
                maxLength={1000}
                placeholder={taskKind === 'summary'
                  ? '例如：重点写商业模式与数字，多保留对话锋芒'
                  : taskKind === 'document'
                    ? documentMode === 'convert'
                      ? '例如：保留表格、代码块与链接；移除导航和广告'
                      : '例如：产品名与代码保持英文；标题简洁；不要改动链接和表格'
                    : '例如：简洁自然，保留足球解说的临场感；术语沿用统一术语表'}
                value={styleNote}
                onChange={(event) => setStyleNote(event.target.value)}
              />
            </label>}
            {taskKind === 'document' && documentMode !== 'convert' && (
              <div className="new-task-document-settings">
                <label className="new-task-field" htmlFor="document-audience">
                  <span>目标读者</span>
                  <select className="field-select" id="document-audience" value={documentAudience} disabled={creatingTask} onChange={(event) => setDocumentAudience(event.target.value)}>
                    <option value="general">普通读者</option>
                    <option value="technical">技术读者</option>
                    <option value="executive">决策者</option>
                  </select>
                </label>
                <label className="new-task-field" htmlFor="document-writing-style">
                  <span>成文风格</span>
                  <select className="field-select" id="document-writing-style" value={documentWritingStyle} disabled={creatingTask} onChange={(event) => setDocumentWritingStyle(event.target.value)}>
                    <option value="storytelling">自然叙事</option>
                    <option value="concise">简洁准确</option>
                    <option value="academic">严谨书面</option>
                  </select>
                </label>
              </div>
            )}
            {taskKind === 'subtitle' && (
              <div className="new-task-auto-publish">
                <span>
                  <strong>完成后自动投稿到 B站</strong>
                  <small>{bilibiliAccount.status !== 'connected' ? '请先在设置中扫码登录' : !publicationTemplateReady(settings.bilibiliPublishTemplate) ? '请先补全默认分区和标签' : '使用设置中的投稿模板；默认关闭'}</small>
                  {(bilibiliAccount.status !== 'connected' || !publicationTemplateReady(settings.bilibiliPublishTemplate)) && (
                    <button
                      className="inline-setup-button"
                      type="button"
                      disabled={creatingTask}
                      onClick={() => openBilibiliSettings(bilibiliAccount.status === 'connected' ? 'template' : 'auto')}
                    >
                      {bilibiliAccount.status === 'connected' ? '配置投稿模板' : '连接 B站账号'}
                    </button>
                  )}
                </span>
                <SwitchControl
                  label="完成后自动投稿到 B站"
                  checked={autoPublish}
                  disabled={creatingTask || bilibiliAccount.status !== 'connected' || !publicationTemplateReady(settings.bilibiliPublishTemplate)}
                  onChange={setAutoPublish}
                />
              </div>
            )}
          </div>
          <footer className="new-task-actions">
            {error && <p className="form-error new-task-error" role="alert">{error}</p>}
            <div className="new-task-action-buttons">
              <button className="secondary-button" type="button" disabled={creatingTask} onClick={closeNewTask}>取消</button>
              <button className="primary-button" type="submit" disabled={!url.trim() || creatingTask || (taskNeedsAgent && (!selectedProviderAvailability.available || !modelFieldSelection(modelField)))}>
                {creatingTask
                  ? `正在创建${enteredUrlCount > 1 ? ` ${enteredUrlCount} 个任务` : '任务'}…`
                  : settings.queuePaused
                    ? `加入暂停队列${enteredUrlCount > 1 ? `（${enteredUrlCount}）` : ''}`
                    : `创建并开始${enteredUrlCount > 1 ? `（${enteredUrlCount}）` : ''}`}
              </button>
            </div>
          </footer>
        </form>
      </dialog>
      <BilibiliPublishDialog
        task={selected}
        settings={settings}
        account={bilibiliAccount}
        open={publishDialogOpen}
        onClose={() => setPublishDialogOpen(false)}
        onUpdated={applyPublicationDetail}
      />
      {taskContextMenu && (
        <div
          className="task-context-layer"
          onPointerDown={(event) => {
            if (event.currentTarget === event.target) closeTaskContextMenu()
          }}
        >
          <div
            className="task-context-menu"
            ref={taskContextMenuRef}
            role="menu"
            aria-label={`${taskContextMenu.title} 任务操作`}
            style={{ left: taskContextMenu.x, top: taskContextMenu.y }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                if (categoryMenuOpen) {
                  setCategoryMenuOpen(false)
                  return
                }
                closeTaskContextMenu()
                return
              }
              if (event.key === 'ArrowLeft' && categoryMenuOpen) {
                event.preventDefault()
                setCategoryMenuOpen(false)
                return
              }
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              const submenu = event.currentTarget.querySelector<HTMLElement>('.task-category-submenu')
              const scope = categoryMenuOpen && submenu ? submenu : event.currentTarget
              const items = [...scope.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)')]
                .filter((item) => (categoryMenuOpen ? true : !item.closest('.task-category-submenu')))
              if (!items.length) return
              const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
              const delta = event.key === 'ArrowDown' ? 1 : -1
              items[(current + delta + items.length) % items.length].focus()
            }}
          >
            <div className="task-context-submenu-row">
              <button
                className="task-context-move"
                role="menuitem"
                type="button"
                aria-haspopup="menu"
                aria-expanded={categoryMenuOpen}
                onClick={() => setCategoryMenuOpen((current) => !current)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowRight') return
                  event.preventDefault()
                  setCategoryMenuOpen(true)
                }}
              >
                <Icon name="tag" />
                {taskContextMenu.taskIds.length > 1 ? `移动 ${taskContextMenu.taskIds.length} 个任务到分类` : '移动到分类'}
                <span className="task-context-caret" aria-hidden="true"><Icon name="chevron" /></span>
              </button>
              {categoryMenuOpen && (
                <div
                  className={`task-category-submenu ${taskContextMenu.x > window.innerWidth - 540 ? 'opens-left' : ''}`}
                  role="menu"
                  aria-label="选择分类"
                >
                  <button
                    role="menuitemradio"
                    type="button"
                    aria-checked={!currentMenuCategory}
                    onClick={() => {
                      const taskIds = taskContextMenu.taskIds
                      closeTaskContextMenu(false)
                      void moveTasksToCategory(taskIds, '')
                    }}
                  >
                    <span className="task-category-check" aria-hidden="true">{!currentMenuCategory && <Icon name="check" />}</span>
                    <i className="cat-dot is-placeholder" aria-hidden="true" />
                    <span>未分类</span>
                  </button>
                  {categories.length > 0 && <span className="task-context-separator" />}
                  {categories.map((category) => (
                    <button
                      data-category-color={category.color}
                      role="menuitemradio"
                      type="button"
                      key={category.id}
                      aria-checked={currentMenuCategory === category.id}
                      onClick={() => {
                        const taskIds = taskContextMenu.taskIds
                        closeTaskContextMenu(false)
                        void moveTasksToCategory(taskIds, category.id)
                      }}
                    >
                      <span className="task-category-check" aria-hidden="true">{currentMenuCategory === category.id && <Icon name="check" />}</span>
                      <i className="cat-dot" aria-hidden="true" />
                      <span>{category.name}</span>
                      <span className="task-category-submenu-count mono">{categoryTotals.byCategory[category.id] ?? 0}</span>
                    </button>
                  ))}
                  <span className="task-context-separator" />
                  <button
                    className="task-category-new"
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      closeTaskContextMenu(false)
                      setCategoryDialogOpen(true)
                    }}
                  >
                    <Icon name="plus" />
                    新建分类…
                  </button>
                </div>
              )}
            </div>
            <span className="task-context-separator" />
            <button role="menuitem" type="button" onClick={() => { void revealTask(taskContextMenu.taskId) }}>
              <Icon name="folder" />
              在访达中显示
            </button>
            <span className="task-context-separator" />
            <button className="is-warning" role="menuitem" type="button" disabled={taskContextMenu.running || taskContextMenu.taskIds.length > 1} onClick={() => { void requestTaskDelete(taskContextMenu.taskId, taskContextMenu.title, 'record-only') }}>
              <Icon name="record-remove" />
              仅删除任务记录
            </button>
            <button className="is-danger" role="menuitem" type="button" disabled={taskContextMenu.running || taskContextMenu.taskIds.length > 1} onClick={() => { void requestTaskDelete(taskContextMenu.taskId, taskContextMenu.title, 'all-artifacts') }}>
              <Icon name="trash" />
              删除任务及全部产物
            </button>
          </div>
        </div>
      )}
      <TaskCategoryDialog
        open={categoryDialogOpen}
        categories={categories}
        counts={categoryTotals.byCategory}
        saving={savingCategories}
        saveError={categoryError}
        onSave={(next) => { void saveCategories(next) }}
        onClose={() => setCategoryDialogOpen(false)}
      />
      <TaskDeleteDialog
        request={deleteRequest}
        deleting={Boolean(deletingTaskId)}
        error={taskDeleteError}
        onCancel={() => {
          setTaskDeleteError('')
          setDeleteRequest(undefined)
        }}
        onConfirm={() => { void deleteTask() }}
        restoreFocus={restoreDeleteFocus}
      />
    </div>
  )
}
