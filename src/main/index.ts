import { randomUUID } from 'node:crypto'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, realpath, rename } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerSaveBlocker, safeStorage, shell, type MenuItemConstructorOptions, type MessageBoxOptions } from 'electron'
import { AppSettingsSchema, BilibiliAccountSchema, BilibiliPartitionSchema, BilibiliPublicationCoverSchema, BilibiliPublicationStartPayloadSchema, BilibiliQrSessionPayloadSchema, BilibiliQrStateSchema, BootstrapSchema, CompleteReviewSchema, CreateUrlsSchema, DeleteGlossaryEntryResultSchema, DeleteGlossaryEntrySchema, DeleteTaskPayloadSchema, GlossaryApplyPayloadSchema, GlossaryApplyResultSchema, GlossaryCatalogPageSchema, GlossaryCatalogPayloadSchema, GlossaryImpactPreviewSchema, QueuePageSchema, RecoveryStateSchema, ResolveAuditSchema, ReviewPagePayloadSchema, ReviewTimelineWindowPayloadSchema, ReviewTimelineWindowSchema, TaskDetailSchema, TaskIdPayloadSchema, TaskThumbnailDataUrlSchema, TaskThumbnailPayloadSchema, ToolHealthSnapshotSchema, UpdateCuesSchema, UpdateGlossarySchema, UpdateSubtitlePresetSchema, type RuntimeDiagnostics } from '../shared/ipc'
import { ToolIdSchema, type ToolId } from '../shared/settings-schema'
import { createTaskManifest, type ProviderId } from '../shared/task-schema'
import { IndexStore } from './storage/index-store'
import { HiddenTaskStore } from './storage/hidden-task-store'
import { LocationRegistry, discoverTasks } from './storage/location-registry'
import { SettingsStore } from './storage/settings-store'
import { TaskStore } from './storage/task-store'
import { AppStateStore } from './storage/app-state-store'
import { TaskPipeline } from './pipeline/task-pipeline'
import { HistoricalGlossaryService } from './historical-glossary'
import {
  logChildEnvironmentKeys,
  loginShellEnvironment,
  operationalEnvironment,
  providerEnvironment
} from './runtime/shell-env'
import { detectTool } from './runtime/tool-detector'
import { moveTaskToTrash, removeTaskRecord, revealTaskInFinder, type DeleteCleanupWarning } from './task-deletion'
import { TaskReviewService } from './task-review'
import { TaskThumbnailService } from './task-thumbnail'
import { RunRegistry } from './runtime/run-registry'
import { removeStaleCodexTextOnlyExecutableSnapshots } from './providers/codex-capability'
import { confirmProviderRecovery, recoverProviderRunsAtStartup } from './runtime/startup-recovery'
import { runProcess, type ProcessSpec } from './runtime/process-runner'
import { coordinateShutdown, handleShutdownResult, type ShutdownMode } from './runtime/shutdown-coordinator'
import { PipelinePowerManager } from './runtime/power'
import { TaskNotifier } from './runtime/task-notifier'
import { AsyncRunScope } from './runtime/async-run-scope'
import { isVideoFullscreenEscape } from './video-fullscreen'
import { BilibiliAuthService } from './bilibili-auth'
import { BilibiliPublisher } from './bilibili-publisher'
import { BilibiliAccountStore } from './storage/bilibili-account-store'
import { writeAtomic } from './storage/atomic-write'

let mainWindow: BrowserWindow | null = null
let quitting = false
let cleanExitStarted = false
let initialized = false
let focusRequestedWhileInitializing = false
const TOOL_PROVIDER: Partial<Record<ToolId, ProviderId>> = {
  claude: 'claude',
  codex: 'codex',
  qoder: 'qoder',
  opencode: 'opencode'
}
let recoveryHold = false
let interruptedTasks = 0
let indexStore: IndexStore | undefined
let appStateStore: AppStateStore | undefined
let activePipeline: TaskPipeline | undefined
let activeRunRegistry: RunRegistry | undefined
let activeAppRuns: AsyncRunScope | undefined
let restartPendingTasks: (() => void) | undefined
let activePowerManager: PipelinePowerManager | undefined
let activeBilibiliAuth: BilibiliAuthService | undefined
let runtimeDiagnostics: RuntimeDiagnostics = {
  discoveryErrors: [],
  identityConflicts: []
}
const taskStore = new TaskStore()
const deletingTaskIds = new Set<string>()
const videoFullscreenWindowIds = new Set<number>()
const taskThumbnails = new TaskThumbnailService()

if (process.env.ETCH_USER_DATA_DIR) app.setPath('userData', process.env.ETCH_USER_DATA_DIR)
const isolatedE2EInstance = process.env.ETCH_E2E_ALLOW_MULTIPLE_INSTANCES === '1' && Boolean(process.env.ETCH_USER_DATA_DIR)
const hasSingleInstanceLock = isolatedE2EInstance || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else {
  app.on('second-instance', () => {
    if (!initialized) {
      focusRequestedWhileInitializing = true
      return
    }
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
    mainWindow.show()
    mainWindow.focus()
  })
}

function supportedPlatform(): boolean {
  const [major, minor] = process.getSystemVersion().split('.').map(Number)
  return process.platform === 'darwin' && process.arch === 'arm64' && (major > 13 || (major === 13 && minor >= 5))
}

function setVideoFullscreen(window: BrowserWindow, fullscreen: boolean): void {
  window.setSimpleFullScreen(fullscreen)
  const active = window.isSimpleFullScreen()
  if (active) videoFullscreenWindowIds.add(window.id)
  else videoFullscreenWindowIds.delete(window.id)
  window.webContents.send('video:fullscreen-changed', active)
}

async function trashTaskDirectory(taskDirectory: string, support: string): Promise<void> {
  if (!(isolatedE2EInstance && process.env.ETCH_E2E_HERMETIC === '1')) {
    await shell.trashItem(taskDirectory)
    return
  }
  const canonicalSupport = await realpath(support).catch(() => resolve(support))
  const canonicalTask = await realpath(taskDirectory).catch(() => resolve(taskDirectory))
  const contained = relative(canonicalSupport, canonicalTask)
  if (!contained || contained === '..' || contained.startsWith(`..${sep}`)) {
    throw new Error('Hermetic E2E 拒绝把 userData 之外的目录移入测试废纸篓')
  }
  const trashRoot = join(support, '.etch-hermetic-trash')
  await mkdir(trashRoot, { recursive: true })
  await rename(taskDirectory, join(trashRoot, `${basename(taskDirectory)}-${randomUUID()}`))
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: 'Etch',
    backgroundColor: '#0b0d10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (!isVideoFullscreenEscape(videoFullscreenWindowIds.has(window.id), input)) return
    event.preventDefault()
    setVideoFullscreen(window, false)
  })

  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window.hide()
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

function showSettings(): void {
  if (!initialized) return
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  mainWindow.show()
  mainWindow.focus()
  const send = (): void => mainWindow?.webContents.send('app:open-settings')
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send)
  else send()
}

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Etch',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { id: 'settings', label: '设置…', accelerator: 'CommandOrControl+,', click: showSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('before-quit', (event) => {
  if (!appStateStore || !activePipeline || !activeRunRegistry || !activeAppRuns) {
    quitting = true
    return
  }
  event.preventDefault()
  if (cleanExitStarted) return
  cleanExitStarted = true
  void coordinateShutdown({
    pipeline: activePipeline,
    runRegistry: activeRunRegistry,
    appRuns: activeAppRuns,
    chooseMode: async (activeWorkers): Promise<ShutdownMode> => {
      const options: MessageBoxOptions = {
        type: 'warning',
        title: 'Etch 正在处理任务',
        message: `仍有 ${activeWorkers} 个任务或外部进程未收敛。`,
        detail: '完成当前步骤会保留本阶段结果后退出；立即停止会终止当前 Etch 实例启动的外部进程。',
        buttons: ['取消退出', '完成当前步骤后退出', '立即停止并退出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options)
      return result.response === 1 ? 'drain-current-stage' : result.response === 2 ? 'stop-now' : 'cancel'
    },
    markCleanExit: () => appStateStore!.markCleanExit()
  }).then((result) => handleShutdownResult(result, {
    cancelled: () => {
      cleanExitStarted = false
      quitting = false
      restartPendingTasks?.()
    },
    unclean: (error) => {
      console.error('Etch 退出时未能安全收敛，将保留异常退出标记', error)
      cleanExitStarted = false
      quitting = false
      restartPendingTasks?.()
      mainWindow?.show()
      dialog.showErrorBox('Etch 无法安全退出', 'Etch 已保留运行现场并恢复队列领取；请稍后再次退出。')
    },
    clean: () => {
      activeBilibiliAuth?.disposeQrSessions()
      activePowerManager?.dispose()
      quitting = true
      app.exit(0)
    }
  }))
})
app.on('activate', () => {
  if (!initialized) return
  if (!mainWindow) mainWindow = createWindow()
  else mainWindow.show()
})

ipcMain.handle('app:bootstrap', async () => BootstrapSchema.parse({
  version: app.getVersion(),
  arch: process.arch,
  showFullDiskAccessOnboarding: await appStateStore?.claimFullDiskAccessOnboarding() ?? false,
  startupDiagnostics: runtimeDiagnostics
}))

function queuePage(offset = 0, limit = 100): unknown {
  if (!indexStore) throw new Error('Etch 尚未初始化')
  const items = indexStore.list(Math.min(Math.max(limit, 1), 100), Math.max(offset, 0)).map(({ taskId, title, status, revision, updatedAt }) => ({ taskId, title, status, revision, updatedAt }))
  return QueuePageSchema.parse({ items, total: indexStore.count() })
}

function assertRecoveryReleased(): void {
  if (recoveryHold) throw new Error('请先确认上次异常退出的恢复摘要')
}

function installDockIcon(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  const icon = nativeImage.createFromPath(join(process.resourcesPath, 'icon.png'))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

if (hasSingleInstanceLock) void app.whenReady().then(async () => {
  installDockIcon()
  if (!supportedPlatform()) {
    dialog.showErrorBox('Etch 无法启动', 'Etch MVP 仅支持 Apple Silicon 与 macOS 13.5 及以上。')
    app.quit()
    return
  }
  const support = app.getPath('userData')
  appStateStore = new AppStateStore(join(support, 'app-state.json'))
  const launchState = await appStateStore.beginLaunch()
  recoveryHold = launchState.recoveryHold
  const runRegistry = new RunRegistry(join(support, 'run-registry.json'))
  activeRunRegistry = runRegistry
  const appRuns = new AsyncRunScope()
  activeAppRuns = appRuns
  const runAppScopedExternal = (spec: ProcessSpec) => {
    if (cleanExitStarted) throw new Error('Etch 正在退出，拒绝启动新的外部进程')
    const runId = randomUUID()
    const taskId = randomUUID()
    const appInstanceToken = runRegistry.appInstanceToken
    return appRuns.track(runProcess(spec, {
      started: async (pid, executable) => runRegistry.register({ runId, appInstanceToken, pid, pgid: pid, executable, taskId, stage: 'environment' }).then(() => undefined),
      finished: () => runRegistry.finish(runId)
    }, { runId, appInstanceToken }))
  }
  const runRecovery = await recoverProviderRunsAtStartup(runRegistry, appStateStore)
  const unverifiedRuns = runRecovery.unverifiedRuns
  if (unverifiedRuns) {
    interruptedTasks += unverifiedRuns
    recoveryHold = true
  }
  const settingsStore = new SettingsStore(join(support, 'settings.json'), app.getPath('home'))
  const settings = await settingsStore.load()
  const bilibiliAccountStore = new BilibiliAccountStore(join(support, 'bilibili-account.json'), safeStorage)
  const bilibiliFetch: typeof fetch = process.env.ETCH_E2E_HERMETIC === '1'
    ? async (input, init) => {
      const url = String(input)
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/qrcode/auth_code')) return json({ code: 0, data: { url: 'https://example.com/etch-e2e-bilibili', auth_code: 'etch-e2e-auth-code' } })
      if (url.includes('/qrcode/poll')) return json({
        code: 0,
        data: {
          cookie_info: { cookies: [{ name: 'SESSDATA', value: 'e2e-secret-session' }, { name: 'bili_jct', value: 'e2e-secret-csrf' }] },
          sso: [],
          token_info: { access_token: 'e2e-secret-access', expires_in: 3600, mid: 123, refresh_token: 'e2e-secret-refresh' },
          platform: 'BiliTV'
        }
      })
      if (url.includes('/x/space/myinfo')) return json({ code: 0, data: { mid: 123, name: 'Etch E2E' } })
      if (url.includes('/x/vupre/web/archive/pre')) return json({ code: 0, data: { typelist: [{ id: 160, name: '生活', children: [{ id: 21, name: '日常' }] }] } })
      return fetch(input, init)
    }
    : fetch
  const bilibiliAuth = new BilibiliAuthService(bilibiliAccountStore, bilibiliFetch)
  activeBilibiliAuth = bilibiliAuth
  const powerManager = new PipelinePowerManager({
    start: (type) => powerSaveBlocker.start(type),
    stop: (id) => powerSaveBlocker.stop(id)
  }, settings.preventSleep)
  activePowerManager = powerManager
  await mkdir(settings.workspaceRoot, { recursive: true })
  const registry = new LocationRegistry(join(support, 'location-registry.json'))
  const registryData = await registry.addWorkspaceRoot(settings.workspaceRoot)
  const hiddenTaskStore = new HiddenTaskStore(join(support, 'hidden-tasks.json'))
  const hiddenTaskIds = new Set((await hiddenTaskStore.load()).taskIds)
  const discovery = await discoverTasks(registryData, hiddenTaskIds)
  runtimeDiagnostics = {
    discoveryErrors: discovery.errors.slice(0, 100),
    identityConflicts: [...discovery.conflicts.entries()].slice(0, 100).map(([taskId, tasks]) => ({
      taskId,
      locations: tasks.slice(0, 20).map((task) => task.location)
    }))
  }
  for (const task of discovery.tasks) {
    await removeStaleCodexTextOnlyExecutableSnapshots(task.location)
    const recovered = await taskStore.recoverInterrupted(task.location)
    if (recovered.revision !== task.manifest.revision) interruptedTasks += 1
    task.manifest = recovered
  }
  if (interruptedTasks > 0) {
    recoveryHold = true
    await appStateStore.holdRecovery()
  }
  indexStore = new IndexStore()
  indexStore.rebuild(discovery.tasks)
  const historicalGlossary = new HistoricalGlossaryService(taskStore, () => indexStore!.all(), join(support, 'glossary.json'))
  const taskNotifier = new TaskNotifier(() => settings.notifications, {
    isWindowActive: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()),
    show: (title, body, onClick) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      notification.on('click', onClick)
      notification.show()
    },
    focusWindow: () => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  taskNotifier.prime(discovery.tasks.map((task) => task.manifest))
  const publishManifest = (taskDirectory: string, manifest: ReturnType<typeof createTaskManifest>): void => {
    if (!deletingTaskIds.has(manifest.taskId)) {
      indexStore!.upsert(taskDirectory, manifest)
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('task:changed', { taskId: manifest.taskId, revision: manifest.revision })
      }
    } catch (error) {
      console.error('task change delivery failed', { taskId: manifest.taskId, revision: manifest.revision, error })
    }
    try { taskNotifier.observe(manifest) }
    catch (error) { console.error('task notification observer failed', { taskId: manifest.taskId, revision: manifest.revision, error }) }
    if (manifest.pipeline.stages.verify.status === 'completed') {
      void historicalGlossary.sync().catch((error) => console.error('global glossary sync failed', error))
      if (!recoveryHold) void publisher.considerAuto(taskDirectory).catch((error) => console.error('B站自动投稿排队失败', { taskId: manifest.taskId, error }))
    }
  }
  let pipelineWorkerCount = 0
  let publisherActive = false
  const syncPowerWorkers = (): void => powerManager.setActiveWorkers(pipelineWorkerCount + (publisherActive ? 1 : 0))
  const pipeline = new TaskPipeline(taskStore, settings, historicalGlossary, publishManifest, runRegistry, (count) => {
    pipelineWorkerCount = count
    syncPowerWorkers()
  })
  activePipeline = pipeline
  const sidecarPath = app.isPackaged
    ? join(process.resourcesPath, 'biliup', 'biliup')
    : join(app.getAppPath(), 'vendor', 'biliup', 'macos-arm64', 'biliup')
  const publisher = new BilibiliPublisher({
    store: taskStore,
    accountStore: bilibiliAccountStore,
    settings: () => settings,
    sidecarPath,
    temporaryRoot: join(support, 'bilibili-publish-tmp'),
    runRegistry,
    appRuns,
    publishManifest,
    onActiveChange: (active) => {
      publisherActive = active
      syncPowerWorkers()
    }
  })
  await publisher.initialize(discovery.tasks.map((task) => task.location))
  void historicalGlossary.sync().catch((error) => console.error('initial global glossary sync failed', error))
  const startPendingTasks = (): void => {
    if (settings.queuePaused || recoveryHold) return
    const pending = indexStore!.all()
      .filter((task) => task.status === 'pending' && !deletingTaskIds.has(task.taskId))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    for (const task of pending) {
      void pipeline.start(task.location).catch((error) => console.error('queued pipeline failed', { taskId: task.taskId, error }))
    }
  }
  const startPendingPublications = (): void => {
    if (recoveryHold) return
    for (const task of indexStore!.all()) {
      void publisher!.considerAuto(task.location).catch((error) => console.error('B站自动投稿排队失败', { taskId: task.taskId, error }))
    }
  }
  restartPendingTasks = startPendingTasks
  const review = new TaskReviewService(taskStore, (taskDirectory) => pipeline.isRunning(taskDirectory), publishManifest)
  const detail = async (taskId: string): Promise<unknown> => {
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    const manifest = await taskStore.load(indexed.location)
    const artifact = manifest.runtime.finalRelativePath && manifest.artifacts.final?.valid ? manifest.artifacts.final : manifest.artifacts.source
    let mediaUrl: string | undefined
    if (artifact) {
      const root = resolve(indexed.location)
      const path = resolve(root, artifact.relativePath)
      if (path === root || path.startsWith(`${root}${sep}`)) mediaUrl = pathToFileURL(path).toString()
    }
    return TaskDetailSchema.parse({ taskDirectory: indexed.location, manifest, mediaUrl })
  }
  ipcMain.handle('queue:page', (_event, raw) => queuePage(Number(raw?.offset ?? 0), Number(raw?.limit ?? 100)))
  ipcMain.handle('task:detail', async (_event, raw) => detail(TaskIdPayloadSchema.parse(raw).taskId))
  ipcMain.handle('task:thumbnail', async (_event, raw) => {
    const { taskId, expectedSha256 } = TaskThumbnailPayloadSchema.parse(raw)
    const indexed = indexStore!.get(taskId)
    if (!indexed) return undefined
    const manifest = await taskStore.load(indexed.location)
    const artifact = manifest.artifacts.thumbnail
    if (!artifact?.valid || artifact.sha256 !== expectedSha256) return undefined
    try {
      return TaskThumbnailDataUrlSchema.parse(await taskThumbnails.read(taskId, indexed.location, artifact))
    } catch (error) {
      console.warn('task thumbnail unavailable', { taskId, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  })
  ipcMain.handle('task:reveal', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    await revealTaskInFinder({ taskId, indexStore: indexStore!, taskStore, showItem: (taskDirectory) => shell.showItemInFolder(taskDirectory) })
  })
  ipcMain.handle('task:review-page', async (_event, raw) => {
    const { taskId, offset, limit } = ReviewPagePayloadSchema.parse(raw)
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    return review.page(indexed.location, offset, limit)
  })
  ipcMain.handle('task:review-timeline-window', async (_event, raw) => {
    const payload = ReviewTimelineWindowPayloadSchema.parse(raw)
    const indexed = indexStore!.get(payload.taskId)
    if (!indexed) throw new Error('任务不存在')
    return ReviewTimelineWindowSchema.parse(await review.timelineWindow(indexed.location, payload))
  })
  ipcMain.handle('glossary:catalog-page', async (_event, raw) => {
    const { query, offset, limit } = GlossaryCatalogPayloadSchema.parse(raw)
    return GlossaryCatalogPageSchema.parse(await historicalGlossary.libraryPage(query, offset, limit))
  })
  ipcMain.handle('glossary:delete-entry', async (_event, raw) => {
    const { entryId, expectedRevision } = DeleteGlossaryEntrySchema.parse(raw)
    return DeleteGlossaryEntryResultSchema.parse({
      revision: await historicalGlossary.deleteEntry(entryId, expectedRevision)
    })
  })
  ipcMain.handle('task:update-cues', async (_event, raw) => {
    const { taskId, expectedRevision, edits } = UpdateCuesSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    await review.update(indexed.location, expectedRevision, edits)
    return detail(taskId)
  })
  ipcMain.handle('task:update-glossary', async (_event, raw) => {
    const { taskId, expectedRevision, edits } = UpdateGlossarySchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    await review.updateGlossary(indexed.location, expectedRevision, edits)
    return detail(taskId)
  })
  ipcMain.handle('task:update-subtitle-preset', async (_event, raw) => {
    const { taskId, expectedRevision, preset } = UpdateSubtitlePresetSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    await review.updateSubtitlePreset(indexed.location, expectedRevision, preset)
    return detail(taskId)
  })
  ipcMain.handle('task:preview-glossary-apply', async (_event, raw) => {
    const { taskId, expectedRevision, edits } = UpdateGlossarySchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    return GlossaryImpactPreviewSchema.parse(await review.previewGlossaryApply(indexed.location, expectedRevision, edits))
  })
  ipcMain.handle('task:apply-glossary', async (_event, raw) => {
    const { taskId, expectedRevision, impactFingerprint, edits } = GlossaryApplyPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    const applied = await review.applyGlossary(indexed.location, expectedRevision, impactFingerprint, edits)
    return GlossaryApplyResultSchema.parse({ detail: await detail(taskId), preview: applied.preview })
  })
  ipcMain.handle('task:start', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (!pipeline.isRunning(indexed.location)) await pipeline.resume(indexed.location)
    return detail(taskId)
  })
  ipcMain.handle('task:stop', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    await pipeline.stop(indexed.location)
    return detail(taskId)
  })
  ipcMain.handle('task:delete', async (_event, raw) => {
    const { taskId, mode } = DeleteTaskPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexedBeforeDelete = indexStore!.get(taskId)
    deletingTaskIds.add(taskId)
    try {
      const baseOptions = {
        taskId,
        indexStore: indexStore!,
        registry,
        taskStore,
        isRunning: (taskDirectory: string) => pipeline.isRunning(taskDirectory),
        hasActiveProviderRun: async (activeTaskId: string) => publisher!.hasTask(activeTaskId) || await runRegistry.hasActiveTask(activeTaskId),
        onCleanupWarning: (warning: DeleteCleanupWarning) => console.warn('task deletion cleanup warning', {
          ...warning,
          error: warning.error instanceof Error ? warning.error.message : String(warning.error)
        })
      }
      if (mode === 'record-only') await removeTaskRecord({ ...baseOptions, hiddenTaskStore })
      else await moveTaskToTrash({
        ...baseOptions,
        trashItem: (taskDirectory) => trashTaskDirectory(taskDirectory, support),
        protectedPaths: [app.getPath('home'), support]
      })
      taskThumbnails.forget(taskId)
      taskNotifier.forget(taskId)
      review.forget(taskId, indexedBeforeDelete?.location)
      await historicalGlossary.sync().catch((error) => console.error('global glossary delete reconciliation failed', error))
      return queuePage()
    } finally {
      deletingTaskIds.delete(taskId)
    }
  })
  ipcMain.handle('recovery:state', () => RecoveryStateSchema.parse({ hold: recoveryHold, interruptedTasks }))
  ipcMain.handle('recovery:release', async () => {
    const confirmation = await confirmProviderRecovery(runRegistry, appStateStore!)
    recoveryHold = !confirmation.released
    startPendingTasks()
    startPendingPublications()
    return RecoveryStateSchema.parse({ hold: recoveryHold, interruptedTasks })
  })
  ipcMain.handle('task:resolve-audit', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, decisions } = ResolveAuditSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    await pipeline.resolveAudit(indexed.location, decisions)
    if (!pipeline.isRunning(indexed.location)) void pipeline.start(indexed.location).catch((error) => console.error('pipeline failed', error))
    return detail(taskId)
  })
  ipcMain.handle('task:complete-review', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, expectedRevision } = CompleteReviewSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    await pipeline.completeReview(indexed.location, expectedRevision)
    if (!pipeline.isRunning(indexed.location)) void pipeline.start(indexed.location).catch((error) => console.error('pipeline failed', error))
    return detail(taskId)
  })
  ipcMain.handle('settings:get', () => AppSettingsSchema.parse(settings))
  ipcMain.handle('settings:update', async (_event, raw) => {
    const next = AppSettingsSchema.parse(raw)
    await settingsStore.save(next)
    Object.assign(settings, next)
    pipeline.setQueuePaused(next.queuePaused)
    powerManager.setEnabled(next.preventSleep)
    await mkdir(next.workspaceRoot, { recursive: true })
    await registry.addWorkspaceRoot(next.workspaceRoot)
    startPendingTasks()
    startPendingPublications()
    return AppSettingsSchema.parse(settings)
  })
  ipcMain.handle('tools:detect', async () => {
    const full = await loginShellEnvironment(process.env, runAppScopedExternal)
    const results = await Promise.all(ToolIdSchema.options.map((tool) => {
      const provider = TOOL_PROVIDER[tool]
      const env = provider ? providerEnvironment(provider, full) : operationalEnvironment(full)
      logChildEnvironmentKeys(provider ? `provider:${provider}` : 'operational', env)
      return detectTool(tool, env, settings.toolOverrides[tool], runAppScopedExternal)
    }))
    return results.map((health) => ToolHealthSnapshotSchema.parse(health))
  })
  ipcMain.handle('bilibili:account', async () => BilibiliAccountSchema.parse(await bilibiliAuth.account()))
  ipcMain.handle('bilibili:qr-start', async () => BilibiliQrStateSchema.parse(await bilibiliAuth.startQrLogin()))
  ipcMain.handle('bilibili:qr-state', async (_event, raw) => {
    const { sessionId } = BilibiliQrSessionPayloadSchema.parse(raw)
    const state = BilibiliQrStateSchema.parse(bilibiliAuth.qrState(sessionId))
    if (state.status === 'complete') startPendingPublications()
    return state
  })
  ipcMain.handle('bilibili:disconnect', async () => BilibiliAccountSchema.parse(await bilibiliAuth.disconnect()))
  ipcMain.handle('bilibili:partitions', async () => BilibiliPartitionSchema.array().parse(await bilibiliAuth.partitions()))
  ipcMain.handle('bilibili:select-cover', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    if (publisher!.hasTask(taskId)) throw new Error('投稿已经开始，不能再更换封面')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, { title: '选择 B站投稿封面', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] })
      : await dialog.showOpenDialog({ title: '选择 B站投稿封面', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] })
    if (result.canceled || !result.filePaths[0]) return BilibiliPublicationCoverSchema.parse({ cancelled: true })
    let image = nativeImage.createFromPath(result.filePaths[0])
    if (image.isEmpty()) throw new Error('选择的文件不是 Etch 可读取的图片')
    const size = image.getSize()
    const scale = Math.min(1, 1920 / size.width, 1080 / size.height)
    if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' })
    let bytes = image.toJPEG(90)
    if (bytes.length > 2_500_000) {
      const reduced = image.resize({ width: Math.min(1280, image.getSize().width), quality: 'best' })
      bytes = reduced.toJPEG(82)
    }
    if (bytes.length > 2_800_000) throw new Error('封面压缩后仍然过大，请选择尺寸更小的图片')
    const coverRelativePath = 'publication/cover.jpg'
    const coverPath = join(indexed.location, coverRelativePath)
    await mkdir(join(indexed.location, 'publication'), { recursive: true })
    await writeAtomic(coverPath, bytes)
    return BilibiliPublicationCoverSchema.parse({
      cancelled: false,
      coverRelativePath,
      dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`
    })
  })
  ipcMain.handle('bilibili:publish', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, draft } = BilibiliPublicationStartPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    await publisher!.start(indexed.location, draft)
    return detail(taskId)
  })
  ipcMain.handle('bilibili:stop', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    await publisher!.stop(indexed.location)
    return detail(taskId)
  })
  ipcMain.handle('bilibili:continue', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    await publisher!.continue(indexed.location)
    return detail(taskId)
  })
  ipcMain.handle('bilibili:open-creator-center', () => shell.openExternal('https://member.bilibili.com/platform/upload-manager/article'))
  ipcMain.handle('video:set-fullscreen', (event, fullscreen) => {
    if (typeof fullscreen !== 'boolean') throw new Error('视频全屏状态无效')
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.isDestroyed()) return
    setVideoFullscreen(owner, fullscreen)
  })
  ipcMain.handle('permissions:open-full-disk-access-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles'))
  ipcMain.handle('task:create-urls', async (_event, raw) => {
    const payload = CreateUrlsSchema.parse(raw)
    for (const url of payload.urls) {
      const manifest = createTaskManifest({ kind: 'url', url }, '', payload.provider, payload.styleNote, settings.subtitlePreset, payload.autoPublish)
      const safeTitle = 'pending'
      const taskDirectory = join(settings.workspaceRoot, `${safeTitle}--${manifest.taskId.slice(0, 8)}`)
      await mkdir(taskDirectory, { recursive: true })
      await taskStore.create(taskDirectory, manifest)
      await registry.addTaskLocation(taskDirectory)
      indexStore!.upsert(taskDirectory, manifest)
    }
    startPendingTasks()
    return queuePage()
  })
  initialized = true
  mainWindow = createWindow()
  installApplicationMenu()
  startPendingTasks()
  startPendingPublications()
  if (focusRequestedWhileInitializing) {
    focusRequestedWhileInitializing = false
    mainWindow.show()
    mainWindow.focus()
  }
}).catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error)
  console.error('Etch 初始化失败', error)
  dialog.showErrorBox('Etch 无法启动', `启动恢复或本地数据初始化失败：${detail}`)
  app.quit()
})
