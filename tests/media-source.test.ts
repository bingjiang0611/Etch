import { describe, expect, it } from 'vitest'
import { classifyMediaSourceUrl, isSupportedMediaSourceUrl } from '../src/shared/media-source'

describe('media source URL classification', () => {
  it.each([
    'https://youtube.com/watch?v=x',
    'https://www.youtube.com/watch?v=x',
    'https://music.youtube.com/watch?v=x',
    'https://youtu.be/x',
    'https://www.youtube-nocookie.com/embed/x'
  ])('recognizes YouTube hostname %s', (url) => {
    expect(classifyMediaSourceUrl(url)).toBe('youtube')
  })

  it.each([
    'https://youtube.com.evil.test/watch?v=x',
    'https://notyoutube.com/watch?v=x',
    'https://example.com/youtube.com/watch?v=x',
    'https://example.com/watch?next=https://youtu.be/x',
    'not a URL'
  ])('does not accept a deceptive or invalid URL %s', (url) => {
    expect(classifyMediaSourceUrl(url)).toBe('generic')
  })
})

describe('supported media URL boundary', () => {
  it.each([
    'https://youtu.be/x',
    'https://player.vimeo.com/video/1',
    'https://x.com/user/status/1',
    'https://mobile.twitter.com/user/status/1'
  ])('accepts the bounded media host %s', (url) => {
    expect(isSupportedMediaSourceUrl(url)).toBe(true)
  })

  it.each([
    'http://127.0.0.1/video.mp4',
    'http://vimeo.com/1',
    'https://vimeo.com.evil.test/video/1',
    'https://user:secret@vimeo.com/1',
    'https://example.com/video.mp4',
    'file:///tmp/video.mp4'
  ])('rejects unsupported or unsafe media URL %s', (url) => {
    expect(isSupportedMediaSourceUrl(url)).toBe(false)
  })
})
