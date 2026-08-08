import type { ToolHealthSnapshot } from '../shared/ipc'
import type { ProviderId } from '../shared/task-schema'
import { DEFAULT_PROVIDER, PROVIDER_IDS, providerAvailability } from './provider-availability'

export const NEW_TASK_PROVIDER_STORAGE_KEY = 'etch:new-task-provider:v1'

type NewTaskProviderStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type NewTaskProviderStorageAccess = NewTaskProviderStorage | (() => NewTaskProviderStorage)

function resolveStorage(access: NewTaskProviderStorageAccess): NewTaskProviderStorage {
  return typeof access === 'function' ? access() : access
}

function knownProvider(value: unknown): ProviderId | undefined {
  return PROVIDER_IDS.find((provider) => provider === value)
}

export function loadLastNewTaskProvider(access: NewTaskProviderStorageAccess): ProviderId | undefined {
  try {
    const storage = resolveStorage(access)
    const raw = storage.getItem(NEW_TASK_PROVIDER_STORAGE_KEY)
    if (raw === null) return undefined
    let provider: ProviderId | undefined
    try {
      provider = knownProvider((JSON.parse(raw) as { provider?: unknown } | null)?.provider)
    } catch {
      // Malformed JSON is cleared below.
    }
    if (provider) return provider
    storage.removeItem(NEW_TASK_PROVIDER_STORAGE_KEY)
  } catch {
    // Invalid or unavailable storage falls back to the configured default provider.
  }
  return undefined
}

export function saveLastNewTaskProvider(access: NewTaskProviderStorageAccess, provider: ProviderId): void {
  if (!knownProvider(provider)) return
  try {
    resolveStorage(access).setItem(NEW_TASK_PROVIDER_STORAGE_KEY, JSON.stringify({ provider }))
  } catch {
    // Remembering the last choice must never prevent a task from being created.
  }
}

// The last provider that actually created a task wins, then the configured default, then Qoder.
// Skipping candidates whose CLI is not ready avoids reopening the form on a provider that would
// only disable the submit button; when nothing is ready the first candidate still shows the reason.
export function resolveNewTaskProvider(
  remembered: ProviderId | undefined,
  configuredDefault: ProviderId | undefined,
  health: readonly ToolHealthSnapshot[]
): ProviderId {
  const candidates = [...new Set([remembered, configuredDefault, DEFAULT_PROVIDER].filter((provider): provider is ProviderId => Boolean(provider)))]
  return candidates.find((provider) => providerAvailability(provider, health).available) ?? candidates[0]
}
