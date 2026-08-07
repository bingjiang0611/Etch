import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChromeCookieAccess } from '../../shared/ipc'

export function chromeCookieBrowserFromLocalState(raw: string): string {
  try {
    const profile = (JSON.parse(raw) as { profile?: { last_used?: unknown } }).profile?.last_used
    return typeof profile === 'string' && /^(?:Default|Profile \d+)$/u.test(profile)
      ? `chrome:${profile}`
      : 'chrome'
  } catch {
    return 'chrome'
  }
}

export interface ChromeCookieState {
  access: ChromeCookieAccess
  browser: string | false
}

export function fullDiskAccessSettingsUrl(): string {
  return 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
}

export async function chromeCookieState(homeDirectory = homedir()): Promise<ChromeCookieState> {
  try {
    const localState = await readFile(join(homeDirectory, 'Library/Application Support/Google/Chrome/Local State'), 'utf8')
    return { access: 'granted', browser: chromeCookieBrowserFromLocalState(localState) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { access: code === 'EPERM' || code === 'EACCES' ? 'denied' : 'missing', browser: false }
  }
}
