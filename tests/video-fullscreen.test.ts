import { describe, expect, it } from 'vitest'
import { isVideoFullscreenEscape } from '../src/main/video-fullscreen'

describe('video fullscreen keyboard handling', () => {
  it.each([
    { type: 'rawKeyDown', key: 'Escape', code: 'Escape' },
    { type: 'keyDown', key: 'Escape', code: 'Escape' },
    { type: 'rawKeyDown', key: '\u001b', code: '' }
  ])('accepts an Escape press while HTML fullscreen is active', (input) => {
    expect(isVideoFullscreenEscape(true, input)).toBe(true)
  })

  it.each([
    [false, { type: 'rawKeyDown', key: 'Escape', code: 'Escape' }],
    [true, { type: 'keyUp', key: 'Escape', code: 'Escape' }],
    [true, { type: 'rawKeyDown', key: 'Enter', code: 'Enter' }]
  ])('ignores input outside the video-fullscreen Escape boundary', (htmlFullscreen, input) => {
    expect(isVideoFullscreenEscape(htmlFullscreen, input)).toBe(false)
  })
})
