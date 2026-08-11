import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')

describe('main runtime safety wiring', () => {
  it('acquires the single-instance lock before readiness and gates startup recovery on it', () => {
    const setUserData = source.indexOf("app.setPath('userData'")
    const acquire = source.indexOf('app.requestSingleInstanceLock()')
    const ready = source.indexOf('app.whenReady()')

    expect(setUserData).toBeGreaterThan(-1)
    expect(acquire).toBeGreaterThan(setUserData)
    expect(ready).toBeGreaterThan(acquire)
    expect(source).toContain('if (!hasSingleInstanceLock) app.quit()')
    expect(source).toContain('if (hasSingleInstanceLock) void app.whenReady()')
    expect(source).toContain("app.on('second-instance'")
  })

  it('sets the packaged macOS Dock icon from the bundled application icon', () => {
    const readyBlock = source.slice(source.indexOf('if (hasSingleInstanceLock) void app.whenReady()'))
    expect(source).toContain("nativeImage.createFromPath(join(process.resourcesPath, 'icon.png'))")
    expect(source).toContain('if (!icon.isEmpty()) app.dock?.setIcon(icon)')
    expect(readyBlock).toContain('installDockIcon()')
  })

  it('persists recovery release before lowering the in-memory hold', () => {
    const handler = source.slice(
      source.indexOf("ipcMain.handle('recovery:release'"),
      source.indexOf("ipcMain.handle('task:resolve-audit'")
    )

    expect(handler.indexOf('await confirmProviderRecovery(runRegistry, appStateStore!)')).toBeGreaterThan(-1)
    expect(handler.indexOf('recoveryHold = !confirmation.released')).toBeGreaterThan(handler.indexOf('await confirmProviderRecovery(runRegistry, appStateStore!)'))
  })

  it('keeps the shared English source audit checkpoint resolvable for summary tasks', () => {
    const handler = source.slice(
      source.indexOf("ipcMain.handle('task:resolve-audit'"),
      source.indexOf("ipcMain.handle('task:resolve-video-checkpoint'")
    )

    expect(handler).not.toContain("kind !== 'subtitle'")
    expect(handler).toContain("if (indexed.kind === 'document') throw new Error('当前任务不是视频任务')")
    expect(handler).toContain('await pipeline.resolveAudit(indexed.location, decisions)')
  })

  it('keeps startup diagnosable when recovery data is corrupt and remembers focus requests during initialization', () => {
    expect(source).toContain('focusRequestedWhileInitializing = true')
    expect(source).toContain('if (focusRequestedWhileInitializing)')
    expect(source).toContain("console.error('Etch 初始化失败', error)")
    expect(source).toContain("dialog.showErrorBox('Etch 无法启动'")
    expect(source).toContain('app.quit()')
    expect(source).toContain('recoverProviderRunsAtStartup(runRegistry, appStateStore)')
  })

  it('drains pending tasks after create, unpause, recovery release and startup while exposing explicit stop/resume IPC', () => {
    const dispatcher = source.slice(source.indexOf('const startPendingTasks ='))
    expect(dispatcher).toContain('if (settings.queuePaused || recoveryHold) return')
    expect(dispatcher).toContain("task.status === 'pending'")
    expect(dispatcher).toContain('left.updatedAt.localeCompare(right.updatedAt)')
    expect(dispatcher).toContain('void pipeline.start(task.location)')
    expect(source.match(/startPendingTasks\(\)/gu)).toHaveLength(4)
    expect(source).toContain("ipcMain.handle('task:stop'")
    expect(source).toContain('await pipeline.stop(indexed.location)')
    expect(source).toContain('await pipeline.resume(indexed.location)')
  })
})
