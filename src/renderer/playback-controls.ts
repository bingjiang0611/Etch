export const SEEK_STEP_SECONDS = 5
// The rate menu offers exactly these steps, so every reachable rate is one the media element accepts.
export const PLAYBACK_RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const

// A zero or unknown duration still allows seeking backwards; forward seeks stay put until the
// metadata arrives, which is honest about what the media element can actually do.
export function seekTarget(currentTime: number, deltaSeconds: number, duration: number): number {
  const upperBound = Number.isFinite(duration) && duration > 0 ? duration : Math.max(0, currentTime)
  return Math.min(upperBound, Math.max(0, currentTime + deltaSeconds))
}

export function playbackRateLabel(rate: number): string {
  return `${rate}×`
}
