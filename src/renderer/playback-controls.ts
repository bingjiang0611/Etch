export const SEEK_STEP_SECONDS = 5
export const MIN_PLAYBACK_RATE = 0.25
export const MAX_PLAYBACK_RATE = 4
export const PLAYBACK_RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const

// A zero or unknown duration still allows seeking backwards; forward seeks stay put until the
// metadata arrives, which is honest about what the media element can actually do.
export function seekTarget(currentTime: number, deltaSeconds: number, duration: number): number {
  const upperBound = Number.isFinite(duration) && duration > 0 ? duration : Math.max(0, currentTime)
  return Math.min(upperBound, Math.max(0, currentTime + deltaSeconds))
}

// The field shows its own unit (`1.5×`), so the suffix has to round-trip back through parsing.
export function parsePlaybackRate(value: string): number | undefined {
  const trimmed = value.trim().replace(/[×xX]$/u, '').trim()
  const parsed = Number(trimmed)
  if (!trimmed || !Number.isFinite(parsed)) return undefined
  if (parsed < MIN_PLAYBACK_RATE || parsed > MAX_PLAYBACK_RATE) return undefined
  return Math.round(parsed * 100) / 100
}

export function playbackRateLabel(rate: number): string {
  return `${rate}×`
}
