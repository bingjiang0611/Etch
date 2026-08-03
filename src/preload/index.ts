import { contextBridge, ipcRenderer } from 'electron'
import type { EtchApi } from '../shared/ipc'

const api: EtchApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  queuePage: (offset = 0, limit = 100) => ipcRenderer.invoke('queue:page', { offset, limit }),
  createUrls: (urls, provider, styleNote = '') => ipcRenderer.invoke('task:create-urls', { urls, provider, styleNote }),
  taskDetail: (taskId) => ipcRenderer.invoke('task:detail', { taskId }),
  taskThumbnail: (taskId, expectedSha256) => ipcRenderer.invoke('task:thumbnail', { taskId, expectedSha256 }),
  startTask: (taskId) => ipcRenderer.invoke('task:start', { taskId }),
  stopTask: (taskId) => ipcRenderer.invoke('task:stop', { taskId }),
  deleteTask: (taskId, mode) => ipcRenderer.invoke('task:delete', { taskId, mode }),
  revealTask: (taskId) => ipcRenderer.invoke('task:reveal', { taskId }),
  recoveryState: () => ipcRenderer.invoke('recovery:state'),
  releaseRecovery: () => ipcRenderer.invoke('recovery:release'),
  resolveAudit: (taskId, decisions) => ipcRenderer.invoke('task:resolve-audit', { taskId, decisions }),
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
  setVideoFullscreen: (fullscreen) => ipcRenderer.invoke('video:set-fullscreen', fullscreen),
  openFullDiskAccessSettings: () => ipcRenderer.invoke('permissions:open-full-disk-access-settings'),
  onVideoFullscreenChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, fullscreen: boolean): void => listener(fullscreen)
    ipcRenderer.on('video:fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('video:fullscreen-changed', handler)
  },
  onOpenSettings: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('app:open-settings', handler)
    return () => ipcRenderer.removeListener('app:open-settings', handler)
  }
}

contextBridge.exposeInMainWorld('etch', api)
