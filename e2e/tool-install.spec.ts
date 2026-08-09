import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { defaultSettings } from '../src/shared/settings-schema'
import { launchHermeticEtch, writeHermeticSettings } from './fixtures/hermetic-tools'

test('shows a one-click install button only for undetected non-agent tools', async () => {
  test.setTimeout(90_000)
  const userData = await mkdtemp(join(tmpdir(), 'etch-tool-install-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  // python is broken, and so is every agent CLI: installing an agent without login is useless, so
  // those four must stay button-free even while their rows are red.
  await writeHermeticSettings(userData, {
    ...defaultSettings(userData),
    workspaceRoot,
    queuePaused: true,
    toolOverrides: {
      python: '/nonexistent/etch-e2e-python',
      claude: '/nonexistent/etch-e2e-claude',
      codex: '/nonexistent/etch-e2e-codex',
      qoder: '/nonexistent/etch-e2e-qodercli',
      opencode: '/nonexistent/etch-e2e-opencode'
    }
  })
  await writeFile(join(userData, 'app-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    cleanExit: true,
    recoveryHold: false,
    fullDiskAccessOnboardingShown: true,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    await expect(window.getByRole('heading', { name: '任务队列', exact: true })).toBeVisible()
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('settings')?.click())
    await expect(window.getByRole('heading', { name: '设置', exact: true })).toBeVisible()

    // python override points nowhere, so detection reports it invalid and offers an install button.
    await expect(window.getByRole('button', { name: '安装 python' })).toBeVisible({ timeout: 30_000 })
    await expect(window.getByRole('button', { name: /^安装 / })).toHaveCount(1)

    // The four agent rows are unhealthy here, which is exactly when a button must not appear.
    for (const agent of ['claude', 'codex', 'qoder', 'opencode']) {
      await expect(window.locator('.tool-row', { has: window.getByText(agent, { exact: true }) })
        .locator('.tool-mini-dot[data-status="invalid"]')).toHaveCount(1)
      await expect(window.getByRole('button', { name: `安装 ${agent}` })).toHaveCount(0)
    }
    for (const tool of ['yt-dlp', 'ffmpeg', 'ffprobe', 'mlx_whisper']) {
      await expect(window.getByRole('button', { name: `安装 ${tool}` })).toHaveCount(0)
    }
  } finally {
    const child = application.process()
    const exited = child && child.exitCode === null ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve()
    await application.evaluate(({ app }) => app.quit())
    await exited
    await rm(userData, { recursive: true, force: true })
  }
})

test('turns the runtime footer red when a running stage finds a tool gone', async () => {
  test.setTimeout(120_000)
  const userData = await mkdtemp(join(tmpdir(), 'etch-tool-vanish-e2e-'))
  const workspaceRoot = join(userData, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  const fixture = await writeHermeticSettings(userData, {
    ...defaultSettings(userData),
    workspaceRoot,
    queuePaused: false
  })
  await writeFile(join(userData, 'app-state.json'), `${JSON.stringify({
    schemaVersion: 1,
    cleanExit: true,
    recoveryHold: false,
    fullDiskAccessOnboardingShown: true,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8')

  const application = await launchHermeticEtch(userData)
  try {
    const window = await application.firstWindow()
    const footer = window.locator('.runtime-state strong')
    await expect(footer).toHaveText('环境 9/9 可用', { timeout: 75_000 })

    // Same as `brew uninstall ffmpeg ffmpeg-full` while Etch keeps running.
    await rm(join(fixture.binDirectory, 'ffmpeg'), { force: true })

    await window.evaluate(() => window.etch.createUrls(['https://vimeo.com/100000006'], 'codex'))

    // The footer must follow the stage detection without anyone pressing 重新检测.
    await expect(footer).toHaveText('环境 8/9 可用', { timeout: 60_000 })
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('settings')?.click())
    await expect(window.getByRole('button', { name: '安装 ffmpeg' })).toBeVisible()
  } finally {
    const child = application.process()
    const exited = child && child.exitCode === null ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve()
    await application.evaluate(({ app }) => app.quit())
    await exited
    await rm(userData, { recursive: true, force: true })
  }
})
