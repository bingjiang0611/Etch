import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { sha256File } from '../src/main/core/fingerprint'
import { defaultSettings } from '../src/shared/settings-schema'
import { launchHermeticEtch, writeHermeticSettings } from './fixtures/hermetic-tools'

const INSTALLED_EXECUTABLE = '/Applications/Etch.app/Contents/MacOS/Etch'
const INSTALLED_ASAR = '/Applications/Etch.app/Contents/Resources/app.asar'
const PACKED_ASAR = join(process.cwd(), 'dist/mac-arm64/Etch.app/Contents/Resources/app.asar')

async function quitInstalled(application: ElectronApplication): Promise<void> {
  for (const window of application.windows()) {
    const health = window.locator('.runtime-state strong')
    if (await health.count()) await expect(health).toHaveText(/环境 9\/9 可用/, { timeout: 75_000 })
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
  const child = application.process()
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await application.evaluate(({ app }) => app.quit())
  await exited
}

test('launches the installed app with packaged preload, menu, durable IPC and clean exit', async () => {
  await Promise.all([
    access(INSTALLED_EXECUTABLE, constants.X_OK),
    access(INSTALLED_ASAR, constants.R_OK),
    access(PACKED_ASAR, constants.R_OK)
  ])
  expect(await sha256File(INSTALLED_ASAR), '已安装 Etch.app 不是本次 pack；请先覆盖安装再运行 smoke')
    .toBe(await sha256File(PACKED_ASAR))
  const userData = await mkdtemp(join(tmpdir(), 'etch-installed-smoke-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot)
  await writeHermeticSettings(userData, {
    ...defaultSettings(userData),
    workspaceRoot,
    queuePaused: true
  })
  await writeFile(join(userData, 'app-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    cleanExit: true,
    recoveryHold: false,
    fullDiskAccessGuideDismissed: true,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8')

  let application: ElectronApplication | undefined = await launchHermeticEtch(userData, INSTALLED_EXECUTABLE)
  try {
    let window = await application.firstWindow()
    await expect(window.getByRole('heading', { name: '任务队列', exact: true })).toBeVisible()
    const packagedApi = await window.evaluate(async () => ({
      createUrls: typeof window.etch?.createUrls,
      queuePage: typeof window.etch?.queuePage,
      getSettings: typeof window.etch?.getSettings,
      bilibiliAccount: typeof window.etch?.bilibiliAccount,
      publishToBilibili: typeof window.etch?.publishToBilibili,
      requestChromeCookieAccess: typeof window.etch?.requestChromeCookieAccess,
      bootstrap: await window.etch.bootstrap(),
      account: await window.etch.bilibiliAccount()
    }))
    expect(packagedApi).toMatchObject({
      createUrls: 'function',
      queuePage: 'function',
      getSettings: 'function',
      bilibiliAccount: 'function',
      publishToBilibili: 'function',
      requestChromeCookieAccess: 'function',
      account: { status: 'disconnected' }
    })
    expect(await application.evaluate(({ Menu }) => {
      const settings = Menu.getApplicationMenu()?.getMenuItemById('settings')
      return settings ? { label: settings.label, accelerator: settings.accelerator } : undefined
    })).toEqual({ label: '设置…', accelerator: 'CommandOrControl+,' })

    await window.evaluate(() => window.etch.createUrls(['https://example.com/installed-smoke'], 'codex'))
    await expect.poll(() => window.evaluate(() => window.etch.queuePage().then((page) => page.total))).toBe(1)
    await quitInstalled(application)
    application = undefined

    application = await launchHermeticEtch(userData, INSTALLED_EXECUTABLE)
    window = await application.firstWindow()
    await expect(window.getByRole('heading', { name: '任务队列', exact: true })).toBeVisible()
    await expect.poll(() => window.evaluate(async () => {
      const queue = await window.etch.queuePage()
      const detail = await window.etch.taskDetail(queue.items[0].taskId)
      return {
        input: detail.manifest.input,
        source: detail.manifest.pipeline.stages.source.status
      }
    })).toEqual({
      input: { kind: 'url', url: 'https://example.com/installed-smoke' },
      source: 'ready'
    })
  } finally {
    if (application) await quitInstalled(application)
    await expect.poll(async () => JSON.parse(await readFile(join(userData, 'app-state.json'), 'utf8')).cleanExit).toBe(true)
    await rm(userData, { recursive: true, force: true })
  }
})
