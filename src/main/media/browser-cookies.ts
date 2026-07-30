import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

export async function chromeCookieBrowser(homeDirectory = homedir()): Promise<string> {
  try {
    const localState = await readFile(join(homeDirectory, 'Library/Application Support/Google/Chrome/Local State'), 'utf8')
    return chromeCookieBrowserFromLocalState(localState)
  } catch {
    return 'chrome'
  }
}
