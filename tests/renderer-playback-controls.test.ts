import { describe, expect, it } from 'vitest'
import {
  PLAYBACK_RATE_PRESETS,
  SEEK_STEP_SECONDS,
  playbackRateLabel,
  seekTarget
} from '../src/renderer/playback-controls'

describe('预览播放控制', () => {
  it('steps five seconds and clamps to both ends of the media', () => {
    expect(SEEK_STEP_SECONDS).toBe(5)
    expect(seekTarget(10, SEEK_STEP_SECONDS, 120)).toBe(15)
    expect(seekTarget(10, -SEEK_STEP_SECONDS, 120)).toBe(5)
    expect(seekTarget(2, -SEEK_STEP_SECONDS, 120)).toBe(0)
    expect(seekTarget(118, SEEK_STEP_SECONDS, 120)).toBe(120)
  })

  it('never seeks past an unknown duration but still rewinds', () => {
    expect(seekTarget(30, SEEK_STEP_SECONDS, 0)).toBe(30)
    expect(seekTarget(30, SEEK_STEP_SECONDS, Number.NaN)).toBe(30)
    expect(seekTarget(30, -SEEK_STEP_SECONDS, 0)).toBe(25)
  })

  it('offers only rates the media element accepts', () => {
    expect(PLAYBACK_RATE_PRESETS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2, 3])
    for (const preset of PLAYBACK_RATE_PRESETS) {
      expect(preset).toBeGreaterThan(0)
      expect(preset).toBeLessThanOrEqual(4)
    }
  })

  it('labels every rate with the unit the menu shows', () => {
    expect(playbackRateLabel(1)).toBe('1×')
    expect(playbackRateLabel(0.75)).toBe('0.75×')
    expect(PLAYBACK_RATE_PRESETS.map(playbackRateLabel)).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×', '3×'])
  })
})
