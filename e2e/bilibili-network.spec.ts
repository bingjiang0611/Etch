import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { defaultSettings } from '../src/shared/settings-schema'
import { launchHermeticEtch, writeHermeticSettings } from './fixtures/hermetic-tools'

test.skip(process.env.ETCH_E2E_BILIBILI_NETWORK !== '1', '只在显式启用时连接真实 B站二维码服务')

async function exitTestInstance(application: Awaited<ReturnType<typeof launchHermeticEtch>>): Promise<void> {
  const child = application.process()
  const exited = child && child.exitCode === null ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve()
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await exited
}

test('requests a real B站 QR code through the Etch main-process network path', async () => {
  test.setTimeout(60_000)
  const userData = await mkdtemp(join(tmpdir(), 'etch-bilibili-network-'))
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

  const application = await launchHermeticEtch(userData, undefined, { bilibiliNetwork: true })
  try {
    const window = await application.firstWindow()
    await expect(window.getByRole('heading', { name: '任务队列', exact: true })).toBeVisible()
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('settings')?.click())
    const loginButton = window.getByRole('button', { name: '扫码登录', exact: true })
    await expect(loginButton).toBeVisible()
    await loginButton.click()
    const dialog = window.getByRole('dialog', { name: '使用哔哩哔哩 App 扫码' })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByRole('img', { name: 'B站登录二维码' })).toBeVisible()
    await expect(window.locator('.bilibili-connect-error')).toHaveCount(0)
  } finally {
    await exitTestInstance(application)
    await rm(userData, { recursive: true, force: true })
  }
})
