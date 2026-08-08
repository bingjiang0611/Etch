import type { ToolHealthSnapshot } from '../shared/ipc'
import type { ProviderId } from '../shared/task-schema'

export const DEFAULT_PROVIDER = 'qoder' as const satisfies ProviderId
export const PROVIDER_IDS = ['claude', 'codex', 'qoder', 'opencode'] as const satisfies readonly ProviderId[]

export function providerOrDefault(provider?: ProviderId): ProviderId {
  return provider ?? DEFAULT_PROVIDER
}

export function providerAvailability(
  provider: ProviderId,
  snapshots: readonly ToolHealthSnapshot[]
): { available: boolean; checked: boolean; summary?: string } {
  const snapshot = snapshots.find((item) => item.tool === provider)
  return snapshot
    ? { available: snapshot.status === 'ready', checked: true, summary: snapshot.summaryZh }
    : { available: false, checked: false, summary: '环境尚未检测' }
}
