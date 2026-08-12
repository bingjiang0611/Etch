import { contextBridge, ipcRenderer } from 'electron'
import type { EtchApi } from '../shared/ipc'

const api: EtchApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  queuePage: (offset = 0, limit = 100) => ipcRenderer.invoke('queue:page', { offset, limit }),
  createUrls: (urls, provider, styleNote = '', autoPublish = false, kind = 'subtitle', category = '', documentMode = 'auto', documentTranslationMode = 'normal', documentAudience = 'general', documentWritingStyle = 'storytelling', model = { source: 'cli-default' }) => ipcRenderer.invoke('task:create-urls', {
    urls, provider, styleNote, autoPublish, kind, category, documentMode, documentTranslationMode, documentAudience, documentWritingStyle, model
  }),
  createCompanion: (taskId, provider, styleNote = '', autoPublish = false, model = { source: 'cli-default' }) => ipcRenderer.invoke('task:create-companion', { taskId, provider, styleNote, autoPublish, model }),
  modelCatalog: (provider) => ipcRenderer.invoke('models:catalog', { provider }),
  taskDetail: (taskId) => ipcRenderer.invoke('task:detail', { taskId }),
  taskThumbnail: (taskId, expectedSha256) => ipcRenderer.invoke('task:thumbnail', { taskId, expectedSha256 }),
  startTask: (taskId) => ipcRenderer.invoke('task:start', { taskId }),
  stopTask: (taskId) => ipcRenderer.invoke('task:stop', { taskId }),
  deleteTask: (taskId, mode) => ipcRenderer.invoke('task:delete', { taskId, mode }),
  setTaskCategory: (taskId, category) => ipcRenderer.invoke('task:set-category', { taskId, category }),
  revealTask: (taskId) => ipcRenderer.invoke('task:reveal', { taskId }),
  recoveryState: () => ipcRenderer.invoke('recovery:state'),
  releaseRecovery: () => ipcRenderer.invoke('recovery:release'),
  resolveAudit: (taskId, decisions) => ipcRenderer.invoke('task:resolve-audit', { taskId, decisions }),
  resolveVideoCheckpoint: (taskId, expectedRevision, decision) => ipcRenderer.invoke('task:resolve-video-checkpoint', { taskId, expectedRevision, decision }),
  resolveResearchCheckpoint: (taskId, expectedRevision, decision) => ipcRenderer.invoke('task:resolve-research-checkpoint', { taskId, expectedRevision, decision }),
  resolveDocumentTranslationCost: (taskId, expectedRevision, decision) => ipcRenderer.invoke('task:resolve-document-translation-cost', { taskId, expectedRevision, decision }),
  resolveIllustrationAgent: (taskId, expectedRevision, choice) => ipcRenderer.invoke('task:resolve-illustration-agent', { taskId, expectedRevision, choice }),
  resolveIllustrationCover: (taskId, expectedRevision, decision) => ipcRenderer.invoke('task:resolve-illustration-cover', { taskId, expectedRevision, decision }),
  summaryPage: (taskId) => ipcRenderer.invoke('task:summary-page', { taskId }),
  summaryImage: (taskId, filename, expectedSha256) => ipcRenderer.invoke('task:summary-image', { taskId, filename, expectedSha256 }),
  exportSummary: (taskId) => ipcRenderer.invoke('task:export-summary', { taskId }),
  documentPage: (taskId) => ipcRenderer.invoke('task:document-page', { taskId }),
  documentImage: (taskId, mediaId, expectedSha256) => ipcRenderer.invoke('task:document-image', { taskId, mediaId, expectedSha256 }),
  updateDocumentTranslation: (taskId, expectedRevision, markdown) => ipcRenderer.invoke('task:update-document-translation', { taskId, expectedRevision, markdown }),
  exportDocument: (taskId) => ipcRenderer.invoke('task:export-document', { taskId }),
  openDocumentSource: (taskId) => ipcRenderer.invoke('task:open-document-source', { taskId }),
  documentHtmlPage: (taskId) => ipcRenderer.invoke('task:document-html-page', { taskId }),
  startDocumentHtml: (taskId, expectedRevision, route = 'preview', templateId) => ipcRenderer.invoke('task:start-document-html', { taskId, expectedRevision, route, templateId }),
  resolveDocumentHtmlStyle: (taskId, expectedRevision, direction) => ipcRenderer.invoke('task:resolve-document-html-style', { taskId, expectedRevision, direction }),
  exportDocumentHtml: (taskId) => ipcRenderer.invoke('task:export-document-html', { taskId }),
  completeReview: (taskId, expectedRevision) => ipcRenderer.invoke('task:complete-review', { taskId, expectedRevision }),
  reviewPage: (taskId, offset = 0, limit = 100) => ipcRenderer.invoke('task:review-page', { taskId, offset, limit }),
  reviewTimelineWindow: (taskId, milliseconds, expectedRevision, expectedEnglishSha256, expectedChineseSha256, limit = 100) => ipcRenderer.invoke('task:review-timeline-window', {
    taskId, milliseconds, expectedRevision, expectedEnglishSha256, expectedChineseSha256, limit
  }),
  glossaryCatalogPage: (query = '', offset = 0) => ipcRenderer.invoke('glossary:catalog-page', { query, offset, limit: 50 }),
  deleteGlossaryEntry: (entryId, expectedRevision) => ipcRenderer.invoke('glossary:delete-entry', { entryId, expectedRevision }),
  updateCues: (taskId, expectedRevision, edits) => ipcRenderer.invoke('task:update-cues', { taskId, expectedRevision, edits }),
  updateGlossary: (taskId, expectedRevision, edits) => ipcRenderer.invoke('task:update-glossary', { taskId, expectedRevision, edits }),
  updateSubtitlePreset: (taskId, expectedRevision, preset) => ipcRenderer.invoke('task:update-subtitle-preset', { taskId, expectedRevision, preset }),
  previewGlossaryApply: (taskId, expectedRevision, edits) => ipcRenderer.invoke('task:preview-glossary-apply', { taskId, expectedRevision, edits }),
  applyGlossary: (taskId, expectedRevision, impactFingerprint, edits) => ipcRenderer.invoke('task:apply-glossary', { taskId, expectedRevision, impactFingerprint, edits }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  detectTools: () => ipcRenderer.invoke('tools:detect'),
  installTool: (tool) => ipcRenderer.invoke('tools:install', { tool }),
  bilibiliAccount: () => ipcRenderer.invoke('bilibili:account'),
  startBilibiliQrLogin: () => ipcRenderer.invoke('bilibili:qr-start'),
  pollBilibiliQrLogin: (sessionId) => ipcRenderer.invoke('bilibili:qr-state', { sessionId }),
  disconnectBilibili: () => ipcRenderer.invoke('bilibili:disconnect'),
  bilibiliPartitions: () => ipcRenderer.invoke('bilibili:partitions'),
  selectBilibiliCover: (taskId) => ipcRenderer.invoke('bilibili:select-cover', { taskId }),
  publishToBilibili: (taskId, draft) => ipcRenderer.invoke('bilibili:publish', { taskId, draft }),
  stopBilibiliPublication: (taskId) => ipcRenderer.invoke('bilibili:stop', { taskId }),
  continueBilibiliPublication: (taskId) => ipcRenderer.invoke('bilibili:continue', { taskId }),
  openBilibiliCreatorCenter: () => ipcRenderer.invoke('bilibili:open-creator-center'),
  setVideoFullscreen: (fullscreen) => ipcRenderer.invoke('video:set-fullscreen', fullscreen),
  requestChromeCookieAccess: () => ipcRenderer.invoke('permissions:request-chrome-cookie-access'),
  chromeCookieAccess: () => ipcRenderer.invoke('permissions:chrome-cookie-access'),
  dismissFullDiskAccessGuide: () => ipcRenderer.invoke('permissions:dismiss-full-disk-access-guide'),
  relaunchApp: () => ipcRenderer.invoke('permissions:relaunch-app'),
  onVideoFullscreenChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, fullscreen: boolean): void => listener(fullscreen)
    ipcRenderer.on('video:fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('video:fullscreen-changed', handler)
  },
  onToolHealthChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, health: Parameters<typeof listener>[0]): void => listener(health)
    ipcRenderer.on('tools:health-changed', handler)
    return () => ipcRenderer.removeListener('tools:health-changed', handler)
  },
  onOpenSettings: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('app:open-settings', handler)
    return () => ipcRenderer.removeListener('app:open-settings', handler)
  }
}

contextBridge.exposeInMainWorld('etch', api)
