import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { formatTimestamp } from '../src/core/srt'
import { sha256File } from '../src/main/core/fingerprint'
import { NEW_TASK_PROVIDER_STORAGE_KEY } from '../src/renderer/new-task-provider'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest } from '../src/shared/task-schema'
import {
  launchHermeticEtch,
  writeHermeticSettings,
  writeSeekableVideoFixture
} from './fixtures/hermetic-tools'

const thumbnailPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlHYAAAAASUVORK5CYII=', 'base64')

async function openNewTaskDialog(window: Page) {
  await window.getByRole('button', { name: '新建任务', exact: true }).click()
  const dialog = window.getByRole('dialog', { name: '新建任务' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#content-url')).toBeFocused()
  return dialog
}

async function addUrlTask(window: Page, url: string, styleNote?: string): Promise<void> {
  const dialog = await openNewTaskDialog(window)
  await dialog.locator('#content-url').fill(url)
  if (styleNote !== undefined) await dialog.getByLabel(/翻译风格/).fill(styleNote)
  await expect(dialog.locator('#provider option:checked')).toBeEnabled({ timeout: 75_000 })
  await dialog.getByRole('button', { name: /^(?:创建并开始|加入暂停队列)(?:（\d+）)?$/u }).click()
  await expect(dialog).toBeHidden()
}

async function openSettingsFromApplicationMenu(application: ElectronApplication, window: Page): Promise<void> {
  const menuItem = await application.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('settings')
    return item ? { label: item.label, accelerator: item.accelerator } : undefined
  })
  expect(menuItem).toEqual({ label: '设置…', accelerator: 'CommandOrControl+,' })
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('settings')?.click())
  await expect(window.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
}

async function quitApplication(application: ElectronApplication): Promise<void> {
  for (const window of application.windows()) {
    await window.evaluate(async () => {
      const queue = await window.etch.queuePage()
      for (const item of queue.items) {
        const detail = await window.etch.taskDetail(item.taskId)
        if (Object.values(detail.manifest.pipeline.stages).some((stage) => stage.status === 'running')) {
          await window.etch.stopTask(item.taskId)
        }
      }
    }).catch(() => undefined)
    const health = window.locator('.runtime-state strong')
    if (await health.count()) {
      try {
        await expect(health).toHaveText(/环境 9\/9 可用/, { timeout: 30_000 })
      } catch (error) {
        // 只在断言已经失败之后再探一次，用来指名到底是哪个工具掉了；不会把失败改写成通过。
        const snapshots = await window.evaluate(() => window.etch.detectTools())
        const broken = snapshots.filter((snapshot) => snapshot.status !== 'ready')
        throw new Error(`${(error as Error).message}\n未就绪工具：${JSON.stringify(broken)}`)
      }
    }
  }
  const userData = await application.evaluate(({ app }) => app.getPath('userData'))
  await expect.poll(async () => {
    try {
      const registry = JSON.parse(await readFile(join(userData, 'run-registry.json'), 'utf8')) as { active?: unknown[] }
      return registry.active?.length ?? 0
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : -1
    }
  }, { timeout: 30_000 }).toBe(0)
  const childProcess = application.process()
  const exited = childProcess ? new Promise<void>((resolve) => childProcess.once('exit', () => resolve())) : Promise.resolve()
  await application.evaluate(({ app }) => app.quit())
  await exited
}

test('shows the Chrome cookie access guide only on the first launch', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-onboarding-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const chromeDirectory = join(userData, 'home/Library/Application Support/Google/Chrome')
  await Promise.all([mkdir(workspaceRoot), mkdir(chromeDirectory, { recursive: true })])
  const localState = join(chromeDirectory, 'Local State')
  await writeFile(localState, '{"profile":{"last_used":"Default"}}')
  await chmod(localState, 0o000)
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  try {
    const firstLaunch = await launchHermeticEtch(userData)
    try {
      const window = await firstLaunch.firstWindow()
      const guide = window.getByRole('dialog', { name: '允许 Etch 读取 Chrome 登录状态' })
      await expect(guide).toBeVisible()
      await expect(guide).toContainText('完全磁盘访问')
      await expect(guide.getByRole('button', { name: '打开系统设置', exact: true })).toBeVisible()
      await guide.getByRole('button', { name: '稍后设置', exact: true }).click()
      await expect(guide).toBeHidden()
      await expect.poll(async () => JSON.parse(await readFile(join(userData, 'app-state.json'), 'utf8')).fullDiskAccessGuideDismissed).toBe(true)
    } finally {
      await quitApplication(firstLaunch)
    }

    const secondLaunch = await launchHermeticEtch(userData)
    try {
      const window = await secondLaunch.firstWindow()
      await expect(window.getByRole('heading', { name: '任务队列', exact: true })).toBeVisible()
      await expect(window.getByRole('dialog')).toHaveCount(0)
    } finally {
      await quitApplication(secondLaunch)
    }
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})

test('creates a durable URL task through the real Electron IPC boundary', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot)
  const hermetic = await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: false, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  const application = await launchHermeticEtch(userData)
  try {
    let window = await application.firstWindow()
    await expect
      .poll(async () => {
        for (const candidate of application.windows()) {
          if ((await candidate.evaluate(() => document.querySelector('h1')?.textContent)) === '任务队列') {
            window = candidate
            return true
          }
        }
        return false
      })
      .toBe(true)
    await expect(window.locator('.runtime-state strong')).toHaveText(/环境 \d+\/9 可用/, { timeout: 75_000 })
    await expect.poll(async () => {
      const log = await readFile(hermetic.invocationLog, 'utf8')
      return new Set(log.trim().split('\n').map((line) => line.split('\t')[0])).size
    }).toBe(9)
    await expect(window.locator('.status-dot')).toHaveAttribute('data-status', 'ready')
    await expect(window.locator('.brand')).toHaveText('Etch')
    await expect(window.locator('.brand-mark')).toHaveCount(0)
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(0)
    await expect(window.locator('nav .nav-item')).toHaveCount(2)
    await expect(window.locator('nav').getByRole('button', { name: '设置', exact: true })).toHaveCount(0)
    await expect(window.locator('.url-entry')).toHaveCount(0)
    let newTaskDialog = await openNewTaskDialog(window)
    await newTaskDialog.getByRole('radio', { name: /网页翻译/u }).check()
    await expect(newTaskDialog.getByLabel('翻译 Agent')).toBeEnabled({ timeout: 75_000 })
    await newTaskDialog.getByLabel('翻译 Agent').selectOption('codex')
    await expect(newTaskDialog.getByLabel('翻译 Agent')).toHaveValue('codex')
    await newTaskDialog.getByLabel('处理模式').selectOption('convert')
    await expect(newTaskDialog.getByLabel('翻译 Agent')).toBeDisabled()
    await expect(newTaskDialog.getByLabel('翻译 Agent')).toHaveValue('none')
    await expect(newTaskDialog).toContainText('当前模式只转换结构，不会调用 Agent')
    await newTaskDialog.getByLabel('处理模式').selectOption('translate')
    await expect(newTaskDialog.getByLabel('翻译 Agent')).toBeEnabled()
    await expect(newTaskDialog.getByLabel('翻译 Agent')).toHaveValue('codex')
    await newTaskDialog.getByLabel('翻译 Agent').selectOption('qoder')
    await newTaskDialog.getByRole('radio', { name: /双语硬字幕/u }).check()
    await newTaskDialog.locator('#content-url').fill('https://example.com/preserved-draft')
    await window.keyboard.press('Escape')
    await expect(newTaskDialog).toBeHidden()
    newTaskDialog = await openNewTaskDialog(window)
    await expect(newTaskDialog.locator('#content-url')).toHaveValue('https://example.com/preserved-draft')
    await newTaskDialog.getByLabel(/翻译 Provider/u).selectOption('claude')
    await newTaskDialog.locator('#content-url').fill('https://vimeo.com/100000010\nhttps://vimeo.com/100000010')
    await expect(newTaskDialog).toContainText('已输入 1 个')
    await newTaskDialog.getByLabel(/翻译风格/).fill('简洁自然，保留现场感')
    await newTaskDialog.getByRole('button', { name: '加入暂停队列', exact: true }).evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await expect(newTaskDialog).toBeHidden()
    await expect(window.getByRole('tab', { name: /全部任务/u }).locator('.tab-count')).toHaveText('1')
    await expect
      .poll(() => window.evaluate(() => document.querySelector('.task-row')?.textContent))
      .toContain('https://vimeo.com/100000010')
    await expect(window.locator('.task-row .thumb img')).toHaveCount(0)
    await expect(window.locator('nav .nav-item')).toHaveCount(2)
    await expect(window.getByRole('button', { name: '工作台', exact: true })).toHaveCount(0)
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const page = await window.etch.queuePage()
          const translation = (await window.etch.taskDetail(page.items[0].taskId)).manifest.translation
          return { styleNote: translation.styleNote, provider: translation.selectedProvider }
        }),
      )
      .toEqual({ styleNote: '简洁自然，保留现场感', provider: 'claude' })
    await expect.poll(() => window.evaluate((key) => window.localStorage.getItem(key), NEW_TASK_PROVIDER_STORAGE_KEY)).toContain('claude')
    newTaskDialog = await openNewTaskDialog(window)
    await expect(newTaskDialog.locator('#content-url')).toHaveValue('')
    await expect(newTaskDialog.getByLabel(/翻译风格/)).toHaveValue('')
    await newTaskDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(newTaskDialog).toBeHidden()
    await window.locator('.task-row').click()
    await expect(window.locator('.task-source')).toContainText('https://vimeo.com/100000010')
    await expect(window.getByRole('button', { name: '任务队列', exact: true })).toBeVisible()
    const workbenchHeaderBox = await window.locator('.wb-header').boundingBox()
    const startTaskBox = await window.getByRole('button', { name: '开始处理' }).boundingBox()
    expect(workbenchHeaderBox).not.toBeNull()
    expect(startTaskBox).not.toBeNull()
    await expect(window.getByRole('button', { name: /追加视频总结/u })).toBeDisabled()
    await expect(window.getByRole('button', { name: '查看审计术语表', exact: true })).toHaveCount(0)
    expect(await window.evaluate(() => {
      const appRegion = (selector: string): string => getComputedStyle(document.querySelector(selector)!).getPropertyValue('-webkit-app-region')
      return {
        workbenchPanel: appRegion('.main-panel.is-workbench'),
        workbenchContent: appRegion('.workbench-view'),
        workbenchHeader: appRegion('.wb-header'),
        backButton: appRegion('.back-link'),
        titleRow: appRegion('.wb-title-row')
      }
    })).toEqual({
      workbenchPanel: 'drag',
      workbenchContent: 'no-drag',
      workbenchHeader: 'drag',
      backButton: 'no-drag',
      titleRow: 'no-drag'
    })
    await expect(window.locator('.recovery-banner')).toHaveCount(0)
    await expect(window.getByRole('button', { name: '确认恢复并继续' })).toHaveCount(0)
    await expect(window.locator('.pipeline-collapse')).toHaveAttribute('open', '')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1360, 680))
    await expect.poll(() => window.locator('.editor-shell').evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeGreaterThanOrEqual(430)
    await expect.poll(() => window.locator('.main-panel').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1360, 860))
    await window.getByRole('tab', { name: '样式' }).click()
    await window.locator('.preset-chip[data-size="large"]').click()
    await expect.poll(() => window.evaluate(async () => {
      const queue = await window.etch.queuePage()
      const detail = await window.etch.taskDetail(queue.items[0].taskId)
      return {
        taskPreset: detail.manifest.render.subtitlePreset,
        newTaskDefault: (await window.etch.getSettings()).subtitlePreset
      }
    })).toEqual({ taskPreset: 'large', newTaskDefault: 'standard' })
    const presetRevision = await window.evaluate(async () => {
      const queue = await window.etch.queuePage()
      return (await window.etch.taskDetail(queue.items[0].taskId)).manifest.revision
    })
    await window.locator('.preset-chip[data-size="large"]').click()
    await expect.poll(() => window.evaluate(async () => {
      const queue = await window.etch.queuePage()
      return (await window.etch.taskDetail(queue.items[0].taskId)).manifest.revision
    })).toBe(presetRevision)
    await openSettingsFromApplicationMenu(application, window)
    await expect(window.getByText('翻译风格', { exact: true })).toHaveCount(0)
    await expect(window.getByRole('switch', { name: '允许队列领取新阶段' })).toBeVisible()
    await expect(window.getByRole('switch', { name: '处理时阻止休眠' })).toBeVisible()
    await expect(window.getByRole('switch', { name: '成片完成' })).toBeVisible()
    await expect(window.getByRole('switch', { name: '任务失败' })).toBeVisible()
    await expect(window.getByRole('switch', { name: '审计 checkpoint 待确认' })).toBeVisible()
    await window.getByRole('button', { name: '2', exact: true }).click()
    await window.getByRole('switch', { name: '允许队列领取新阶段' }).click()
    await window.getByRole('switch', { name: '处理时阻止休眠' }).click()
    await window.getByRole('switch', { name: '成片完成' }).click()
    await window.getByRole('switch', { name: '任务失败' }).click()
    await window.getByRole('switch', { name: '审计 checkpoint 待确认' }).click()
    await window.locator('#settings-default-provider').selectOption('qoder')
    await window.locator('.preset-card[data-size="compact"]').click()
    await window.getByRole('button', { name: '保存设置' }).evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await expect
      .poll(() =>
        window.evaluate(() =>
          window.etch.getSettings().then((settings) => ({
            stageConcurrency: settings.stageConcurrency,
            queuePaused: settings.queuePaused,
            preventSleep: settings.preventSleep,
            completion: settings.notifications.completion,
            failure: settings.notifications.failure,
            checkpoint: settings.notifications.checkpoint,
            subtitlePreset: settings.subtitlePreset,
            defaultProvider: settings.defaultProvider,
          })),
        ),
      )
      .toEqual({ stageConcurrency: 2, queuePaused: false, preventSleep: false, completion: false, failure: false, checkpoint: false, subtitlePreset: 'compact', defaultProvider: 'qoder' })
    await window.locator('nav .nav-item').filter({ hasText: '任务队列' }).click()
    newTaskDialog = await openNewTaskDialog(window)
    await expect(newTaskDialog.locator('#provider')).toHaveValue('claude')
    await newTaskDialog.getByRole('button', { name: '取消', exact: true }).click()
    await openSettingsFromApplicationMenu(application, window)
    await window.locator('#settings-default-provider').selectOption('codex')
    await window.getByRole('button', { name: '保存设置' }).click()
    await window.locator('nav .nav-item').filter({ hasText: '任务队列' }).click()
    newTaskDialog = await openNewTaskDialog(window)
    // 上一次真的建过任务的 Provider 优先于设置里的默认值，所以这里仍然是 claude。
    await expect(newTaskDialog.locator('#provider')).toHaveValue('claude')
    await newTaskDialog.getByRole('button', { name: '取消', exact: true }).click()
    // 清掉这份记忆之后，新任务才回落到设置里的默认 Provider。
    await window.evaluate((key) => window.localStorage.removeItem(key), NEW_TASK_PROVIDER_STORAGE_KEY)
    newTaskDialog = await openNewTaskDialog(window)
    await expect(newTaskDialog.locator('#provider')).toHaveValue('codex')
    await newTaskDialog.getByRole('button', { name: '取消', exact: true }).click()
    await window.locator('.task-row').click()
    await window.getByRole('button', { name: '开始处理' }).click()
    await expect.poll(() => window.evaluate(() => window.etch.recoveryState().then((state) => state.hold))).toBe(false)
    await expect(window.getByText('请先点击上方“确认恢复并继续”，再开始处理。')).toHaveCount(0)
    await window.getByRole('button', { name: '统一术语表', exact: true }).click()
    await expect(window.locator('.glossary-catalog').getByRole('heading', { name: '全部术语' })).toBeVisible()
    await expect(window.getByRole('button', { name: '确认恢复并继续' })).toHaveCount(0)
    await expect(window.getByRole('button', { name: '返回字幕校对' })).toHaveCount(0)
    await expect(window.getByRole('tab')).toHaveCount(0)
    await window.locator('nav .nav-item').filter({ hasText: '任务队列' }).click()
    await window.locator('.task-row').click()
    await window.getByRole('tab', { name: '任务信息' }).click()
    await expect(window.locator('.task-info-panel').getByRole('button', { name: '删除任务及全部产物', exact: true })).toHaveCount(0)
    await window.getByRole('button', { name: '任务队列', exact: true }).click()
    await window.evaluate(async () => {
      const settings = await window.etch.getSettings()
      await window.etch.updateSettings({ ...settings, queuePaused: true })
    })
    await addUrlTask(window, 'https://vimeo.com/100000011')
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(2)
    await window.locator('.task-row').filter({ hasText: 'https://vimeo.com/100000011' }).click({ button: 'right' })
    await window.getByRole('menuitem', { name: '删除任务及全部产物', exact: true }).click()
    const deleteDialog = window.locator('.task-delete-dialog')
    await expect(deleteDialog.getByRole('button', { name: '取消', exact: true })).toBeFocused()
    await deleteDialog.getByRole('button', { name: '删除任务及全部产物', exact: true }).click()
    await expect(window.getByRole('heading', { name: '任务队列' })).toBeVisible()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('starts a queued task from its card and lets the workbench stop and continue the active stage', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-stop-resume-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const fakeYtDlp = join(userData, 'fake-yt-dlp')
  await mkdir(workspaceRoot)
  await writeFile(fakeYtDlp, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "2026.07.27"; exit 0; fi',
    'sleep 60',
  ].join('\n'), 'utf8')
  await chmod(fakeYtDlp, 0o755)
  await writeHermeticSettings(userData, {
    ...defaultSettings(userData),
    workspaceRoot,
    queuePaused: true,
    toolOverrides: { 'yt-dlp': fakeYtDlp },
  })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await window.evaluate(() => window.etch.createUrls(['https://vimeo.com/100000007'], 'codex'))
    const taskId = await window.evaluate(() => window.etch.queuePage().then((page) => page.items[0].taskId))
    await expect.poll(() => window.evaluate((id) =>
      window.etch.taskDetail(id).then((detail) => detail.manifest.pipeline.stages.source.status), taskId
    )).toBe('ready')
    const queueStart = window.getByRole('button', { name: '开始处理：https://vimeo.com/100000007', exact: true })
    await expect(queueStart).toBeEnabled()
    await queueStart.click()
    await expect(window.getByRole('heading', { name: '任务队列', exact: true })).toBeVisible()
    await expect(window.getByRole('alert')).toContainText('队列已暂停，解除暂停后才能开始新阶段')
    await expect.poll(() => window.evaluate((id) =>
      window.etch.taskDetail(id).then((detail) => detail.manifest.pipeline.stages.source.status), taskId
    )).toBe('ready')
    await window.evaluate(async () => {
      const settings = await window.etch.getSettings()
      await window.etch.updateSettings({ ...settings, queuePaused: false })
    })
    await expect.poll(async () => {
      const page = await window.evaluate(() => window.etch.queuePage())
      if (!page.items[0]) return 'missing'
      return window.evaluate((taskId) => window.etch.taskDetail(taskId).then((detail) => detail.manifest.pipeline.stages.source.status), page.items[0].taskId)
    }).toBe('running')

    await window.locator('.task-row').click()
    const stopButton = window.getByRole('button', { name: '停止处理', exact: true })
    await expect(stopButton).toBeVisible()
    const stopButtonBox = await stopButton.boundingBox()
    const stopIconBox = await stopButton.locator('svg').boundingBox()
    expect(stopButtonBox?.height).toBeLessThanOrEqual(36)
    expect(stopIconBox?.width).toBeLessThanOrEqual(13)
    expect(stopIconBox?.height).toBeLessThanOrEqual(13)
    await stopButton.click()
    await expect(window.getByRole('button', { name: '继续处理', exact: true })).toBeVisible()
    await expect.poll(() => window.evaluate(async () => {
      const page = await window.etch.queuePage()
      const detail = await window.etch.taskDetail(page.items[0].taskId)
      return {
        paused: detail.manifest.runtime.userPaused,
        stage: detail.manifest.pipeline.stages.source.status,
      }
    })).toEqual({ paused: true, stage: 'paused' })

    await window.getByRole('button', { name: '继续处理', exact: true }).click()
    await expect(window.getByRole('button', { name: '停止处理', exact: true })).toBeVisible()
    await expect.poll(() => window.evaluate(async () => {
      const page = await window.etch.queuePage()
      const detail = await window.etch.taskDetail(page.items[0].taskId)
      return {
        paused: detail.manifest.runtime.userPaused,
        stage: detail.manifest.pipeline.stages.source.status,
        attempt: detail.manifest.pipeline.stages.source.attempt,
      }
    })).toEqual({ paused: false, stage: 'running', attempt: 2 })
    await window.getByRole('button', { name: '停止处理', exact: true }).click()
    await expect(window.getByRole('button', { name: '继续处理', exact: true })).toBeVisible()
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('starts a paused backlog when queue auto-run is enabled', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-unpause-queue-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const fakeYtDlp = join(userData, 'fake-yt-dlp')
  await mkdir(workspaceRoot)
  await writeFile(fakeYtDlp, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "2026.07.28"; exit 0; fi',
    'sleep 60',
  ].join('\n'), 'utf8')
  await chmod(fakeYtDlp, 0o755)
  await writeHermeticSettings(userData, {
    ...defaultSettings(userData),
    workspaceRoot,
    stageConcurrency: 3,
    queuePaused: true,
    toolOverrides: { 'yt-dlp': fakeYtDlp },
  })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await window.evaluate(() => window.etch.createUrls(['https://vimeo.com/100000008'], 'codex'))
    const taskId = await window.evaluate(() => window.etch.queuePage().then((page) => page.items[0].taskId))
    await expect.poll(() => window.evaluate((id) =>
      window.etch.taskDetail(id).then((detail) => detail.manifest.pipeline.stages.source.status), taskId
    )).toBe('ready')

    await window.evaluate(async () => {
      const settings = await window.etch.getSettings()
      await window.etch.updateSettings({ ...settings, queuePaused: false })
    })
    await expect.poll(() => window.evaluate((id) =>
      window.etch.taskDetail(id).then((detail) => detail.manifest.pipeline.stages.source.status), taskId
    )).toBe('running')

    await window.evaluate((id) => window.etch.stopTask(id), taskId)
    await expect.poll(() => window.evaluate((id) =>
      window.etch.taskDetail(id).then((detail) => ({
        paused: detail.manifest.runtime.userPaused,
        stage: detail.manifest.pipeline.stages.source.status,
      })), taskId
    )).toEqual({ paused: true, stage: 'paused' })
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('offers Finder, record-only, and full-artifact actions from a task row context menu', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-context-menu-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot)
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  let application = await launchHermeticEtch(userData)
  try {
    let window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(0)
    await addUrlTask(window, 'https://vimeo.com/100000012')
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    const recordRow = window.locator('.task-row').filter({ hasText: 'https://vimeo.com/100000012' })
    const recordTask = await window.evaluate(async () => {
      const page = await window.etch.queuePage()
      return window.etch.taskDetail(page.items[0].taskId)
    })

    await recordRow.click({ button: 'right' })
    await expect(window.getByRole('menu')).toBeVisible()
    await expect(window.getByRole('menuitem', { name: '在访达中显示', exact: true })).toBeVisible()
    await expect(window.getByRole('menuitem', { name: '仅删除任务记录', exact: true })).toBeVisible()
    await expect(window.getByRole('menuitem', { name: '删除任务及全部产物', exact: true })).toBeVisible()
    await expect(window.getByRole('heading', { name: '任务队列' })).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(window.getByRole('menu')).toBeHidden()

    await recordRow.click({ button: 'right' })
    await window.getByRole('menuitem', { name: '仅删除任务记录', exact: true }).click()
    await expect(window.locator('.task-delete-dialog')).toContainText(recordTask.taskDirectory)
    await expect(window.locator('.task-delete-dialog')).toContainText('永久从 Etch 的队列和历史记录中隐藏')
    await window.locator('.task-delete-dialog').getByRole('button', { name: '仅删除任务记录', exact: true }).click()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(0)
    expect((await stat(recordTask.taskDirectory)).isDirectory()).toBe(true)
    const hidden = JSON.parse(await readFile(join(userData, 'hidden-tasks.json'), 'utf8')) as { taskIds: string[] }
    expect(hidden.taskIds).toContain(recordTask.manifest.taskId)

    await quitApplication(application)
    application = await launchHermeticEtch(userData)
    window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(0)

    await addUrlTask(window, 'https://vimeo.com/100000013')
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    const fullTask = await window.evaluate(async () => {
      const page = await window.etch.queuePage()
      return window.etch.taskDetail(page.items[0].taskId)
    })
    const fullRow = window.locator('.task-row').filter({ hasText: 'https://vimeo.com/100000013' })
    await fullRow.click({ button: 'right' })
    await window.getByRole('menuitem', { name: '删除任务及全部产物', exact: true }).click()
    await expect(window.locator('.task-delete-dialog')).toContainText(fullTask.taskDirectory)
    await window.locator('.task-delete-dialog').getByRole('button', { name: '删除任务及全部产物', exact: true }).click()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(0)
    await expect(stat(fullTask.taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(userData, '.etch-hermetic-trash'))).toHaveLength(1)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('keeps the queue scroll position and hands focus to a neighbour card after a delete', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-delete-scroll-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot)
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  for (let index = 0; index < 18; index += 1) {
    const taskDirectory = join(workspaceRoot, `scroll--${index}`)
    await mkdir(taskDirectory)
    const manifest = createTaskManifest({ kind: 'url', url: `https://example.com/scroll-video-${index}` }, `Scroll Video ${index}`, 'codex')
    await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(18)
    await expect(window.locator('.task-row')).toHaveCount(18)
    const panel = window.locator('.main-panel')
    await window.locator('.task-row').nth(14).click({ button: 'right' })
    const scrolled = await panel.evaluate((element) => element.scrollTop)
    expect(scrolled).toBeGreaterThan(0)

    await window.getByRole('menuitem', { name: '仅删除任务记录', exact: true }).click()
    await window.locator('.task-delete-dialog').getByRole('button', { name: '仅删除任务记录', exact: true }).click()
    await expect(window.locator('.task-row')).toHaveCount(17)
    await expect(window.locator('.task-row').nth(14).locator('.task-row-open')).toBeFocused()
    expect(await panel.evaluate((element) => element.scrollTop)).toBe(scrolled)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('merges every completed audit into one deduplicated glossary and supports deletion', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-glossary-catalog-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot)
  // 下面要比对具体的 danger 色值，而 system 主题在 Playwright 里会解析成浅色，所以把主题钉成 dark。
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true, theme: 'dark' })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  for (let index = 0; index < 52; index += 1) {
    const taskDirectory = join(workspaceRoot, `catalog--${index}`)
    await mkdir(taskDirectory)
    const source = index >= 50 ? (index === 50 ? 'agent' : 'Agent') : `Term ${index}`
    const target = index >= 50 ? '智能体' : `译法 ${index}`
    const manifest = createTaskManifest({ kind: 'url', url: `https://example.com/catalog-video-${index}` }, `Catalog Video ${index}`, 'codex')
    for (const stage of Object.values(manifest.pipeline.stages)) stage.status = 'completed'
    const audit = `${JSON.stringify({ glossary: [{ source, target, cueIds: [1] }], patches: [] })}\n`
    const english = `1\n00:00:00,000 --> 00:00:02,000\n${source} is ready.\n`
    await writeFile(join(taskDirectory, 'audit.json'), audit)
    await writeFile(join(taskDirectory, 'english.clean.srt'), english)
    manifest.artifacts.audit = {
      relativePath: 'audit.json',
      sha256: await sha256File(join(taskDirectory, 'audit.json')),
      size: Buffer.byteLength(audit),
      valid: true,
      producer: 'e2e-fixture',
      inputFingerprint: '1'.repeat(64),
    }
    manifest.artifacts.englishClean = {
      relativePath: 'english.clean.srt',
      sha256: await sha256File(join(taskDirectory, 'english.clean.srt')),
      size: Buffer.byteLength(english),
      valid: true,
      producer: 'e2e-fixture',
      inputFingerprint: '2'.repeat(64),
    }
    await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(52)
    await window.getByRole('button', { name: '统一术语表', exact: true }).click()
    await expect(window.locator('.glossary-catalog').getByRole('heading', { name: '全部术语' })).toBeVisible()
    await expect(window.locator('.global-glossary-row')).toHaveCount(51)
    await expect(window.getByText('1–50 / 51', { exact: true })).toBeVisible()
    await window.getByRole('button', { name: '下一页' }).click()
    await expect(window.locator('.global-glossary-row')).toHaveCount(2)
    await expect(window.getByText('51–51 / 51', { exact: true })).toBeVisible()

    const search = window.getByPlaceholder('搜索原文术语或统一写法')
    await search.fill('agent')
    const agentRow = window.locator('.global-glossary-row').filter({ hasText: '智能体' })
    await expect(agentRow).toHaveCount(1)
    await expect(agentRow).toContainText('来自 2 个视频')
    const deleteButton = agentRow.getByRole('button', { name: /删除术语/u })
    await expect(deleteButton).toHaveCSS('color', 'rgb(228, 154, 154)')
    await expect(deleteButton).toHaveCSS('background-color', 'rgba(113, 45, 51, 0.18)')
    await deleteButton.click()
    await expect(agentRow.getByRole('button', { name: '确认删除', exact: true })).toBeVisible()
    await agentRow.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(window.getByText('没有匹配的术语。', { exact: true })).toBeVisible()
    await expect.poll(() => window.evaluate(() => window.etch.glossaryCatalogPage('agent').then((page) => page.total))).toBe(0)

    await search.fill('')
    await expect(window.getByText('1–50 / 50', { exact: true })).toBeVisible()
    const persisted = JSON.parse(await readFile(join(userData, 'glossary.json'), 'utf8')) as { entries: unknown[]; deletedKeys: string[] }
    expect(persisted.entries).toHaveLength(50)
    expect(persisted.deletedKeys).toHaveLength(1)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('renders manifest-backed queue metadata and pipeline diagnostics without invented data', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-renderer-fields-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const taskDirectory = join(workspaceRoot, 'renderer-fields--fixture')
  await mkdir(taskDirectory, { recursive: true })
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/renderer-fields' }, 'Renderer Manifest Fixture', 'codex')
  for (const id of ['source', 'inspect', 'english', 'cues'] as const) manifest.pipeline.stages[id].status = 'completed'
  manifest.pipeline.stages.source.attempt = 2
  manifest.pipeline.stages.translate.status = 'ready'
  manifest.pipeline.stages.translate.attempt = 2
  manifest.runtime.currentMessage = '等待翻译'
  manifest.runtime.durationSeconds = 125
  manifest.runtime.width = 1920
  manifest.runtime.height = 1080
  manifest.runtime.subtitleKind = 'automatic'
  manifest.translation.batches = [
    { id: 'batch-1', startCue: 1, endCue: 40, inputFingerprint: '1'.repeat(64), status: 'verified' },
    { id: 'batch-2', startCue: 41, endCue: 80, inputFingerprint: '2'.repeat(64), status: 'running' },
  ]
  const thumbnailPath = join(taskDirectory, 'thumbnail.png')
  await writeFile(thumbnailPath, thumbnailPng)
  manifest.artifacts.thumbnail = {
    relativePath: 'thumbnail.png',
    sha256: await sha256File(thumbnailPath),
    size: thumbnailPng.length,
    valid: true,
    producer: 'e2e-fixture',
    inputFingerprint: '3'.repeat(64),
  }
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    const row = window.locator('.task-row')
    await expect(row).toContainText('2:05')
    await expect(row).toContainText('URL')
    await expect(row).toContainText('Codex')
    await expect(row).toContainText('自动字幕')
    await expect(row).toContainText('4 / 10 阶段')
    await expect(row.locator('.task-card-message')).toHaveText('等待翻译')
    await expect(row.locator('.task-source-preview')).toContainText('https://example.com/renderer-fields')
    await expect(row.locator('.task-card-footer')).toContainText('更新于')
    const thumbnail = row.locator('.thumb img')
    await expect(thumbnail).toHaveAttribute('src', /^data:image\/png;base64,/)
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    const coverBox = await row.locator('.thumb').boundingBox()
    expect(coverBox).not.toBeNull()
    expect(Math.abs((coverBox?.width ?? 0) / (coverBox?.height ?? 1) - 16 / 9)).toBeLessThan(0.03)
    await expect(window.locator('.queue-section .pipeline')).toHaveCount(0)

    manifest.revision += 1
    manifest.updatedAt = new Date().toISOString()
    manifest.runtime.currentMessage = '正在翻译第 2 / 2 批'
    manifest.pipeline.stages.translate.status = 'running'
    manifest.pipeline.stages.translate.attempt = 3
    manifest.pipeline.stages.translate.progress = 0.42
    await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await row.click()

    await expect(window.locator('.rail-node')).toHaveCount(10)
    const translateNode = window.locator('.rail-node').nth(4)
    await expect(translateNode).toHaveAttribute('data-status', 'running')
    await expect(translateNode.locator('.rail-progress i')).toHaveAttribute('style', /width:\s*42%/)
    await expect(translateNode.locator('.rail-attempt')).toHaveText('×3')
    await expect(window.locator('.pipeline-pools .pool-tag')).toHaveCount(5)
    await expect(window.locator('.pool-tag').filter({ hasText: 'agent' })).toContainText('运行中')
    await expect(window.getByRole('progressbar', { name: '流水线总体进度' })).toHaveAttribute('aria-valuenow', '44')
    await window.getByRole('tab', { name: '任务信息' }).click()
    await expect(window.getByText('1 / 2 已验证', { exact: true })).toBeVisible()
    await expect(window.locator('.inspector-grid div').filter({ hasText: 'Token' }).locator('dd')).toHaveText('—')
    await expect(window.getByText('媒体尚未准备', { exact: true })).toBeVisible()
    await window.getByRole('tab', { name: '校对' }).click()
    await expect(window.getByText('字幕尚未生成', { exact: true })).toBeVisible()
    await window.locator('.pipeline-collapse > summary').click()
    await expect(window.locator('.rail-node').first()).toBeHidden()
    await window.locator('.pipeline-collapse > summary').click()
    await expect(window.locator('.rail-node')).toHaveCount(10)
    await window.getByRole('button', { name: '任务队列', exact: true }).click()
    await expect(window.getByRole('heading', { name: '任务队列' })).toBeVisible()
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('reuses validated media as the queue cover for a legacy X document', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-document-cover-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const taskDirectory = join(workspaceRoot, 'document-cover--fixture')
  await mkdir(taskDirectory, { recursive: true })
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  const manifest = createTaskManifest(
    { kind: 'url', url: 'https://x.com/author/status/123' },
    'Document Cover Fixture',
    'codex',
    '',
    'standard',
    false,
    'document',
  )
  manifest.document.resolvedSource = 'x-article'
  manifest.pipeline.stages.source.status = 'completed'
  manifest.pipeline.stages.inspect.status = 'completed'
  const coverPath = join(taskDirectory, 'media-001.png')
  await writeFile(coverPath, thumbnailPng)
  manifest.artifacts['documentMedia:media-001'] = {
    relativePath: 'media-001.png',
    sha256: await sha256File(coverPath),
    size: thumbnailPng.length,
    valid: true,
    producer: 'etch-document-media-v1',
    inputFingerprint: '4'.repeat(64),
  }
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    const cover = window.locator('.task-row .thumb img')
    await expect(cover).toHaveAttribute('src', /^data:image\/png;base64,/)
    await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expect(window.locator('.task-row .thumb-placeholder')).toHaveCount(0)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('renders a blocking document budget failure as an error instead of a warning', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-document-budget-error-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const taskDirectory = join(workspaceRoot, 'document-budget-error--fixture')
  await mkdir(taskDirectory, { recursive: true })
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  const manifest = createTaskManifest(
    { kind: 'url', url: 'https://example.com/oversized' },
    'Oversized Document Fixture',
    'codex',
    '',
    'standard',
    false,
    'document',
  )
  const failure = '网页正文边界识别失败：识别到 427 个可翻译区块、694251 个字符，需要 64 个翻译批次，超过安全上限 12'
  manifest.document.resolvedSource = 'web'
  manifest.document.warnings = ['未检测到 article/main，已从页面主体提取；请检查正文边界']
  manifest.pipeline.stages.source.status = 'completed'
  manifest.pipeline.stages.inspect.status = 'completed'
  manifest.pipeline.stages.translate.status = 'failed'
  manifest.pipeline.stages.translate.attempt = 1
  manifest.pipeline.stages.translate.errorCode = failure
  manifest.runtime.currentMessage = '网页正文边界识别失败'
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    await window.locator('.task-row').click()
    await expect(window.locator('.pc-mini .error')).toHaveText('处理失败')
    await expect(window.locator('.document-warning')).toHaveCount(0)
    const failurePanel = window.locator('.document-failure')
    await expect(failurePanel).toBeVisible()
    await expect(failurePanel.getByText('文档翻译失败', { exact: true })).toBeVisible()
    await expect(failurePanel).toContainText(failure)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('publishes verified Markdown as offline HTML through the real BrowserWindow verifier', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-document-html-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const taskDirectory = join(workspaceRoot, 'document-html--00000000')
  await mkdir(taskDirectory, { recursive: true })
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  const markdown = [
    '# 离线网页发布验收',
    '',
    '这是一段用于真实浏览器验收的正文，包含 **中文排版** 与 `inline code`。',
    '',
    '## 核心结论',
    '',
    '| 项目 | 结果 |',
    '| --- | --- |',
    '| 桌面视口 | 通过 |',
    '| 移动视口 | 通过 |',
    '',
    '> HTML 必须完全离线，不加载远程脚本或字体。',
    '',
  ].join('\n')
  const sourcePath = join(taskDirectory, 'source.md')
  await writeFile(sourcePath, markdown, 'utf8')
  const manifest = createTaskManifest(
    { kind: 'url', url: 'https://example.com/document-html' },
    '离线网页发布验收',
    undefined,
    '',
    'standard',
    false,
    'document',
    '',
    'convert',
  )
  manifest.document.resolvedAction = 'convert'
  manifest.pipeline.stages.verify.status = 'completed'
  manifest.runtime.completedAt = new Date().toISOString()
  manifest.artifacts.sourceMarkdown = {
    relativePath: 'source.md',
    sha256: await sha256File(sourcePath),
    size: Buffer.byteLength(markdown),
    valid: true,
    producer: 'e2e-fixture',
    inputFingerprint: 'd'.repeat(64),
  }
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    const taskId = manifest.taskId
    const checkpoint = await window.evaluate(async (id) => {
      const detail = await window.etch.taskDetail(id)
      return window.etch.startDocumentHtml(id, detail.manifest.revision, 'preview')
    }, taskId)
    expect(checkpoint.manifest.document.htmlPublication).toMatchObject({ status: 'checkpoint', phase: 'preview' })
    const preview = await window.evaluate((id) => window.etch.documentHtmlPage(id), taskId)
    expect(preview.previewHtml).toContain('四方向试衣间')

    const completed = await window.evaluate(
      ({ id, revision }) => window.etch.resolveDocumentHtmlStyle(id, revision, 'B'),
      { id: taskId, revision: checkpoint.manifest.revision },
    )
    expect(completed.manifest.document.htmlPublication).toMatchObject({ status: 'completed', phase: 'done', selectedDirection: 'B' })
    const page = await window.evaluate((id) => window.etch.documentHtmlPage(id), taskId)
    expect(page.verification).toEqual({ staticValid: true, browserValid: true, issues: [] })

    const htmlArtifact = completed.manifest.artifacts.documentHtml
    const desktop = completed.manifest.artifacts['documentHtmlScreenshot:desktop']
    const mobile = completed.manifest.artifacts['documentHtmlScreenshot:mobile']
    const html = await readFile(join(taskDirectory, htmlArtifact.relativePath), 'utf8')
    expect(html).toContain('Content-Security-Policy')
    expect(html).not.toMatch(/<script\b|fonts\.googleapis\.com|cdn\.tailwindcss\.com/iu)
    expect((await stat(join(taskDirectory, desktop.relativePath))).size).toBeGreaterThan(1000)
    expect((await stat(join(taskDirectory, mobile.relativePath))).size).toBeGreaterThan(1000)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('renders and resolves an audit checkpoint once from the task workbench', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-audit-checkpoint-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const taskDirectory = join(workspaceRoot, 'audit-checkpoint--fixture')
  await mkdir(taskDirectory, { recursive: true })
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(taskDirectory, 'english.clean.srt'),
    '1\n00:00:00,000 --> 00:00:03,000\nAttention head.\n\n2\n00:00:03,000 --> 00:00:06,000\nContext window.\n',
    'utf8',
  )
  await writeFile(join(taskDirectory, 'zh_cues.tsv'), '1\t注意力头。\n2\t上下文视窗。\n', 'utf8')
  await writeFile(
    join(taskDirectory, 'audit.json'),
    `${JSON.stringify({
      glossary: [
        { source: 'attention head', target: '注意力头', cueIds: [1] },
        { source: 'context window', target: '上下文窗口', cueIds: [2] },
      ],
      patches: [
        { cueId: 1, before: '注意力头。', after: '注意头。', reason: '结合画面确认术语', confidence: 'ambiguous' },
        { cueId: 2, before: '上下文视窗。', after: '上下文窗口。', reason: '统一技术术语', confidence: 'ambiguous' },
      ],
    }, null, 2)}\n`,
    'utf8',
  )
  const manifest = createTaskManifest({ kind: 'local', sourcePath: '/Users/test/Videos/audit-checkpoint.mp4' }, 'Audit Checkpoint Fixture', 'codex')
  for (const id of ['source', 'inspect', 'english', 'cues', 'translate'] as const) manifest.pipeline.stages[id].status = 'completed'
  manifest.pipeline.stages.audit.status = 'checkpoint'
  manifest.pipeline.stages.audit.checkpointId = 'audit-ambiguity'
  manifest.translation.auditCheckpoint = {
    ambiguities: [
      { cueId: 1, en: 'Attention head.', before: '注意力头。', recommended: '注意头。', reason: '结合画面确认术语' },
      { cueId: 2, en: 'Context window.', before: '上下文视窗。', recommended: '上下文窗口。', reason: '统一技术术语' },
    ],
  }
  const auditPath = join(taskDirectory, 'audit.json')
  manifest.artifacts.audit = {
    relativePath: 'audit.json',
    sha256: await sha256File(auditPath),
    size: (await stat(auditPath)).size,
    valid: true,
    producer: 'e2e-fixture',
    inputFingerprint: 'a'.repeat(64),
  }
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    await window.locator('.task-row').click()
    const checkpoint = window.locator('.audit-checkpoint')
    await expect(checkpoint).toContainText('术语审计发现 2 处歧义')
    expect(await checkpoint.locator(':scope > *').evaluateAll((elements) => elements.slice(0, 3).map((element) => element.className)))
      .toEqual(['head', 'audit-actions', 'audit-comparison-head'])
    await expect(checkpoint.locator('.audit-comparison-head')).toHaveCount(1)
    await expect(checkpoint.locator('.audit-comparison-head > span')).toHaveText(['当前译法', '建议统一为'])
    await expect(checkpoint.locator('.audit-cue-seek')).toHaveCount(0)
    await expect(checkpoint.locator('.audit-cue-time-empty')).toHaveCount(0)
    await expect(window.getByRole('button', { name: '等待审计裁决' })).toBeDisabled()
    await expect(checkpoint.locator('.audit-adopt-button')).toHaveCount(2)
    const cueOneAdopt = checkpoint.getByRole('button', { name: 'Cue 1 采用建议译法' })
    await expect(cueOneAdopt).toHaveAttribute('aria-pressed', 'false')
    await expect(checkpoint.getByLabel('Cue 1 建议统一为')).toHaveValue('注意头。')
    await checkpoint.getByRole('button', { name: '全部采用建议译法' }).click()
    await expect(checkpoint).toContainText('已采用 2 / 2 条建议')
    await expect(checkpoint).toBeVisible()
    await checkpoint.getByRole('button', { name: '全部保留当前译法' }).click()
    await expect(checkpoint).toContainText('已采用 0 / 2 条建议')
    await cueOneAdopt.click()
    await expect(cueOneAdopt).toHaveAttribute('aria-pressed', 'true')
    await expect(checkpoint).toContainText('已采用 1 / 2 条建议')
    await cueOneAdopt.click()
    await expect(checkpoint).toContainText('已采用 0 / 2 条建议')
    await checkpoint.getByLabel('Cue 1 建议统一为').fill('注意力头\n部。')
    await expect(checkpoint).toContainText('建议译法不能包含 Tab 或换行')
    await expect(window.getByRole('button', { name: '确认裁决并继续' })).toBeDisabled()
    await checkpoint.getByLabel('Cue 1 建议统一为').fill('')
    await expect(checkpoint).toContainText('建议译法不能为空')
    await expect(window.getByRole('button', { name: '确认裁决并继续' })).toBeDisabled()
    await checkpoint.getByLabel('Cue 1 建议统一为').fill('注意力头部。')
    await expect(checkpoint).toContainText('已采用 1 / 2 条建议')
    await expect(cueOneAdopt).toHaveAttribute('aria-pressed', 'true')
    await window.getByRole('button', { name: '确认裁决并继续' }).evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await expect(checkpoint).toBeHidden()
    await expect
      .poll(() =>
        window.evaluate(() =>
          window.etch.queuePage().then((page) =>
            window.etch.taskDetail(page.items[0].taskId).then((detail) => ({ checkpoint: detail.manifest.translation.auditCheckpoint, decisions: detail.manifest.translation.auditDecisions })),
          ),
        ),
      )
      .toEqual({
        checkpoint: undefined,
        decisions: [
          expect.objectContaining({ cueId: 1, translation: '注意力头部。' }),
          expect.objectContaining({ cueId: 2, translation: '上下文视窗。' }),
        ],
      })
    await expect(window.locator('.task-action-error')).toHaveCount(0)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('shows honest English source-audit timecodes and seeks the task video', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-source-audit-checkpoint-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const taskDirectory = join(workspaceRoot, 'source-audit-checkpoint--fixture')
  await mkdir(taskDirectory, { recursive: true })
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(join(taskDirectory, 'source.mp4'), Buffer.from([0]))
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/source-audit' }, 'English Source Audit Fixture', 'codex')
  for (const id of ['source', 'inspect', 'english'] as const) manifest.pipeline.stages[id].status = 'completed'
  manifest.pipeline.stages.cues.status = 'checkpoint'
  manifest.pipeline.stages.cues.checkpointId = 'english-source-ambiguity'
  manifest.translation.auditCheckpoint = {
    ambiguities: [
      { cueId: 1, en: 'Cloud Code.', before: 'Cloud Code.', recommended: 'Claude Code.', reason: '技术名称待核对', startMs: 3_250, endMs: 5_500 },
      { cueId: 2, en: 'Legacy cue.', before: 'Legacy cue.', recommended: 'Legacy queue.', reason: '旧任务没有保存时间码' },
    ],
  }
  const sourcePath = join(taskDirectory, 'source.mp4')
  manifest.artifacts.source = {
    relativePath: 'source.mp4',
    sha256: await sha256File(sourcePath),
    size: (await stat(sourcePath)).size,
    valid: true,
    producer: 'e2e-fixture',
    inputFingerprint: 'b'.repeat(64),
  }
  manifest.runtime.durationSeconds = 10
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    await window.locator('.task-row').click()
    const checkpoint = window.locator('.audit-checkpoint')
    await expect(checkpoint).toContainText('英文源字幕审计发现 2 处歧义')
    await expect(checkpoint.getByText('时间码 —', { exact: true })).toBeVisible()
    const seek = checkpoint.getByRole('button', { name: '定位并播放 Cue 1，0:03 至 0:05' })
    await expect(seek).toBeVisible()
    const video = window.locator('.stage-video video')
    await video.evaluate((element) => {
      Object.defineProperty(element, 'currentTime', { configurable: true, value: 0, writable: true })
      Object.defineProperty(element, 'play', { configurable: true, value: () => Promise.resolve() })
    })
    await seek.click()
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(3.25)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('holds manual-review glossary drafts until previewed and applies them to every referenced cue', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-manual-review-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const taskDirectory = join(workspaceRoot, 'manual-review--fixture')
  await mkdir(taskDirectory, { recursive: true })
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )

  const cueIds = Array.from({ length: 101 }, (_, index) => index + 1)
  const english = cueIds.map((cueId) => {
    const startMs = (cueId - 1) * 2_000
    const text = cueId === 1 || cueId === 101 ? 'World Cup agent.' : `Segment ${cueId}.`
    return `${cueId}\n${formatTimestamp(startMs)} --> ${formatTimestamp(startMs + 1_800)}\n${text}\n`
  }).join('\n')
  const chinese = cueIds.map((cueId) => `${cueId}\t${cueId === 1 || cueId === 101 ? '欢迎来到世界杯，智能体已就位。' : `普通译文 ${cueId}。`}`).join('\n') + '\n'
  const audit = `${JSON.stringify({
    glossary: [
      { source: 'World Cup', target: '世界杯', cueIds: [1, 101] },
      { source: 'agent', target: '智能体', cueIds: [1, 101] },
    ],
    patches: [],
    historicalClassifications: [],
  }, null, 2)}\n`
  await writeFile(join(taskDirectory, 'english.clean.srt'), english, 'utf8')
  await writeFile(join(taskDirectory, 'zh_cues.tsv'), chinese, 'utf8')
  await writeFile(join(taskDirectory, 'audit.json'), audit, 'utf8')

  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/manual-review' }, 'Manual Review Fixture', 'codex')
  for (const id of ['source', 'inspect', 'english', 'cues', 'translate', 'audit'] as const) manifest.pipeline.stages[id].status = 'completed'
  manifest.pipeline.stages.review.status = 'checkpoint'
  manifest.pipeline.stages.review.checkpointId = 'manual-review'
  manifest.runtime.currentMessage = '等待人工校对字幕与术语'
  const artifact = async (relativePath: string) => {
    const path = join(taskDirectory, relativePath)
    return {
      relativePath,
      sha256: await sha256File(path),
      size: (await stat(path)).size,
      valid: true,
      producer: 'e2e-fixture',
      inputFingerprint: 'b'.repeat(64),
    }
  }
  manifest.artifacts.englishClean = await artifact('english.clean.srt')
  manifest.artifacts.chineseCues = await artifact('zh_cues.tsv')
  manifest.artifacts.audit = await artifact('audit.json')
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    await window.locator('.task-row').click()

    await expect(window.getByRole('region', { name: '流水线已暂停在人工校对' })).toContainText('确认完成前不会生成 SRT 或压制成片')
    await expect(window.getByRole('button', { name: '完成校对并继续' })).toBeVisible()
    await expect(window.getByRole('tab', { name: /审计术语/ })).toHaveAttribute('aria-selected', 'true')
    await expect(window.getByLabel('术语 1 统一写法')).toHaveValue('世界杯')
    await expect(window.getByLabel('术语 2 统一写法')).toHaveValue('智能体')

    await window.getByLabel('术语 1 统一写法').fill('')
    const firstGlossaryImpact = window.locator('.glossary-row').nth(1).locator('.glossary-row-impact')
    await expect(firstGlossaryImpact).toContainText('统一写法不能为空')
    await expect(firstGlossaryImpact).toContainText('#1')
    await expect(firstGlossaryImpact).toContainText('#101')
    await expect(window.getByText('1 条统一写法尚未完成', { exact: true })).toBeVisible()
    await expect(window.locator('.glossary-manual-actions')).toContainText('#1')
    await expect(window.locator('.glossary-manual-actions')).toContainText('#101')
    await window.getByRole('button', { name: '补全 1 条统一写法' }).click()
    await expect(window.getByLabel('术语 1 统一写法')).toBeFocused()
    await expect(window.getByText('“World Cup”缺少统一写法；如需保留英文，请填入“World Cup”', { exact: true })).toBeVisible()
    await window.getByRole('button', { name: '保留英文 World Cup' }).click()
    await expect(window.getByLabel('术语 1 统一写法')).toHaveValue('World Cup')
    await window.getByRole('button', { name: '放弃草稿' }).click()

    await window.getByLabel('术语 1 统一写法').fill('世界足球赛')
    await window.getByLabel('术语 2 统一写法').fill('代理')
    await expect(firstGlossaryImpact).toContainText('待核对')
    await expect(firstGlossaryImpact).toContainText('#1')
    await expect(firstGlossaryImpact).toContainText('#101')
    await expect(window.getByText('草稿已保存在本机，尚未应用到译文', { exact: true })).toBeVisible()
    await window.locator('.sidebar').getByRole('button', { name: /任务队列/ }).click()
    await expect(window.getByText('术语草稿尚未处理，请先预览并应用，或重置修改后再离开。', { exact: true })).toBeVisible()
    await expect(window.getByRole('heading', { name: 'Manual Review Fixture' })).toBeVisible()
    await window.getByRole('button', { name: '放弃草稿' }).click()
    await expect(window.getByText('术语草稿尚未处理，请先预览并应用，或重置修改后再离开。', { exact: true })).toHaveCount(0)
    await window.getByLabel('术语 1 统一写法').fill('世界足球赛')
    await window.getByLabel('术语 2 统一写法').fill('代理')
    await window.waitForTimeout(900)
    const beforePreview = await window.evaluate(async (taskId) => {
      const detail = await window.etch.taskDetail(taskId)
      const review = await window.etch.reviewPage(taskId, 0, 1)
      return {
        revision: detail.manifest.revision,
        glossaryTargets: review.glossary.map((entry) => entry.target),
        manualEdits: detail.manifest.translation.manualEdits,
      }
    }, manifest.taskId)
    expect(beforePreview).toEqual({ revision: 0, glossaryTargets: ['世界杯', '智能体'], manualEdits: [] })

    await window.getByRole('button', { name: '预览 2 条写法影响' }).click()
    const preview = window.getByRole('region', { name: '术语同步预览' })
    await expect(preview).toContainText('将写入 2 条译文')
    await expect(preview).toContainText('#1')
    await expect(preview).toContainText('#101')
    await expect(firstGlossaryImpact).toContainText('将修改')
    await expect(window.getByText('已预览 · 将修改 2 条译文', { exact: true })).toBeVisible()
    await expect(preview.locator('.glossary-impact-final')).toContainText('欢迎来到世界足球赛，代理已就位。')
    await window.getByRole('button', { name: '应用到 2 条匹配译文' }).click()

    await expect(window.getByRole('tab', { name: /校对/ })).toHaveAttribute('aria-selected', 'true')
    await expect
      .poll(() => window.evaluate(async (taskId) => {
        const detail = await window.etch.taskDetail(taskId)
        const first = await window.etch.reviewPage(taskId, 0, 1)
        const offPage = await window.etch.reviewPage(taskId, 100, 1)
        return {
          reviewStatus: detail.manifest.pipeline.stages.review.status,
          checkpointId: detail.manifest.pipeline.stages.review.checkpointId,
          glossaryTargets: first.glossary.map((entry) => entry.target),
          firstChinese: first.items[0]?.chinese,
          offPageCueId: offPage.items[0]?.cueId,
          offPageChinese: offPage.items[0]?.chinese,
          manualEdits: detail.manifest.translation.manualEdits.map((edit) => ({ cueId: edit.cueId, translation: edit.translation })),
        }
      }, manifest.taskId))
      .toEqual({
        reviewStatus: 'checkpoint',
        checkpointId: 'manual-review',
        glossaryTargets: ['世界足球赛', '代理'],
        firstChinese: '欢迎来到世界足球赛，代理已就位。',
        offPageCueId: 101,
        offPageChinese: '欢迎来到世界足球赛，代理已就位。',
        manualEdits: [
          { cueId: 1, translation: '欢迎来到世界足球赛，代理已就位。' },
          { cueId: 101, translation: '欢迎来到世界足球赛，代理已就位。' },
        ],
      })
    await expect(window.getByRole('button', { name: '完成校对并继续' })).toBeEnabled()
    await window.getByRole('button', { name: '完成校对并继续' }).click()
    await expect
      .poll(() => window.evaluate(async (taskId) => {
        const detail = await window.etch.taskDetail(taskId)
        return {
          reviewStatus: detail.manifest.pipeline.stages.review.status,
          checkpointId: detail.manifest.pipeline.stages.review.checkpointId,
          srtResumed: detail.manifest.pipeline.stages.srt.status !== 'pending',
        }
      }, manifest.taskId))
      .toEqual({ reviewStatus: 'completed', checkpointId: undefined, srtResumed: true })
    await expect(window.getByRole('button', { name: '完成校对并继续' })).toHaveCount(0)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('serves source video ranges and previews cues beyond the editor page', async () => {
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'etch-media-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const taskDirectory = join(workspaceRoot, 'media--fixture')
  await mkdir(taskDirectory, { recursive: true })
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  const source = join(taskDirectory, 'source.mp4')
  await writeSeekableVideoFixture(source)
  const cueIds = Array.from({ length: 250 }, (_, index) => index + 1)
  const cueRange = (cueId: number): [number, number] => {
    if (cueId === 1) return [0, 4_000]
    if (cueId === 2) return [6_000, 10_000]
    const start = 12_000 + (cueId - 3) * 2_000
    return [start, start + 1_800]
  }
  const english = cueIds.map((cueId) => {
    const [start, end] = cueRange(cueId)
    const text = cueId === 1 ? 'Hello.' : cueId === 2 ? 'World Cup.' : `Segment ${cueId}.`
    return `${cueId}\n${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${text}\n`
  }).join('\n')
  const chinese = cueIds.map((cueId) =>
    `${cueId}\t${cueId === 1 ? '你好。' : cueId === 2 ? '世界杯。' : `普通译文 ${cueId}。`}`
  ).join('\n') + '\n'
  await writeFile(join(taskDirectory, 'english.clean.srt'), english)
  await writeFile(join(taskDirectory, 'zh_cues.tsv'), chinese)
  await writeFile(
    join(taskDirectory, 'audit.json'),
    `${JSON.stringify({ glossary: [{ source: 'World Cup', target: '世界杯', cueIds: [2] }], patches: [] })}\n`,
  )
  await writeFile(
    join(taskDirectory, 'bilingual.srt'),
    '1\n00:00:00,000 --> 00:00:04,000\n你好。\nHello.\n\n2\n00:00:06,000 --> 00:00:10,000\n世界杯。\nWorld Cup.\n',
  )
  await writeFile(join(taskDirectory, 'burn.log'), '')
  await writeFile(join(taskDirectory, 'verification.json'), '{}\n')
  const sourceInfo = await stat(source)
  const manifest = createTaskManifest({ kind: 'local', sourcePath: source }, '', 'codex')
  for (const stage of Object.values(manifest.pipeline.stages)) stage.status = 'completed'
  manifest.runtime.durationSeconds = 510
  const artifact = async (relativePath: string) => {
    const path = join(taskDirectory, relativePath)
    return {
      relativePath,
      sha256: await sha256File(path),
      size: (await stat(path)).size,
      valid: true,
      producer: 'e2e-fixture',
      inputFingerprint: '0'.repeat(64),
    }
  }
  manifest.artifacts.source = { ...(await artifact('source.mp4')), size: sourceInfo.size }
  manifest.artifacts.englishClean = await artifact('english.clean.srt')
  manifest.artifacts.chineseCues = await artifact('zh_cues.tsv')
  manifest.artifacts.audit = await artifact('audit.json')
  manifest.artifacts.bilingual = await artifact('bilingual.srt')
  manifest.artifacts.burnLog = await artifact('burn.log')
  manifest.artifacts.verification = await artifact('verification.json')
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    await expect(window.locator('.task-title')).toHaveAttribute('title', source)
    await window.locator('.task-row').click()
    await expect(window.locator('.task-source')).toContainText(source)
    await expect(window.getByRole('button', { name: '工作台', exact: true })).toHaveCount(0)
    const video = window.locator('video')
    await expect(video).toBeVisible()
    await expect.poll(() => video.evaluate((element) => element.controls)).toBe(false)
    await expect(window.getByRole('button', { name: '播放视频' })).toBeVisible()
    await expect(window.getByRole('slider', { name: '视频进度' })).toBeVisible()
    await expect(window.getByRole('tab', { name: '校对' })).toHaveAttribute('aria-selected', 'true')
    await expect(window.locator('.cue-row')).toHaveCount(100)
    await expect(window.locator('.burn-overlay .zh')).toHaveText('你好。')
    const fullscreenButton = window.getByRole('button', { name: '视频全屏' })
    await expect(fullscreenButton).toHaveAttribute('aria-pressed', 'false')
    await fullscreenButton.click()
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
      const browserWindow = BrowserWindow.getAllWindows()[0]
      return { fullScreen: browserWindow?.isFullScreen(), simpleFullScreen: browserWindow?.isSimpleFullScreen() }
    })).toEqual({ fullScreen: false, simpleFullScreen: true })
    await expect(window.locator('.editor-stage.is-video-fullscreen')).toBeVisible()
    await expect(window.getByRole('button', { name: '退出视频全屏' })).toHaveAttribute('aria-pressed', 'true')
    await expect(window.locator('.editor-stage.is-video-fullscreen .stage-toolbar')).toBeVisible()
    await expect(window.locator('.editor-stage.is-video-fullscreen .burn-overlay .zh')).toHaveText('你好。')
    await window.getByRole('button', { name: '退出视频全屏' }).click()
    await expect(window.locator('.editor-stage.is-video-fullscreen')).toHaveCount(0)
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isSimpleFullScreen())).toBe(false)
    await expect(fullscreenButton).toHaveAttribute('aria-pressed', 'false')
    await window.getByRole('button', { name: '仅看画面' }).click()
    await expect(window.locator('.burn-overlay')).toHaveCount(0)
    await window.getByRole('button', { name: '字幕预览' }).click()
    await expect(window.locator('.burn-overlay .zh')).toHaveText('你好。')
    await expect.poll(() => video.evaluate((element) => (element.seekable.length ? element.seekable.end(0) : 0))).toBeGreaterThan(10)
    await video.evaluate((element) => {
      element.pause()
      element.currentTime = 3.25
      element.dispatchEvent(new Event('timeupdate'))
    })
    await window.locator('nav .nav-item').filter({ hasText: '任务队列' }).click()
    await window.locator('.task-row').click()
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(3.25, 1)
    await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true)
    await video.evaluate((element) => {
      element.currentTime = 5
      element.dispatchEvent(new Event('timeupdate'))
    })
    await expect(window.locator('.burn-overlay')).toHaveCount(0)
    await expect(window.getByText('当前时间暂无字幕', { exact: true })).toHaveCount(0)
    await window.locator('.cue-source').nth(1).click()
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(5.5)
    await expect(window.locator('.cue-row').nth(1)).toHaveClass(/is-current/)
    await expect(window.locator('.burn-overlay .zh')).toHaveText('世界杯。')
    await window.getByLabel('Cue 2 中文译文').fill('世界杯赛事。')
    await expect(window.locator('.burn-overlay .zh')).toHaveText('世界杯赛事。')
    await expect(window.getByText('等待自动保存…')).toBeVisible()
    await expect(window.getByText('字幕修改已保存，等待重新生成成片。')).toBeVisible()
    const videoTimeBeforeGlossary = await video.evaluate((element) => element.currentTime)
    await window.getByRole('tab', { name: /审计术语/ }).click()
    await expect(window.getByLabel('术语 1 原文')).toHaveValue('World Cup')
    await expect(window.getByLabel('术语 1 统一写法')).toHaveValue('世界杯')
    await expect(window.getByRole('tab', { name: /审计术语/ })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(videoTimeBeforeGlossary, 1)
    await window.getByLabel('术语 1 统一写法').fill('世界杯锦标赛')
    await expect(window.getByText('已自动保存', { exact: true })).toBeVisible()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => window.etch.reviewPage(page.items[0].taskId, 0, 1).then((review) => review.glossary[0]?.target)))).toBe('世界杯锦标赛')
    await window.getByRole('tab', { name: /校对/ }).click()
    await expect(window.getByRole('tab', { name: /校对/ })).toHaveAttribute('aria-selected', 'true')
    await expect(window.getByLabel('Cue 2 中文译文')).toHaveValue('世界杯赛事。')
    await window.getByRole('tab', { name: /审计术语/ }).click()
    await expect(window.getByLabel('术语 1 统一写法')).toHaveValue('世界杯锦标赛')
    await video.evaluate((element) => {
      element.pause()
      element.currentTime = 8
      element.dispatchEvent(new Event('timeupdate'))
    })
    await window.getByLabel('术语 1 原文').fill('FIFA World Cup')
    await window.reload()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    await window.locator('.task-row').click()
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeCloseTo(8, 1)
    await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true)
    await window.getByRole('tab', { name: /审计术语/ }).click()
    await expect(window.getByLabel('术语 1 原文')).toHaveValue('FIFA World Cup')
    await expect(window.getByText('已自动保存', { exact: true })).toBeVisible()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => window.etch.reviewPage(page.items[0].taskId, 0, 1).then((review) => review.glossary[0]?.source)))).toBe('FIFA World Cup')
    await window.getByRole('tab', { name: /校对/ }).click()
    await window.locator('nav .nav-item').filter({ hasText: '任务队列' }).click()
    await window.locator('.task-row').click()
    await window.getByRole('tab', { name: /审计术语/ }).click()
    await expect(window.getByLabel('术语 1 原文')).toHaveValue('FIFA World Cup')
    await expect(window.getByLabel('术语 1 统一写法')).toHaveValue('世界杯锦标赛')
    await window.getByLabel('术语 1 统一写法').fill('我的草稿译法')
    await window.evaluate(async () => {
      const queue = await window.etch.queuePage()
      const taskId = queue.items[0].taskId
      const page = await window.etch.reviewPage(taskId, 0, 1)
      await window.etch.updateGlossary(taskId, page.revision, [{
        index: 0,
        expectedSource: 'FIFA World Cup',
        expectedTarget: '世界杯锦标赛',
        source: 'FIFA World Cup',
        target: '外部更新译法',
      }])
    })
    await expect(window.getByText('检测到版本冲突', { exact: true })).toBeVisible()
    await expect(window.getByLabel('术语 1 统一写法')).toHaveValue('我的草稿译法')
    await expect(window.getByRole('button', { name: '载入最新版本' })).toBeVisible()
    await window.reload()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    await window.locator('.task-row').click()
    await window.getByRole('tab', { name: /审计术语/ }).click()
    await expect(window.getByText('检测到版本冲突', { exact: true })).toBeVisible()
    await expect(window.getByLabel('术语 1 统一写法')).toHaveValue('我的草稿译法')
    await window.getByRole('button', { name: '用当前草稿覆盖' }).click()
    await expect(window.getByText('已自动保存', { exact: true })).toBeVisible()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => window.etch.reviewPage(page.items[0].taskId, 0, 1).then((review) => review.glossary[0]?.target)))).toBe('我的草稿译法')
    await window.getByRole('tab', { name: /校对/ }).click()
    await expect(window.getByLabel('Cue 2 中文译文')).toHaveValue('世界杯赛事。')
    await window.getByRole('button', { name: '重新生成成片' }).click()
    await expect(window.locator('.pipeline-collapse')).toHaveAttribute('open', '')
    await expect
      .poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.items[0]?.status)), { timeout: 90_000 })
      .toBe('completed')
    await expect
      .poll(
        () =>
          window.evaluate(() =>
            window.etch
              .queuePage()
              .then((page) => window.etch.taskDetail(page.items[0].taskId).then((detail) => detail.manifest.pipeline.stages.verify.status)),
          ),
        { timeout: 90_000 },
      )
      .toBe('completed')
    await expect.poll(() => window.locator('.burn-overlay').count()).toBe(0)
    await expect(window.getByText('硬字幕成片', { exact: true })).toBeVisible()
    expect(await readFile(join(taskDirectory, 'zh_cues.tsv'), 'utf8')).toContain('2\t世界杯赛事。')
    await expect(window.getByRole('button', { name: '成片已是最新' })).toBeDisabled()
    await window.getByLabel('Cue 1 中文译文').fill('您好。')
    await expect(window.getByLabel('Cue 1 中文译文')).toHaveValue('您好。')
    await expect(window.getByText('等待自动保存…')).toBeVisible()
    const concurrentManifest = JSON.parse(await readFile(join(taskDirectory, 'task.json'), 'utf8'))
    const concurrentChinesePath = join(taskDirectory, concurrentManifest.artifacts.chineseCues.relativePath)
    const concurrentChinese = (await readFile(concurrentChinesePath, 'utf8'))
      .replace(/^1\t.*$/mu, '1\t新的基线。')
    await writeFile(concurrentChinesePath, concurrentChinese)
    concurrentManifest.revision += 1
    concurrentManifest.updatedAt = new Date().toISOString()
    concurrentManifest.artifacts.chineseCues.sha256 = await sha256File(concurrentChinesePath)
    concurrentManifest.artifacts.chineseCues.size = (await stat(concurrentChinesePath)).size
    await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(concurrentManifest, null, 2)}\n`, 'utf8')
    await expect(window.locator('.cue-conflict-baseline')).toHaveText('最新基线译文：新的基线。')
    await expect(window.locator('.review-save-state')).toHaveText('自动保存失败，需处理')
    await expect(window.locator('.review-error')).toContainText('字幕基线已更新')
    await window.getByRole('tab', { name: '任务信息' }).click()
    await expect(window.locator('.review-save-state')).toHaveText('自动保存失败，需处理')
    await expect(window.locator('.review-error')).toContainText('字幕基线已更新')
    await window.getByRole('tab', { name: /校对/ }).click()
    await expect
      .poll(() =>
        window.evaluate(() =>
          window.etch
            .queuePage()
            .then((page) => window.etch.taskDetail(page.items[0].taskId).then((detail) => detail.manifest.translation.manualEdits.find((edit) => edit.cueId === 1)?.translation)),
        ),
      )
      .toBeUndefined()
    await window.getByRole('button', { name: '重试保存' }).click()
    await expect
      .poll(() =>
        window.evaluate(() =>
          window.etch
            .queuePage()
            .then((page) => window.etch.taskDetail(page.items[0].taskId).then((detail) => detail.manifest.translation.manualEdits.find((edit) => edit.cueId === 1)?.translation)),
        ),
      )
      .toBe('您好。')
    await expect(window.locator('.cue-conflict-baseline')).toHaveCount(0)
    await expect(window.locator('.review-error')).toHaveCount(0)
    await video.evaluate((element) => {
      element.currentTime = 8
      element.dispatchEvent(new Event('timeupdate'))
    })
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(7.5)
    await video.evaluate((element) => {
      Object.defineProperty(element, 'currentTime', { configurable: true, value: 408.2, writable: true })
      element.dispatchEvent(new Event('timeupdate'))
    })
    await expect(window.locator('.burn-overlay .zh')).toHaveText('普通译文 201。')
    await expect(window.locator('.cue-row')).toHaveCount(100)
    await expect(window.getByLabel('Cue 1 中文译文')).toHaveValue('您好。')
    await expect(window.getByLabel('Cue 201 中文译文')).toHaveCount(0)

    await video.evaluate((element) => element.dispatchEvent(new Event('ended')))
    await window.locator('nav .nav-item').filter({ hasText: '任务队列' }).click()
    await window.locator('.task-row').click()
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeLessThan(0.5)
    await window.locator('nav .nav-item').filter({ hasText: '任务队列' }).click()
    await expect(window.locator('.task-row')).toHaveCount(1)
    await application.evaluate(({ ipcMain }) => ipcMain.removeHandler('queue:page'))
    await expect(window.getByRole('alert')).toContainText('任务队列刷新失败')
    await expect(window.locator('.task-row')).toHaveCount(1)
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('reuses the audited English base when adding the other output', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-companion-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot)
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )

  const taskDirectory = join(workspaceRoot, 'companion-source--00000000')
  await mkdir(join(taskDirectory, '.etch-artifacts', 'shared'), { recursive: true })
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/reusable-output' }, 'Reusable Output Fixture', 'qoder')
  const sharedArtifacts = [
    ['source', 'source.mp4'],
    ['metadata', 'metadata.json'],
    ['probe', 'probe.json'],
    ['english', 'english.srt'],
    ['englishClean', 'english.clean.srt'],
    ['englishCues', 'english-cues.tsv'],
  ] as const
  for (const [key, filename] of sharedArtifacts) {
    const relativePath = `.etch-artifacts/shared/${filename}`
    const path = join(taskDirectory, relativePath)
    const content = `${key}-fixture`
    await writeFile(path, content, 'utf8')
    manifest.artifacts[key] = {
      relativePath,
      sha256: await sha256File(path),
      size: Buffer.byteLength(content),
      valid: true,
      producer: 'e2e-fixture',
      inputFingerprint: 'c'.repeat(64),
    }
  }
  for (const stage of ['source', 'inspect', 'english', 'cues'] as const) manifest.pipeline.stages[stage] = { status: 'completed', attempt: 1 }
  manifest.pipeline.stages.translate.status = 'ready'
  manifest.runtime.currentMessage = '英文底稿已完成'
  manifest.runtime.subtitleKind = 'manual'
  await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    await window.locator('.task-row').filter({ hasText: 'Reusable Output Fixture' }).click()
    await expect(window.locator('.shared-pipeline .rail-node')).toHaveCount(4)
    await expect(window.locator('.output-lane')).toHaveCount(2)
    await expect(window.getByRole('button', { name: /追加视频总结/u })).toBeEnabled({ timeout: 75_000 })
    await window.getByRole('button', { name: /追加视频总结/u }).first().click()

    const dialog = window.getByRole('dialog', { name: '生成视频总结' })
    await expect(dialog).toContainText('直接复用 4 个已完成阶段')
    await expect(dialog.locator('#companion-provider option:checked')).toBeEnabled({ timeout: 75_000 })
    await dialog.getByLabel(/总结要求/u).fill('重点保留数字与争议')
    await dialog.getByRole('button', { name: '加入暂停队列 · 只跑 4 步' }).click()
    await expect(dialog).toBeHidden()

    await expect.poll(async () => window.evaluate(async () => {
      const page = await window.etch.queuePage()
      const details = await Promise.all(page.items.map((item) => window.etch.taskDetail(item.taskId)))
      return details.map((detail) => ({
        taskId: detail.manifest.taskId,
        rootTaskId: detail.manifest.lineage.rootTaskId,
        reusedFromTaskId: detail.manifest.lineage.reusedFromTaskId,
        kind: detail.manifest.kind,
        cues: detail.manifest.pipeline.stages.cues.status,
        firstOutput: detail.manifest.kind === 'summary' ? detail.manifest.pipeline.stages.digest.status : detail.manifest.pipeline.stages.translate.status,
        directory: detail.taskDirectory,
        sourcePath: detail.manifest.artifacts.source.relativePath,
      }))
    })).toHaveLength(2)
    const details = await window.evaluate(async () => {
      const page = await window.etch.queuePage()
      return Promise.all(page.items.map((item) => window.etch.taskDetail(item.taskId).then((detail) => ({
        taskId: detail.manifest.taskId,
        rootTaskId: detail.manifest.lineage.rootTaskId,
        reusedFromTaskId: detail.manifest.lineage.reusedFromTaskId,
        kind: detail.manifest.kind,
        cues: detail.manifest.pipeline.stages.cues.status,
        firstOutput: detail.manifest.kind === 'summary' ? detail.manifest.pipeline.stages.digest.status : detail.manifest.pipeline.stages.translate.status,
        directory: detail.taskDirectory,
        sourcePath: detail.manifest.artifacts.source.relativePath,
      }))))
    })
    const subtitle = details.find((detail) => detail.kind === 'subtitle')!
    const summary = details.find((detail) => detail.kind === 'summary')!
    expect(summary).toMatchObject({ rootTaskId: subtitle.taskId, reusedFromTaskId: subtitle.taskId, cues: 'completed', firstOutput: 'ready' })
    expect((await stat(join(summary.directory, summary.sourcePath))).ino).toBe((await stat(join(subtitle.directory, subtitle.sourcePath))).ino)
    await expect(window.getByRole('group', { name: '视频成果' }).getByRole('button')).toHaveCount(2)
    await expect(window.locator('.output-lane')).toHaveCount(2)
    await expect(window.locator('.output-lane')).toContainText(['双语硬字幕', '视频总结'])
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('creates a summary task from the dialog and gates illustration on a user-chosen image-capable agent', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-summary-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot)
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(
    join(userData, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )

  const seeded = join(workspaceRoot, 'summary-seeded--00000000')
  await mkdir(join(seeded, '.etch-artifacts', 'summary', 'run'), { recursive: true })
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/summary-seeded' }, 'Seeded Summary', 'qoder', '', 'standard', false, 'summary')
  for (const stage of Object.keys(manifest.pipeline.stages)) {
    if (manifest.pipeline.stages[stage].status === 'skipped') continue
    manifest.pipeline.stages[stage].status = stage === 'illustrate' ? 'checkpoint' : 'completed'
  }
  manifest.pipeline.stages.illustrate.checkpointId = 'illustration-agent'
  manifest.pipeline.stages.illustrate.errorCode = '请确认并选择一个具备配图能力的 agent，或跳过配图'
  const summaryMarkdown = [
    '# 算力账单如何改写利润表',
    '',
    '![封面](images/00-cover.png)',
    '',
    '开场段：这场对谈发生在一场行业会议上。',
    '',
    '## 要点速览',
    '',
    '一，**利润被算力吃掉**：节目称成本结构已经变形。',
    '',
    // 面板滚动需要真的超出可见高度，所以种子正文必须足够长。
    ...Array.from({ length: 12 }, (_unused, index) => [
      `## 【${index + 1}】第 ${index + 1} 个判断`,
      '',
      '这是一段足够长的正文内容，用来把总结面板撑到需要滚动的高度。'.repeat(6),
      ''
    ]).flat(),
    '## 最后',
    '',
    '这里是作者视角的批判性评论。',
    '',
  ].join('\n')
  const articlePath = join(seeded, '.etch-artifacts', 'summary', 'run', 'summary.md')
  await writeFile(articlePath, summaryMarkdown, 'utf8')
  manifest.artifacts.summaryArticle = {
    relativePath: '.etch-artifacts/summary/run/summary.md',
    sha256: await sha256File(articlePath),
    size: Buffer.byteLength(summaryMarkdown),
    valid: true,
    producer: 'qoder',
    inputFingerprint: 'b'.repeat(64),
  }
  manifest.summary.illustration = {
    phase: 'agent-pending',
    planned: [{ filename: '00-cover.png', alt: '封面', anchor: '开场', prompt: 'hand drawn editorial card on warm ivory paper with a red underline and Chinese labels' }],
    generated: [],
    pending: [],
  }
  const longText = '这是三稿执行记录里足够长的证据文本，用来把面板撑到需要滚动的高度。'.repeat(4)
  manifest.summary.draftRecord = {
    analysisNote: `素材分析包已覆盖 1 段。${longText}`,
    drafts: (['A', 'B', 'C'] as const).map((id) => ({
      id,
      title: `候选稿 ${id} 的标题`,
      sections: ['要点速览', '【1】第一个判断', '最后'],
      length: 5000,
      opening: longText,
      finalThesis: longText,
      contributions: [`${id} 稿独有增量一`, `${id} 稿独有增量二`],
    })),
    scores: {
      A: { factuality: 9, completeness: 8, structure: 8, readability: 9, conversation: 8, finalComment: 7 },
      B: { factuality: 8, completeness: 9, structure: 7, readability: 8, conversation: 6, finalComment: 7 },
      C: { factuality: 8, completeness: 7, structure: 8, readability: 8, conversation: 7, finalComment: 9 },
    },
    baseDraft: 'A',
    baseReason: `叙事主线最完整。${longText}`,
    omissions: [`B 稿的季度数字。${longText}`, `C 稿关于回避提问的判断。${longText}`],
    omissionNote: '',
    selfCheck: `逐项核对无编造。${longText}`,
  }
  await writeFile(join(seeded, 'task.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)

    // 新建任务对话框可以创建总结任务，且总结任务不显示 B站自动投稿开关。
    const dialog = await openNewTaskDialog(window)
    await dialog.getByRole('radio', { name: /视频总结/ }).check()
    await expect(dialog.getByLabel(/总结要求/)).toBeVisible()
    await expect(dialog.getByText('完成后自动投稿到 B站')).toHaveCount(0)
    await dialog.locator('#content-url').fill('https://vimeo.com/100000014')
    await expect(dialog.locator('#provider option:checked')).toBeEnabled({ timeout: 75_000 })
    await dialog.getByRole('button', { name: /^(?:创建并开始|加入暂停队列)(?:（\d+）)?$/u }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => window.evaluate(async () => {
      const page = await window.etch.queuePage()
      return page.items.filter((item) => item.kind === 'summary').length
    })).toBe(2)

    // 打开已就绪的总结任务：只有总结相关的 tab，没有校对与压制入口。
    await window.locator('.task-row').filter({ hasText: 'Seeded Summary' }).click()
    // 阶段集合按任务类型收敛：只显示总结链路，翻译与压制阶段不出现。
    await expect(window.locator('.rail .rail-node')).toHaveCount(8)
    const outputRail = window.locator('.output-lane .rail')
    await expect(outputRail).toContainText('素材分析')
    await expect(outputRail).toContainText('外部核验')
    await expect(outputRail).toContainText('长文整理')
    await expect(outputRail).toContainText('配图')
    await expect(window.locator('.pipeline')).not.toContainText('压制')
    await expect(window.locator('.pipeline')).not.toContainText('人工校对')
    await expect(window.locator('.pipeline-pools .pool-tag')).toHaveCount(5)
    await expect(window.getByRole('tab', { name: '总结' })).toBeVisible()
    await expect(window.getByRole('tab', { name: '三稿记录' })).toBeVisible()
    await expect(window.getByRole('tab', { name: '校对' })).toHaveCount(0)
    await expect(window.getByRole('button', { name: '查看审计术语表' })).toHaveCount(0)
    await expect(window.locator('.summary-article h1')).toHaveText('算力账单如何改写利润表')
    await expect(window.locator('.summary-image.is-pending')).toHaveCount(1)
    // 总结与三稿记录面板必须真的能滚动（内层超出可见高度，且 scrollTop 可推进）。
    const scrollable = async (selector: string): Promise<{ overflowing: boolean; moved: boolean }> =>
      window.locator(selector).evaluate((element) => {
        const overflowing = element.scrollHeight > element.clientHeight + 4
        element.scrollTop = 400
        return { overflowing, moved: element.scrollTop > 0 }
      })
    expect(await scrollable('.summary-panel-body')).toEqual({ overflowing: true, moved: true })
    await window.getByRole('tab', { name: '三稿记录' }).click()
    await expect(window.locator('.summary-score-table')).toContainText('事实保真')
    expect(await scrollable('.summary-drafts')).toEqual({ overflowing: true, moved: true })
    await window.getByRole('tab', { name: '总结' }).click()
    // 面板底部提供导出与 Finder 入口。
    await expect(window.locator('.summary-actions').getByRole('button', { name: '导出总结' })).toBeEnabled()
    await expect(window.locator('.summary-actions').getByRole('button', { name: '在 Finder 中显示' })).toBeEnabled()
    // 队列卡片区分任务类型。
    await window.locator('nav .nav-item').filter({ hasText: '任务队列' }).click()
    await expect(window.locator('.task-row').filter({ hasText: 'Seeded Summary' }).locator('.task-card-overline')).toContainText('视频总结')
    await window.locator('.task-row').filter({ hasText: 'Seeded Summary' }).click()

    // 配图 checkpoint：只展示有内置图像能力的 Qoder 与 Codex。
    const checkpoint = window.locator('.illustration-checkpoint')
    await expect(checkpoint).toContainText('配图需要具备图像生成能力的 agent')
    await expect(checkpoint.getByRole('radio')).toHaveCount(2)
    await expect(checkpoint.getByRole('radio', { name: /Qoder/ })).toBeEnabled()
    await expect(checkpoint.getByRole('radio', { name: /Codex/ })).toBeAttached()
    for (const name of ['Claude Code', 'OpenCode']) {
      await expect(checkpoint.getByRole('radio', { name: new RegExp(name) })).toHaveCount(0)
    }
    await expect(window.getByRole('button', { name: '等待配图确认' })).toBeDisabled()

    // 跳过配图会直接推进 phase，不调用任何图像 CLI。
    await checkpoint.getByRole('button', { name: '跳过配图' }).click()
    await expect.poll(() => window.evaluate(async () => {
      const page = await window.etch.queuePage()
      const seededTask = page.items.find((item) => item.title === 'Seeded Summary')!
      const detail = await window.etch.taskDetail(seededTask.taskId)
      return detail.manifest.summary.illustration.phase
    })).toBe('skipped')
  } finally {
    await quitApplication(application)
    await rm(userData, { recursive: true, force: true })
  }
})
