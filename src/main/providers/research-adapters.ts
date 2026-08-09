import type { ModelSelection, ProviderId } from '../../shared/task-schema'
import { CODEX_TEXT_ONLY_DISABLED_FEATURES } from './adapters'

export type ResearchCapability = { available: true } | { available: false; reason: string }

export function researchCapability(provider: ProviderId): ResearchCapability {
  return provider === 'codex'
    ? { available: true }
    : { available: false, reason: '当前仅 Codex 的隔离 Web Search 档已验证' }
}

export function buildResearchProviderInvocation(
  executable: string,
  model: ModelSelection,
  prompt: string
): { command: string; args: string[]; stdin: string; env: Record<string, string> } {
  return {
    command: executable,
    stdin: prompt,
    env: {},
    args: [
      'exec', '--json', '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--ignore-user-config', '--ignore-rules', '--strict-config',
      '-c', 'web_search="live"',
      ...CODEX_TEXT_ONLY_DISABLED_FEATURES
        .filter((feature) => feature !== 'standalone_web_search')
        .flatMap((feature) => ['--disable', feature]),
      ...(model.source === 'cli-default' ? [] : ['--model', model.modelId]),
      '-'
    ]
  }
}
