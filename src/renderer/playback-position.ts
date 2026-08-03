const PLAYBACK_POSITION_KEY_PREFIX = 'etch:playback-position:'

type PlaybackPositionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storageKey(taskId: string): string {
  return `${PLAYBACK_POSITION_KEY_PREFIX}${taskId}`
}

function removeStoredPosition(storage: PlaybackPositionStorage, taskId: string): void {
  try {
    storage.removeItem(storageKey(taskId))
  } catch {
    // Renderer storage is optional; playback remains usable without persistence.
  }
}

export function loadPlaybackPosition(storage: PlaybackPositionStorage, taskId: string, durationSeconds: number): number | undefined {
  try {
    const raw = storage.getItem(storageKey(taskId))
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as { seconds?: unknown } | null
    const seconds = parsed?.seconds
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || (Number.isFinite(durationSeconds) && durationSeconds > 0 && seconds >= durationSeconds)) {
      removeStoredPosition(storage, taskId)
      return undefined
    }
    return seconds
  } catch {
    removeStoredPosition(storage, taskId)
    return undefined
  }
}

export function savePlaybackPosition(storage: PlaybackPositionStorage, taskId: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) {
    removeStoredPosition(storage, taskId)
    return
  }
  try {
    storage.setItem(storageKey(taskId), JSON.stringify({ seconds }))
  } catch {
    // Renderer storage is optional; playback remains usable without persistence.
  }
}

export function clearPlaybackPosition(storage: PlaybackPositionStorage, taskId: string): void {
  removeStoredPosition(storage, taskId)
}
