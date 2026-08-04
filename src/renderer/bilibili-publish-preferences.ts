import type { BilibiliCopyright } from '../shared/bilibili'

export const BILIBILI_PUBLISH_PREFERENCES_STORAGE_KEY = 'etch:bilibili-publish-preferences:v1'

type BilibiliPublishPreferencesStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type BilibiliPublishPreferencesStorageAccess = BilibiliPublishPreferencesStorage | (() => BilibiliPublishPreferencesStorage)

export interface BilibiliPublishPreferences {
  tid: number
  tags: string[]
  copyright: BilibiliCopyright
}

interface StoredBilibiliPublishPreferences extends BilibiliPublishPreferences {
  schemaVersion: 1
}

function resolveStorage(access: BilibiliPublishPreferencesStorageAccess): BilibiliPublishPreferencesStorage {
  return typeof access === 'function' ? access() : access
}

function normalizedPreferences(value: unknown): BilibiliPublishPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<StoredBilibiliPublishPreferences>
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.tid) || Number(candidate.tid) <= 0) return undefined
  if (candidate.copyright !== 'original' && candidate.copyright !== 'repost') return undefined
  if (!Array.isArray(candidate.tags) || candidate.tags.length < 1 || candidate.tags.length > 10) return undefined
  const tags = candidate.tags.map((tag) => typeof tag === 'string' ? tag.trim() : '')
  if (tags.some((tag) => !tag || Array.from(tag).length > 20)) return undefined
  return { tid: Number(candidate.tid), tags, copyright: candidate.copyright }
}

export function loadBilibiliPublishPreferences(access: BilibiliPublishPreferencesStorageAccess): BilibiliPublishPreferences | undefined {
  try {
    const storage = resolveStorage(access)
    const raw = storage.getItem(BILIBILI_PUBLISH_PREFERENCES_STORAGE_KEY)
    if (raw === null) return undefined
    let preferences: BilibiliPublishPreferences | undefined
    try {
      preferences = normalizedPreferences(JSON.parse(raw))
    } catch {
      // Malformed JSON is cleared below.
    }
    if (preferences) return preferences
    storage.removeItem(BILIBILI_PUBLISH_PREFERENCES_STORAGE_KEY)
  } catch {
    // Invalid or unavailable storage falls back to the configured publication template.
  }
  return undefined
}

export function saveBilibiliPublishPreferences(access: BilibiliPublishPreferencesStorageAccess, value: BilibiliPublishPreferences): void {
  const preferences = normalizedPreferences({ schemaVersion: 1, ...value })
  if (!preferences) return
  try {
    const storage = resolveStorage(access)
    storage.setItem(BILIBILI_PUBLISH_PREFERENCES_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, ...preferences }))
  } catch {
    // Remembering preferences must never prevent a publication from starting.
  }
}
