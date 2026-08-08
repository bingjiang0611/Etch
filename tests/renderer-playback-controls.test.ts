import { describe, expect, it } from 'vitest'
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  PLAYBACK_RATE_PRESETS,
  SEEK_STEP_SECONDS,
  parsePlaybackRate,
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

  it('accepts any rate inside the supported range, including non-preset values', () => {
    expect(PLAYBACK_RATE_PRESETS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2, 3])
    for (const preset of PLAYBACK_RATE_PRESETS) expect(parsePlaybackRate(String(preset))).toBe(preset)
    expect(parsePlaybackRate('1.85')).toBe(1.85)
    expect(parsePlaybackRate(' 2.5 ')).toBe(2.5)
    expect(parsePlaybackRate(String(MIN_PLAYBACK_RATE))).toBe(MIN_PLAYBACK_RATE)
    expect(parsePlaybackRate(String(MAX_PLAYBACK_RATE))).toBe(MAX_PLAYBACK_RATE)
  })

  it('round-trips the unit the field displays', () => {
    expect(playbackRateLabel(1)).toBe('1×')
    expect(playbackRateLabel(0.75)).toBe('0.75×')
    for (const preset of PLAYBACK_RATE_PRESETS) {
      expect(parsePlaybackRate(playbackRateLabel(preset))).toBe(preset)
    }
    expect(parsePlaybackRate('1.85×')).toBe(1.85)
    expect(parsePlaybackRate('2x')).toBe(2)
    expect(parsePlaybackRate('2X ')).toBe(2)
    expect(parsePlaybackRate('×')).toBeUndefined()
  })

  it('rejects values the media element would refuse instead of silencing playback', () => {
    expect(parsePlaybackRate('')).toBeUndefined()
    expect(parsePlaybackRate('  ')).toBeUndefined()
    expect(parsePlaybackRate('abc')).toBeUndefined()
    expect(parsePlaybackRate('0')).toBeUndefined()
    expect(parsePlaybackRate('-2')).toBeUndefined()
    expect(parsePlaybackRate('0.1')).toBeUndefined()
    expect(parsePlaybackRate('16')).toBeUndefined()
  })
})
