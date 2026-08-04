import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { sha256File } from '../src/main/core/fingerprint'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, type TaskManifest } from '../src/shared/task-schema'
import { launchHermeticEtch, writeHermeticSettings } from './fixtures/hermetic-tools'

async function quit(application: ElectronApplication): Promise<void> {
  for (const window of application.windows()) {
    const health = window.locator('.runtime-state strong')
    if (await health.count()) await expect(health).toHaveText(/环境 9\/9 可用/, { timeout: 75_000 })
  }
  const child = application.process()
  const exited = child && child.exitCode === null ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve()
  await application.evaluate(({ app }) => app.quit())
  await exited
}

async function writeManifest(path: string, manifest: TaskManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

test('gates, edits and recovers a B站 publication through the Electron UI', async () => {
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'etch-bilibili-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  const taskDirectory = join(workspaceRoot, 'bilibili--fixture')
  const manifestPath = join(taskDirectory, 'task.json')
  const finalPath = join(taskDirectory, 'final.mp4')
  const coverPath = join(userData, 'cover.png')
  await mkdir(taskDirectory, { recursive: true })
  await writeFile(finalPath, Buffer.from('verified-video'))
  await writeFile(coverPath, await readFile(join(process.cwd(), 'build/icon.png')))
  const settings = defaultSettings(userData)
  settings.queuePaused = true
  settings.bilibiliPublishTemplate = {
    tid: 21,
    partitionName: '生活 · 日常',
    tags: ['双语字幕'],
    descriptionTemplate: '{title}\n\n来源：{source_url}'
  }
  await writeHermeticSettings(userData, { ...settings, workspaceRoot })
  await writeFile(join(userData, 'app-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    cleanExit: true,
    recoveryHold: false,
    fullDiskAccessOnboardingShown: true,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8')
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/source-video' }, 'B站投稿 UI 验收', 'codex')
  for (const stage of Object.values(manifest.pipeline.stages)) stage.status = 'completed'
  const finalSha256 = await sha256File(finalPath)
  manifest.runtime.finalRelativePath = 'final.mp4'
  manifest.runtime.completedAt = new Date().toISOString()
  manifest.artifacts.final = {
    relativePath: 'final.mp4',
    sha256: finalSha256,
    size: (await readFile(finalPath)).length,
    valid: true,
    producer: 'e2e-fixture',
    inputFingerprint: finalSha256
  }
  await writeManifest(manifestPath, manifest)

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect(window.getByRole('heading', { name: '任务队列', exact: true })).toBeVisible()
    await window.getByRole('button', { name: '新建任务', exact: true }).click()
    const newTaskDialog = window.getByRole('dialog', { name: '新建任务' })
    await expect(newTaskDialog.getByRole('switch', { name: '完成后自动投稿到 B站' })).toBeDisabled()
    await expect(newTaskDialog).toContainText('请先在设置中扫码登录')
    await expect(newTaskDialog.getByRole('button', { name: '连接 B站账号', exact: true })).toBeEnabled()
    await newTaskDialog.getByRole('button', { name: '取消', exact: true }).click()

    await window.locator('.task-row').click()
    const connectAndPublish = window.getByRole('button', { name: '连接 B站并投稿', exact: true })
    await expect(connectAndPublish).toBeEnabled()
    await connectAndPublish.click()
    const accountCard = window.locator('.bilibili-settings-card')
    await expect(accountCard).toContainText('尚未连接 B站')
    await expect(accountCard).toContainText('扫码成功后 Etch 会自动返回当前任务并打开投稿信息')
    await expect(accountCard).toHaveAttribute('data-guided', 'true')
    const loginButton = accountCard.getByRole('button', { name: '扫码登录', exact: true })
    await expect(loginButton).toBeFocused()
    await expect(accountCard.locator('select')).toBeDisabled()
    await loginButton.click()
    await expect(window.getByRole('dialog', { name: '使用哔哩哔哩 App 扫码' })).toBeVisible()
    const publishDialog = window.getByRole('dialog', { name: '投稿到 B站' })
    await expect(publishDialog).toBeVisible({ timeout: 15_000 })
    expect(await readFile(join(userData, 'bilibili-account.json'), 'utf8')).not.toContain('e2e-secret-session')
    await expect(publishDialog.getByLabel(/标题/u)).toHaveValue('B站投稿 UI 验收')
    await expect(publishDialog.getByLabel('分区')).toHaveValue('21')
    await expect(publishDialog.getByLabel(/标签/u)).toHaveValue('双语字幕')
    await expect(publishDialog.getByLabel('版权类型')).toHaveValue('repost')
    await expect(publishDialog.getByLabel('转载来源')).toHaveValue('https://example.com/source-video')

    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, coverPath)
    await publishDialog.getByRole('button', { name: '更换封面', exact: true }).click()
    await expect(publishDialog.getByRole('img', { name: '投稿封面预览' })).toBeVisible()
    await publishDialog.getByLabel(/标题/u).fill('')
    await publishDialog.getByRole('button', { name: '确认投稿', exact: true }).click()
    await expect(publishDialog.getByRole('alert')).toHaveText('请填写投稿标题')
    await publishDialog.getByLabel(/标题/u).fill('B站投稿 UI 验收')
    await publishDialog.getByLabel('分区').selectOption('138')
    await publishDialog.getByLabel(/标签/u).fill('最近标签, 双语字幕')
    await publishDialog.getByLabel('版权类型').selectOption('original')

    await application.evaluate(({ ipcMain }, detail) => {
      ipcMain.removeHandler('bilibili:publish')
      ipcMain.handle('bilibili:publish', (_event, raw) => {
        const payload = raw as { taskId?: unknown; draft?: { tid?: unknown; tags?: unknown; copyright?: unknown } }
        if (payload.taskId !== detail.manifest.taskId
          || payload.draft?.tid !== 138
          || JSON.stringify(payload.draft.tags) !== JSON.stringify(['最近标签', '双语字幕'])
          || payload.draft.copyright !== 'original') throw new Error('投稿表单没有传递已确认的最近选择')
        return detail
      })
    }, { taskDirectory, manifest })
    await publishDialog.getByRole('button', { name: '确认投稿', exact: true }).click()
    await expect(publishDialog).not.toBeVisible()

    await window.reload()
    await expect(window.getByRole('heading', { name: '任务队列', exact: true })).toBeVisible()
    await window.locator('.task-row').click()
    await window.getByRole('button', { name: '投稿到 B站', exact: true }).click()
    await expect(publishDialog.getByLabel(/标题/u)).toHaveValue('B站投稿 UI 验收')
    await expect(publishDialog.getByLabel('分区')).toHaveValue('138')
    await expect(publishDialog.getByLabel(/标签/u)).toHaveValue('最近标签, 双语字幕')
    await expect(publishDialog.getByLabel('版权类型')).toHaveValue('original')
    await publishDialog.getByRole('button', { name: '取消', exact: true }).click()

    await window.getByRole('button', { name: '任务队列', exact: true }).click()
    await window.getByRole('button', { name: '新建任务', exact: true }).click()
    const enabledSwitch = window.getByRole('dialog', { name: '新建任务' }).getByRole('switch', { name: '完成后自动投稿到 B站' })
    await expect(enabledSwitch).toBeEnabled()
    await enabledSwitch.click()
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true')
    await window.getByRole('dialog', { name: '新建任务' }).getByRole('button', { name: '取消', exact: true }).click()
    await window.locator('.task-row').click()

    let updated = JSON.parse(await readFile(manifestPath, 'utf8')) as TaskManifest
    updated.revision += 1
    updated.updatedAt = new Date().toISOString()
    updated.publication.status = 'failed'
    updated.publication.phaseMessage = '投稿失败，可继续投稿'
    updated.publication.lastError = { code: 'platform-rejected', message: 'B站拒绝了封面格式（code -400）', retryable: false }
    await writeManifest(manifestPath, updated)
    await expect(window.locator('.publication-status-banner span')).toHaveText('B站拒绝了封面格式（code -400）', { timeout: 10_000 })

    updated = JSON.parse(await readFile(manifestPath, 'utf8')) as TaskManifest
    updated.revision += 1
    updated.updatedAt = new Date().toISOString()
    updated.publication = {
      autoPublish: false,
      status: 'uploading',
      attempt: 1,
      phaseMessage: '正在上传成片',
      draft: {
        title: 'B站投稿 UI 验收',
        tid: 21,
        partitionName: '生活 · 日常',
        tags: ['双语字幕'],
        description: '本地投稿',
        copyright: 'repost',
        source: 'https://example.com/source-video',
        coverRelativePath: 'publication/cover.jpg',
        finalSha256
      }
    }
    await writeManifest(manifestPath, updated)
    await expect(window.getByRole('button', { name: '停止 B站投稿', exact: true })).toBeVisible({ timeout: 10_000 })
    await window.getByRole('button', { name: '停止 B站投稿', exact: true }).click()
    await expect(window.getByRole('button', { name: '继续 B站投稿', exact: true })).toBeVisible()

    updated = JSON.parse(await readFile(manifestPath, 'utf8')) as TaskManifest
    updated.revision += 1
    updated.updatedAt = new Date().toISOString()
    updated.publication.status = 'submitted'
    updated.publication.phaseMessage = '已提交，审核状态请在 B站创作中心查看'
    updated.publication.receipt = { aid: '123', bvid: 'BV1TEST' }
    updated.publication.submittedAt = new Date().toISOString()
    delete updated.publication.lastError
    await writeManifest(manifestPath, updated)
    await expect(window.getByRole('button', { name: '查看 B站创作中心', exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(window.locator('.publication-status-banner code')).toHaveText('BV1TEST')
  } finally {
    await quit(application)
    await rm(userData, { recursive: true, force: true })
  }
})

test('turns a QR network failure into an actionable retry state', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'etch-bilibili-error-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot)
  await writeHermeticSettings(userData, { ...defaultSettings(userData), workspaceRoot, queuePaused: true })
  await writeFile(join(userData, 'app-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    cleanExit: true,
    recoveryHold: false,
    fullDiskAccessOnboardingShown: true,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData, undefined, { bilibiliFailure: true })
  try {
    const window = await application.firstWindow()
    await expect(window.getByRole('heading', { name: '任务队列', exact: true })).toBeVisible()
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('settings')?.click())
    await window.getByRole('button', { name: '扫码登录', exact: true }).click()
    const alert = window.getByRole('alert')
    await expect(alert).toHaveText('暂时无法连接 B站登录服务，已自动重试 3 次。请检查网络或代理后重试。')
    await expect(alert).not.toContainText('Error invoking remote method')
    await expect(window.getByRole('button', { name: '重试扫码登录', exact: true })).toBeEnabled()
  } finally {
    await quit(application)
    await rm(userData, { recursive: true, force: true })
  }
})
