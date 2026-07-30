import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromeCookieBrowser, chromeCookieBrowserFromLocalState } from '../src/main/media/browser-cookies'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Chrome browser cookie profile', () => {
  it('uses the last active regular Chrome profile', () => {
    expect(chromeCookieBrowserFromLocalState('{"profile":{"last_used":"Profile 2"}}')).toBe('chrome:Profile 2')
    expect(chromeCookieBrowserFromLocalState('{"profile":{"last_used":"unexpected:path"}}')).toBe('chrome')
    expect(chromeCookieBrowserFromLocalState('not json')).toBe('chrome')
  })

  it('falls back to Chrome default when Local State is unreadable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-browser-cookies-'))
    directories.push(directory)
    expect(await chromeCookieBrowser(directory)).toBe('chrome')
  })

  it('reads the last active profile from the Chrome Local State file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-browser-cookies-'))
    directories.push(directory)
    const chromeDirectory = join(directory, 'Library/Application Support/Google/Chrome')
    await mkdir(chromeDirectory, { recursive: true })
    await writeFile(join(chromeDirectory, 'Local State'), '{"profile":{"last_used":"Default"}}')
    expect(await chromeCookieBrowser(directory)).toBe('chrome:Default')
  })
})
