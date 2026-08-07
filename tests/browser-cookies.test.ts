import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromeCookieBrowserFromLocalState, chromeCookieState, fullDiskAccessSettingsUrl } from '../src/main/media/browser-cookies'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Chrome browser cookie profile', () => {
  it('opens Full Disk Access settings', () => {
    expect(fullDiskAccessSettingsUrl()).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
  })

  it('uses the last active regular Chrome profile', () => {
    expect(chromeCookieBrowserFromLocalState('{"profile":{"last_used":"Profile 2"}}')).toBe('chrome:Profile 2')
    expect(chromeCookieBrowserFromLocalState('{"profile":{"last_used":"unexpected:path"}}')).toBe('chrome')
    expect(chromeCookieBrowserFromLocalState('not json')).toBe('chrome')
  })

  it('reports missing Chrome data when Local State is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-browser-cookies-'))
    directories.push(directory)
    expect(await chromeCookieState(directory)).toEqual({ access: 'missing', browser: false })
  })

  it('reads the last active profile from the Chrome Local State file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-browser-cookies-'))
    directories.push(directory)
    const chromeDirectory = join(directory, 'Library/Application Support/Google/Chrome')
    await mkdir(chromeDirectory, { recursive: true })
    await writeFile(join(chromeDirectory, 'Local State'), '{"profile":{"last_used":"Default"}}')
    expect(await chromeCookieState(directory)).toEqual({ access: 'granted', browser: 'chrome:Default' })
  })

  it('reports denied access when macOS refuses the Chrome data directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-browser-cookies-'))
    directories.push(directory)
    const chromeDirectory = join(directory, 'Library/Application Support/Google/Chrome')
    await mkdir(chromeDirectory, { recursive: true })
    await writeFile(join(chromeDirectory, 'Local State'), '{"profile":{"last_used":"Default"}}')
    // macOS TCC 以 EPERM 拒绝其他 App 的数据目录，这里用 chmod 000 复现同一 errno 分支。
    await chmod(join(chromeDirectory, 'Local State'), 0o000)
    expect(await chromeCookieState(directory)).toEqual({ access: 'denied', browser: false })
  })
})
