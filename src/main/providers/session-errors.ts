import type { ProviderId } from '../../shared/task-schema'

export const PROVIDER_SESSION_UNAVAILABLE_PREFIX = 'PROVIDER_SESSION_UNAVAILABLE:'
export const PROVIDER_SESSION_CONTAMINATED_PREFIX = 'PROVIDER_SESSION_CONTAMINATED:'
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu')

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function providerSessionIsUnavailable(provider: ProviderId, externalSessionId: string, diagnostic: string): boolean {
  const id = escapeRegExp(externalSessionId.normalize('NFKC').toLocaleLowerCase('en-US'))
  const lines = diagnostic
    .replace(ANSI_ESCAPE, '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
  const any = (patterns: RegExp[]): boolean => lines.some((line) => patterns.some((pattern) => pattern.test(line)))
  switch (provider) {
    case 'claude': return any([
      new RegExp(`^(?:error:\\s*)?no conversation found with session id:\\s*"?${id}"?[.!]?$`, 'u'),
      new RegExp(`^(?:error:\\s*)?session not found:\\s*"?${id}"?[.!]?$`, 'u')
    ])
    case 'codex': return any([
      new RegExp(`^(?:error:\\s*)?no saved session found with id[:\\s]+"?${id}"?[.!]?$`, 'u'),
      new RegExp(`^(?:error:\\s*)?(?:thread/resume:\\s*thread/resume failed:\\s*)?no rollout found for thread id[:\\s]+"?${id}"?(?:\\s+\\(code -32600\\))?[.!]?$`, 'u'),
      new RegExp(`^(?:error:\\s*)?thread\\s+"?${id}"?\\s+not found[.!]?$`, 'u'),
      new RegExp(`^(?:error:\\s*)?thread not found[:\\s]+"?${id}"?[.!]?$`, 'u')
    ])
    case 'qoder': return any([
      new RegExp(`^(?:error:\\s*)?(?:error resuming session:\\s*)?invalid session identifier\\s+"?${id}"?[.!]?$`, 'u'),
      /^(?:error:\s*)?(?:error resuming session:\s*)?no previous sessions found for this project[.!]?$/u
    ])
    case 'opencode': return any([/^(?:error:\s*)?session not found[.!]?$/u])
  }
}
