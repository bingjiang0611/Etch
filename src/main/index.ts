import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, safeStorage, session, shell, type MenuItemConstructorOptions, type MessageBoxOptions } from 'electron'
import { AppSettingsSchema, BilibiliAccountSchema, BilibiliPartitionSchema, BilibiliPublicationCoverSchema, BilibiliPublicationStartPayloadSchema, BilibiliQrSessionPayloadSchema, BilibiliQrStateSchema, BootstrapSchema, ChromeCookieAccessSchema, CompleteReviewSchema, CreateCompanionSchema, CreateUrlsSchema, DeleteGlossaryEntryResultSchema, DeleteGlossaryEntrySchema, DeleteTaskPayloadSchema, DocumentHtmlPageSchema, DocumentImageDataUrlSchema, DocumentImagePayloadSchema, DocumentPageSchema, ExportDocumentHtmlResultSchema, ExportDocumentResultSchema, ExportSummaryResultSchema, GlossaryApplyPayloadSchema, GlossaryApplyResultSchema, GlossaryCatalogPageSchema, GlossaryCatalogPayloadSchema, GlossaryImpactPreviewSchema, QueuePageSchema, RecoveryStateSchema, ResolveAuditSchema, ResolveDocumentHtmlStyleSchema, ResolveDocumentTranslationCostSchema, ResolveIllustrationAgentSchema, ResolveIllustrationCoverSchema, ResolveResearchCheckpointSchema, ResolveVideoCheckpointSchema, ReviewPagePayloadSchema, ReviewTimelineWindowPayloadSchema, ReviewTimelineWindowSchema, SetTaskCategoryPayloadSchema, StartDocumentHtmlSchema, SummaryImageDataUrlSchema, SummaryImagePayloadSchema, SummaryPageSchema, TaskDetailSchema, TaskIdPayloadSchema, TaskThumbnailDataUrlSchema, TaskThumbnailPayloadSchema, ToolHealthSnapshotSchema, ToolInstallPayloadSchema, ToolInstallResultSchema, UpdateCuesSchema, UpdateDocumentTranslationSchema, UpdateGlossarySchema, UpdateSubtitlePresetSchema, type RuntimeDiagnostics } from '../shared/ipc'
import { ToolIdSchema, type ThemePreference, type ToolId } from '../shared/settings-schema'
import { createTaskManifest, taskThumbnailArtifact, type ProviderId } from '../shared/task-schema'
import { isSupportedMediaSourceUrl } from '../shared/media-source'
import { chromeCookieState, fullDiskAccessSettingsUrl } from './media/browser-cookies'
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
import { detectTool, resolveToolExecutable } from './runtime/tool-detector'
import { ModelCatalogCache, probeModelCatalog, providerSupportsModelListing } from './runtime/model-catalog'
import { ModelCatalogPayloadSchema, ProviderModelCatalogSchema } from '../shared/model-catalog'
import { toolInstallScript } from './runtime/tool-install'
import { moveTaskToTrash, removeTaskRecord, revealTaskInFinder, type DeleteCleanupWarning } from './task-deletion'
import { TaskReviewService } from './task-review'
import { TaskThumbnailService } from './task-thumbnail'
import { SummaryService } from './summary-service'
import { DocumentService } from './document-service'
import { DocumentHtmlService, type DocumentHtmlBrowserVerifier } from './document-html-service'
import { RunRegistry } from './runtime/run-registry'
import { removeStaleCodexTextOnlyExecutableSnapshots } from './providers/codex-capability'
import { confirmProviderRecovery, recoverProviderRunsAtStartup } from './runtime/startup-recovery'
import { runProcess, type ProcessSpec } from './runtime/process-runner'
import { ENVIRONMENT_RUN_STAGE, coordinateShutdown, handleShutdownResult, type ShutdownMode } from './runtime/shutdown-coordinator'
import { PipelinePowerManager } from './runtime/power'
import { TaskNotifier } from './runtime/task-notifier'
import { createCompanionManifest } from './task-companion'
import { AsyncRunScope } from './runtime/async-run-scope'
import { isVideoFullscreenEscape } from './video-fullscreen'
import { BilibiliAuthService } from './bilibili-auth'
import { BilibiliPublisher } from './bilibili-publisher'
import { BilibiliAccountStore } from './storage/bilibili-account-store'
import { writeAtomic } from './storage/atomic-write'
import { TaskAcquisitionGuard } from './task-acquisition-guard'

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
const modelCatalogCache = new ModelCatalogCache()
let recoveryHold = false
let publisherActive = false
let interruptedTasks = 0
let indexStore: IndexStore | undefined
let appStateStore: AppStateStore | undefined
let activePipeline: TaskPipeline | undefined
let activeRunRegistry: RunRegistry | undefined
let activeAppRuns: AsyncRunScope | undefined
let restartPendingTasks: (() => void) | undefined
let activePowerManager: PipelinePowerManager | undefined
let activeBilibiliAuth: BilibiliAuthService | undefined
let activeBilibiliPublisher: BilibiliPublisher | undefined
let runtimeDiagnostics: RuntimeDiagnostics = {
  discoveryErrors: [],
  identityConflicts: []
}
const taskStore = new TaskStore()
const deletingTaskIds = new Set<string>()
const taskAcquisitionGuard = new TaskAcquisitionGuard()
const creatingCompanionRootIds = new Set<string>()
const videoFullscreenWindowIds = new Set<number>()
const taskThumbnails = new TaskThumbnailService()
const decodePng = (bytes: Buffer): boolean => !nativeImage.createFromBuffer(bytes).isEmpty()
const summaries = new SummaryService(decodePng)

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

function encodeBilibiliCoverJpeg(path: string): Buffer | undefined {
  let image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return undefined
  const size = image.getSize()
  const scale = Math.min(1, 1920 / size.width, 1080 / size.height)
  if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' })
  let bytes = image.toJPEG(90)
  if (bytes.length > 2_500_000) {
    image = image.resize({ width: Math.min(1280, image.getSize().width), quality: 'best' })
    bytes = image.toJPEG(82)
  }
  if (bytes.length > 2_800_000) throw new Error('投稿封面转换为 JPEG 后仍然过大，请选择尺寸更小的图片')
  return bytes
}

interface BilibiliCoverFfmpeg {
  executable: string
  env: NodeJS.ProcessEnv
  runExternal(spec: ProcessSpec): Promise<Awaited<ReturnType<typeof runProcess>>>
}

async function normalizeBilibiliCover(
  sourcePath: string,
  taskDirectory: string,
  resolveFfmpeg: () => Promise<BilibiliCoverFfmpeg>
): Promise<string> {
  const coverRelativePath = 'publication/cover.jpg'
  const publicationDirectory = join(taskDirectory, 'publication')
  await mkdir(publicationDirectory, { recursive: true })
  let bytes = encodeBilibiliCoverJpeg(sourcePath)
  if (!bytes) {
    const ffmpeg = await resolveFfmpeg()
    const temporaryPath = join(publicationDirectory, `.cover-${randomUUID()}.jpg`)
    try {
      const result = await ffmpeg.runExternal({
        command: ffmpeg.executable,
        args: [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', sourcePath,
          '-frames:v', '1',
          '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
          '-q:v', '4',
          temporaryPath
        ],
        cwd: taskDirectory,
        env: ffmpeg.env,
        timeoutMs: 60_000,
        captureLimitBytes: 256 * 1024
      })
      const diagnostic = `${result.stderr}\n${result.stdout}`.replace(/\s+/gu, ' ').trim().slice(-300)
      if (result.exitCode !== 0 || result.cancelled || result.timedOut) {
        throw new Error(`无法把任务缩略图转为 B站 JPEG 封面${diagnostic ? `：${diagnostic}` : ''}`)
      }
      bytes = await readFile(temporaryPath)
      const decoded = nativeImage.createFromBuffer(bytes)
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || decoded.isEmpty()) {
        throw new Error('任务缩略图转换后不是有效的 JPEG 图片')
      }
      if (bytes.length > 2_800_000) throw new Error('投稿封面转换为 JPEG 后仍然过大，请选择尺寸更小的图片')
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
  await writeAtomic(join(taskDirectory, coverRelativePath), bytes)
  return coverRelativePath
}

function setVideoFullscreen(window: BrowserWindow, fullscreen: boolean): void {
  window.setSimpleFullScreen(fullscreen)
  const active = window.isSimpleFullScreen()
  if (active) videoFullscreenWindowIds.add(window.id)
  else videoFullscreenWindowIds.delete(window.id)
  // Re-framing the native window drops keyboard focus, which would leave seek and play/pause keys
  // dead until the user clicks the picture.
  window.webContents.focus()
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

const HOMEBREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']

// 窗口底色只在首帧前和缩放时可见，但它必须跟得上有效主题，
// 否则浅色下启动会闪一下深底。取值与 app.css 的 --bg 两侧一致。
const WINDOW_BACKGROUND = { dark: '#0b0d10', light: '#f2f5f8' } as const
let themePreference: ThemePreference = 'system'

function windowBackgroundColor(): string {
  const dark = themePreference === 'system' ? nativeTheme.shouldUseDarkColors : themePreference === 'dark'
  return dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}

function applyThemePreference(preference: ThemePreference): void {
  themePreference = preference
  const color = windowBackgroundColor()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(color)
  }
}

nativeTheme.on('updated', () => applyThemePreference(themePreference))

async function resolveHomebrew(): Promise<string | undefined> {
  for (const candidate of HOMEBREW_CANDIDATES) {
    try { await access(candidate, fsConstants.X_OK); return candidate } catch { /* keep searching */ }
  }
  return undefined
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: 'Etch',
    backgroundColor: windowBackgroundColor(),
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

const verifyDocumentHtmlInBrowser: DocumentHtmlBrowserVerifier = async (htmlPath, desktopScreenshotPath, mobileScreenshotPath) => {
  const issues = new Set<string>()
  const partition = `etch-document-html-verifier-${randomUUID()}`
  const verifierSession = session.fromPartition(partition, { cache: false })
  verifierSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      issues.add(`阻止外部请求：${new URL(details.url).protocol}`)
      callback({ cancel: true })
    }
  )
  const verifyViewport = async (label: 'desktop' | 'mobile', width: number, height: number, screenshotPath: string): Promise<void> => {
    const window = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition }
    })
    window.webContents.setWindowOpenHandler(() => {
      issues.add(`${label} 视口尝试打开新窗口`)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault()
      issues.add(`${label} 视口尝试离开验收页面`)
    })
    window.webContents.on('will-attach-webview', (event) => {
      event.preventDefault()
      issues.add(`${label} 视口尝试附加 webview`)
    })
    try {
      await window.loadFile(htmlPath)
      const result = await window.webContents.executeJavaScript(`(async () => {
        await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 5000))]);
        const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
        const brokenImages = [...document.images].filter((image) => !image.complete || image.naturalWidth < 1).length;
        return {
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
          brokenImages,
          fontsLoaded: document.fonts.status === 'loaded'
        };
      })()`) as { overflow: boolean; duplicateIds: string[]; brokenImages: number; fontsLoaded: boolean }
      if (result.overflow) issues.add(`${label} 视口存在横向溢出`)
      if (result.duplicateIds.length) issues.add(`存在重复 id：${[...new Set(result.duplicateIds)].join(', ')}`)
      if (result.brokenImages) issues.add(`${label} 视口有 ${result.brokenImages} 张图片加载失败`)
      if (!result.fontsLoaded) issues.add(`${label} 视口字体加载未完成`)
      await writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG())
    } finally {
      if (!window.isDestroyed()) window.destroy()
    }
  }
  try {
    await verifyViewport('desktop', 1440, 1000, desktopScreenshotPath)
    await verifyViewport('mobile', 390, 844, mobileScreenshotPath)
    return { issues: [...issues] }
  } finally {
    verifierSession.webRequest.onBeforeRequest(null)
  }
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
    publicationCount: () => activeBilibiliPublisher?.activeTaskCount ?? 0,
    publications: activeBilibiliPublisher,
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

ipcMain.handle('app:bootstrap', async () => {
  const access = (await chromeCookieState()).access
  if (access === 'granted') {
    await appStateStore?.setFullDiskAccessGuideDismissed(false)
  }
  const appState = await appStateStore?.load()
  return BootstrapSchema.parse({
    version: app.getVersion(),
    arch: process.arch,
    showFullDiskAccessOnboarding: access === 'denied' && !(appState?.fullDiskAccessGuideDismissed ?? true),
    chromeCookieAccess: access,
    startupDiagnostics: runtimeDiagnostics
  })
})

function queuePage(offset = 0, limit = 100): unknown {
  if (!indexStore) throw new Error('Etch 尚未初始化')
  const items = indexStore.list(Math.min(Math.max(limit, 1), 100), Math.max(offset, 0)).map(({ taskId, rootTaskId, reusedFromTaskId, title, kind, category, status, revision, updatedAt, location }) => ({
    taskId,
    rootTaskId: rootTaskId ?? taskId,
    reusedFromTaskId,
    title,
    kind,
    category,
    status,
    revision,
    updatedAt,
    ...(activePipeline?.taskSchedule(location) ?? { schedule: 'idle' })
  }))
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
      started: async (pid, executable) => runRegistry.register({ runId, appInstanceToken, pid, pgid: pid, executable, taskId, stage: ENVIRONMENT_RUN_STAGE }).then(() => undefined),
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
  applyThemePreference(settings.theme)
  const bilibiliAccountStore = new BilibiliAccountStore(join(support, 'bilibili-account.json'), safeStorage)
  const bilibiliFetch: typeof fetch = process.env.ETCH_E2E_HERMETIC === '1' && process.env.ETCH_E2E_BILIBILI_NETWORK !== '1'
    ? async (input, init) => {
      const url = String(input)
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (process.env.ETCH_E2E_BILIBILI_FAILURE === '1' && url.includes('/qrcode/auth_code')) throw new TypeError('fetch failed')
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
      if (url.includes('/x/vupre/web/archive/pre')) return json({ code: 0, data: { typelist: [{ id: 160, name: '生活', children: [{ id: 21, name: '日常' }, { id: 138, name: '搞笑' }] }, { id: 1, name: '动画', children: [{ id: 24, name: 'MAD·AMV' }, { id: 27, name: '综合' }] }] } })
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
    if (manifest.kind === 'subtitle' && manifest.pipeline.stages.verify.status === 'completed') {
      void historicalGlossary.sync().catch((error) => console.error('global glossary sync failed', error))
      if (!recoveryHold) void publisher.considerAuto(taskDirectory).catch((error) => console.error('B站自动投稿排队失败', { taskId: manifest.taskId, error }))
    }
  }
  let pipelineWorkerCount = 0
  const syncPowerWorkers = (): void => powerManager.setActiveWorkers(pipelineWorkerCount + (publisherActive ? 1 : 0))
  const taskAcquisitionBlocked = (taskDirectory: string): boolean => taskAcquisitionGuard.isBlocked(taskDirectory)
  const pipeline = new TaskPipeline(taskStore, settings, historicalGlossary, publishManifest, runRegistry, (count) => {
    pipelineWorkerCount = count
    syncPowerWorkers()
  }, (health) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('tools:health-changed', ToolHealthSnapshotSchema.parse(health))
  }, undefined, (url) => session.defaultSession.resolveProxy(url), decodePng, taskAcquisitionBlocked)
  activePipeline = pipeline
  const sidecarPath = app.isPackaged
    ? join(process.resourcesPath, 'biliup', 'biliup')
    : join(app.getAppPath(), 'vendor', 'biliup', 'macos-arm64', 'biliup')
  const normalizePublicationCover = (sourcePath: string, taskDirectory: string): Promise<string> => normalizeBilibiliCover(
    sourcePath,
    taskDirectory,
    async () => {
      const full = await loginShellEnvironment(process.env, runAppScopedExternal)
      const env = operationalEnvironment(full)
      const health = await detectTool('ffmpeg', env, settings.toolOverrides.ffmpeg, runAppScopedExternal)
      if (health.status !== 'ready' || !health.executable) {
        throw new Error(`Etch 无法读取该封面，且无法启动 ffmpeg 转换：${health.summaryZh}`)
      }
      return { executable: health.executable, env, runExternal: runAppScopedExternal }
    }
  )
  const publisher = new BilibiliPublisher({
    store: taskStore,
    accountStore: bilibiliAccountStore,
    settings: () => settings,
    sidecarPath,
    temporaryRoot: join(support, 'bilibili-publish-tmp'),
    runRegistry,
    appRuns,
    publishManifest,
    normalizeCover: normalizePublicationCover,
    onActiveChange: (active) => {
      publisherActive = active
      syncPowerWorkers()
    },
    isTaskAcquisitionBlocked: taskAcquisitionBlocked
  })
  activeBilibiliPublisher = publisher
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
      if (task.kind !== 'subtitle' || deletingTaskIds.has(task.taskId)) continue
      void publisher!.considerAuto(task.location).catch((error) => console.error('B站自动投稿排队失败', { taskId: task.taskId, error }))
    }
  }
  restartPendingTasks = startPendingTasks
  const review = new TaskReviewService(taskStore, (taskDirectory) => pipeline.isRunning(taskDirectory), publishManifest)
  const documents = new DocumentService(taskStore, indexStore!, () => mainWindow)
  const documentHtml = new DocumentHtmlService(taskStore, indexStore!, verifyDocumentHtmlInBrowser)
  await documentHtml.recoverInterrupted()
  const detail = async (taskId: string): Promise<unknown> => {
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    const manifest = await taskStore.load(indexed.location)
    const artifact = manifest.kind === 'document'
      ? undefined
      : manifest.runtime.finalRelativePath && manifest.artifacts.final?.valid ? manifest.artifacts.final : manifest.artifacts.source
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
  ipcMain.handle('task:document-page', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    return DocumentPageSchema.parse(await documents.page(taskId))
  })
  ipcMain.handle('task:document-image', async (_event, raw) => {
    const { taskId, mediaId, expectedSha256 } = DocumentImagePayloadSchema.parse(raw)
    try {
      return DocumentImageDataUrlSchema.parse(await documents.image(taskId, mediaId, expectedSha256))
    } catch (error) {
      console.warn('document image unavailable', { taskId, mediaId, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  })
  ipcMain.handle('task:update-document-translation', async (_event, raw) => {
    const { taskId, expectedRevision, markdown } = UpdateDocumentTranslationSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    await documents.updateTranslation(taskId, expectedRevision, markdown)
    return detail(taskId)
  })
  ipcMain.handle('task:export-document', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    return ExportDocumentResultSchema.parse(await documents.export(taskId))
  })
  ipcMain.handle('task:open-document-source', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    await documents.openSource(taskId)
  })
  ipcMain.handle('task:document-html-page', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    return DocumentHtmlPageSchema.parse(await documentHtml.page(taskId))
  })
  ipcMain.handle('task:start-document-html', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, expectedRevision, route, templateId } = StartDocumentHtmlSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    await documentHtml.start(taskId, expectedRevision, route, templateId)
    return detail(taskId)
  })
  ipcMain.handle('task:resolve-document-html-style', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, expectedRevision, direction } = ResolveDocumentHtmlStyleSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    await documentHtml.resolveStyle(taskId, expectedRevision, direction)
    return detail(taskId)
  })
  ipcMain.handle('task:export-document-html', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const options = { title: '选择 HTML 导出位置', properties: ['openDirectory' as const, 'createDirectory' as const] }
    const selection = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || !selection.filePaths[0]) return ExportDocumentHtmlResultSchema.parse({ cancelled: true })
    const path = await documentHtml.exportTo(taskId, selection.filePaths[0])
    return ExportDocumentHtmlResultSchema.parse({ cancelled: false, path })
  })
  ipcMain.handle('task:thumbnail', async (_event, raw) => {
    const { taskId, expectedSha256 } = TaskThumbnailPayloadSchema.parse(raw)
    const indexed = indexStore!.get(taskId)
    if (!indexed) return undefined
    const manifest = await taskStore.load(indexed.location)
    const artifact = taskThumbnailArtifact(manifest)
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
    if (indexed.kind !== 'subtitle') throw new Error('当前任务不是字幕任务')
    return review.page(indexed.location, offset, limit)
  })
  ipcMain.handle('task:review-timeline-window', async (_event, raw) => {
    const payload = ReviewTimelineWindowPayloadSchema.parse(raw)
    const indexed = indexStore!.get(payload.taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'subtitle') throw new Error('当前任务不是字幕任务')
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
    if (indexed.kind !== 'subtitle') throw new Error('当前任务不是字幕任务')
    await review.update(indexed.location, expectedRevision, edits)
    return detail(taskId)
  })
  ipcMain.handle('task:update-glossary', async (_event, raw) => {
    const { taskId, expectedRevision, edits } = UpdateGlossarySchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'subtitle') throw new Error('当前任务不是字幕任务')
    await review.updateGlossary(indexed.location, expectedRevision, edits)
    return detail(taskId)
  })
  ipcMain.handle('task:update-subtitle-preset', async (_event, raw) => {
    const { taskId, expectedRevision, preset } = UpdateSubtitlePresetSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'subtitle') throw new Error('当前任务不是字幕任务')
    await review.updateSubtitlePreset(indexed.location, expectedRevision, preset)
    return detail(taskId)
  })
  ipcMain.handle('task:preview-glossary-apply', async (_event, raw) => {
    const { taskId, expectedRevision, edits } = UpdateGlossarySchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'subtitle') throw new Error('当前任务不是字幕任务')
    return GlossaryImpactPreviewSchema.parse(await review.previewGlossaryApply(indexed.location, expectedRevision, edits))
  })
  ipcMain.handle('task:apply-glossary', async (_event, raw) => {
    const { taskId, expectedRevision, impactFingerprint, edits } = GlossaryApplyPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'subtitle') throw new Error('当前任务不是字幕任务')
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
    if (!indexedBeforeDelete) throw new Error('任务不存在')
    deletingTaskIds.add(taskId)
    taskAcquisitionGuard.block(indexedBeforeDelete.location)
    let deleted = false
    try {
      const baseOptions = {
        taskId,
        indexStore: indexStore!,
        registry,
        taskStore,
        isRunning: (taskDirectory: string) => pipeline.isRunning(taskDirectory),
        hasActiveProviderRun: async (activeTaskId: string, taskDirectory: string) =>
          publisher!.hasTask(activeTaskId) || publisher!.hasDirectory(taskDirectory) || await runRegistry.hasActiveTask(activeTaskId),
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
      deleted = true
      taskThumbnails.forget(taskId)
      summaries.forget(taskId)
      taskNotifier.forget(taskId)
      review.forget(taskId, indexedBeforeDelete?.location)
      await historicalGlossary.sync().catch((error) => console.error('global glossary delete reconciliation failed', error))
      return queuePage()
    } finally {
      if (!deleted) {
        deletingTaskIds.delete(taskId)
        taskAcquisitionGuard.unblock(indexedBeforeDelete.location)
      }
    }
  })
  ipcMain.handle('task:set-category', async (_event, raw) => {
    const { taskId, category } = SetTaskCategoryPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    // 分类只是归档位，不碰阶段状态，所以运行中的任务也允许改。
    const manifest = await taskStore.mutate(indexed.location, (draft) => {
      draft.category = category
    })
    indexStore!.upsert(indexed.location, manifest)
    return queuePage()
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
    // 英文源字幕歧义属于共享底稿阶段，字幕与总结任务都会停在这里；只有文档任务没有英文字幕。
    if (indexed.kind === 'document') throw new Error('当前任务不是视频任务')
    await pipeline.resolveAudit(indexed.location, decisions)
    if (!pipeline.isRunning(indexed.location)) void pipeline.start(indexed.location).catch((error) => console.error('pipeline failed', error))
    return detail(taskId)
  })
  ipcMain.handle('task:resolve-video-checkpoint', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, expectedRevision, decision } = ResolveVideoCheckpointSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind === 'document') throw new Error('当前任务不是视频任务')
    await pipeline.resolveVideoCheckpoint(indexed.location, expectedRevision, decision)
    if (!pipeline.isRunning(indexed.location)) void pipeline.start(indexed.location).catch((error) => console.error('pipeline failed', error))
    return detail(taskId)
  })
  ipcMain.handle('task:resolve-research-checkpoint', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, expectedRevision, decision } = ResolveResearchCheckpointSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'summary') throw new Error('当前任务不是视频总结任务')
    await pipeline.resolveResearchCheckpoint(indexed.location, expectedRevision, decision)
    if (!pipeline.isRunning(indexed.location)) void pipeline.start(indexed.location).catch((error) => console.error('pipeline failed', error))
    return detail(taskId)
  })
  ipcMain.handle('task:resolve-document-translation-cost', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, expectedRevision, decision } = ResolveDocumentTranslationCostSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'document') throw new Error('当前任务不是网页翻译任务')
    await pipeline.resolveDocumentTranslationCost(indexed.location, expectedRevision, decision)
    if (!pipeline.isRunning(indexed.location)) void pipeline.start(indexed.location).catch((error) => console.error('pipeline failed', error))
    return detail(taskId)
  })
  ipcMain.handle('task:resolve-illustration-agent', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, expectedRevision, choice } = ResolveIllustrationAgentSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'summary') throw new Error('当前任务不是视频总结任务')
    await pipeline.resolveIllustrationAgent(indexed.location, expectedRevision, choice)
    if (!pipeline.isRunning(indexed.location)) void pipeline.start(indexed.location).catch((error) => console.error('pipeline failed', error))
    return detail(taskId)
  })
  ipcMain.handle('task:resolve-illustration-cover', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId, expectedRevision, decision } = ResolveIllustrationCoverSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'summary') throw new Error('当前任务不是视频总结任务')
    await pipeline.resolveIllustrationCover(indexed.location, expectedRevision, decision)
    if (!pipeline.isRunning(indexed.location)) void pipeline.start(indexed.location).catch((error) => console.error('pipeline failed', error))
    return detail(taskId)
  })
  ipcMain.handle('task:summary-page', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    const manifest = await taskStore.load(indexed.location)
    if (manifest.kind !== 'summary') throw new Error('当前任务不是视频总结任务')
    return SummaryPageSchema.parse(await summaries.page(taskId, indexed.location, manifest))
  })
  ipcMain.handle('task:summary-image', async (_event, raw) => {
    const { taskId, filename, expectedSha256 } = SummaryImagePayloadSchema.parse(raw)
    const indexed = indexStore!.get(taskId)
    if (!indexed) return undefined
    const manifest = await taskStore.load(indexed.location)
    if (manifest.kind !== 'summary') return undefined
    try {
      return SummaryImageDataUrlSchema.parse(await summaries.image(taskId, indexed.location, manifest, filename, expectedSha256))
    } catch (error) {
      console.warn('summary image unavailable', { taskId, filename, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  })
  ipcMain.handle('task:export-summary', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    const manifest = await taskStore.load(indexed.location)
    if (manifest.kind !== 'summary') throw new Error('当前任务不是视频总结任务')
    const options = { title: '选择总结导出位置', properties: ['openDirectory' as const, 'createDirectory' as const] }
    const selection = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || !selection.filePaths[0]) return ExportSummaryResultSchema.parse({ cancelled: true })
    const exported = await summaries.export(indexed.location, manifest, selection.filePaths[0])
    return ExportSummaryResultSchema.parse({ cancelled: false, directory: exported.directory, images: exported.images })
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
    applyThemePreference(next.theme)
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
  ipcMain.handle('models:catalog', async (_event, raw) => {
    const { provider } = ModelCatalogPayloadSchema.parse(raw)
    const override = settings.toolOverrides[provider]
    const catalog = await modelCatalogCache.read(provider, `${override ?? ''}`, async () => {
      if (!providerSupportsModelListing(provider)) return probeModelCatalog(provider, undefined, {})
      const full = await loginShellEnvironment(process.env, runAppScopedExternal)
      const env = providerEnvironment(provider, full)
      logChildEnvironmentKeys(`model-catalog:${provider}`, env)
      const executable = await resolveToolExecutable(provider, env, override)
      return probeModelCatalog(provider, executable, env, runAppScopedExternal)
    })
    return ProviderModelCatalogSchema.parse(catalog)
  })
  ipcMain.handle('tools:install', async (_event, raw) => {
    const { tool } = ToolInstallPayloadSchema.parse(raw)
    const brew = await resolveHomebrew()
    if (!brew) {
      await shell.openExternal('https://brew.sh')
      return ToolInstallResultSchema.parse({ outcome: 'homebrew-missing' })
    }
    const scriptDirectory = join(support, 'tool-install')
    await mkdir(scriptDirectory, { recursive: true })
    const scriptPath = join(scriptDirectory, `install-${tool}.command`)
    await writeFile(scriptPath, toolInstallScript(tool, brew), { mode: 0o755 })
    const failure = await shell.openPath(scriptPath)
    if (failure) throw new Error(`无法在终端启动安装：${failure}`)
    return ToolInstallResultSchema.parse({ outcome: 'launched' })
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
    if (indexed.kind !== 'subtitle') throw new Error('只有硬字幕视频可以投稿 B站')
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, { title: '选择 B站投稿封面', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] })
      : await dialog.showOpenDialog({ title: '选择 B站投稿封面', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] })
    if (result.canceled || !result.filePaths[0]) return BilibiliPublicationCoverSchema.parse({ cancelled: true })
    const coverRelativePath = await normalizePublicationCover(result.filePaths[0], indexed.location)
    const coverPath = join(indexed.location, coverRelativePath)
    const bytes = await readFile(coverPath)
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
    if (indexed.kind !== 'subtitle') throw new Error('只有硬字幕视频可以投稿 B站')
    await publisher!.start(indexed.location, draft)
    return detail(taskId)
  })
  ipcMain.handle('bilibili:stop', async (_event, raw) => {
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'subtitle') throw new Error('只有硬字幕视频可以投稿 B站')
    await publisher!.stop(indexed.location)
    return detail(taskId)
  })
  ipcMain.handle('bilibili:continue', async (_event, raw) => {
    assertRecoveryReleased()
    const { taskId } = TaskIdPayloadSchema.parse(raw)
    if (deletingTaskIds.has(taskId)) throw new Error('任务正在删除')
    const indexed = indexStore!.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    if (indexed.kind !== 'subtitle') throw new Error('只有硬字幕视频可以投稿 B站')
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
  ipcMain.handle('permissions:request-chrome-cookie-access', async () => {
    await shell.openExternal(fullDiskAccessSettingsUrl())
    await appStateStore?.setFullDiskAccessGuideDismissed(true)
    return true
  })
  ipcMain.handle('permissions:chrome-cookie-access', async () => {
    const access = (await chromeCookieState()).access
    if (access === 'granted') {
      await appStateStore?.setFullDiskAccessGuideDismissed(false)
    }
    return ChromeCookieAccessSchema.parse(access)
  })
  ipcMain.handle('permissions:dismiss-full-disk-access-guide', () => appStateStore!.setFullDiskAccessGuideDismissed(true))
  ipcMain.handle('permissions:relaunch-app', () => {
    // TCC 授权按进程评估，必须整个 App 重建进程才能生效。
    app.relaunch()
    app.quit()
  })
  ipcMain.handle('task:create-urls', async (_event, raw) => {
    const payload = CreateUrlsSchema.parse(raw)
    if (payload.kind !== 'document') {
      const unsupported = payload.urls.find((url) => !isSupportedMediaSourceUrl(url))
      if (unsupported) throw new Error('视频链接仅支持 YouTube、Vimeo、X 或 Twitter 的公开 HTTPS URL')
    }
    for (const url of payload.urls) {
      const documentProvider = payload.kind === 'document' && payload.documentMode === 'convert' ? undefined : payload.provider
      const manifest = createTaskManifest(
        { kind: 'url', url },
        '',
        documentProvider,
        payload.styleNote,
        settings.subtitlePreset,
        payload.autoPublish,
        payload.kind,
        payload.category,
        payload.documentMode,
        payload.documentTranslationMode,
        payload.documentAudience,
        payload.documentWritingStyle,
        documentProvider ? payload.model : { source: 'cli-default' }
      )
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
  ipcMain.handle('task:create-companion', async (_event, raw) => {
    assertRecoveryReleased()
    const payload = CreateCompanionSchema.parse(raw)
    const sourceTask = indexStore!.get(payload.taskId)
    if (!sourceTask || deletingTaskIds.has(payload.taskId)) throw new Error('任务不存在或正在删除')
    if (sourceTask.kind === 'document') throw new Error('网页翻译任务不支持追加视频成果')
    const targetKind = sourceTask.kind === 'subtitle' ? 'summary' : 'subtitle'
    const sourceRootTaskId = sourceTask.rootTaskId ?? sourceTask.taskId
    if (creatingCompanionRootIds.has(sourceRootTaskId)) throw new Error('另一种成果正在创建，请稍候')
    creatingCompanionRootIds.add(sourceRootTaskId)
    try {
      const existing = indexStore!.all().find((task) => (task.rootTaskId ?? task.taskId) === sourceRootTaskId && task.kind === targetKind)
      if (existing) return detail(existing.taskId)

      const source = await taskStore.load(sourceTask.location)
      const targetTaskId = randomUUID()
      const targetDirectory = join(settings.workspaceRoot, `pending--${targetTaskId.slice(0, 8)}`)
      let registered = false
      try {
        const manifest = await createCompanionManifest(sourceTask.location, targetDirectory, source, { ...payload, targetTaskId })
        await taskStore.create(targetDirectory, manifest)
        await registry.addTaskLocation(targetDirectory)
        registered = true
        indexStore!.upsert(targetDirectory, manifest)
        restartPendingTasks?.()
        return detail(manifest.taskId)
      } catch (error) {
        if (!registered) await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    } finally {
      creatingCompanionRootIds.delete(sourceRootTaskId)
    }
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
