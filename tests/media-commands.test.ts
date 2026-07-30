import { describe, expect, it } from 'vitest'
import {
  WHISPER_MODEL,
  browserCookiesUnavailable,
  burnArgs,
  normalizeDownloadedMediaArgs,
  sourceDownloadArgs,
  sourceDownloadFallbackArgs,
  thumbnailFrameArgs,
  whisperArgs,
  youtubeAuthenticationRequired,
  youtubeMediaFormatsUnavailable,
  youtubeSubtitleArgs
} from '../src/main/media/commands'

describe('media command builders', () => {
  it('keeps Chrome cookies and resumable partial downloads explicit', () => {
    const subtitleArgs = youtubeSubtitleArgs('https://youtube.com/watch?v=x', '/tmp/%(id)s')
    expect(subtitleArgs).toContain('chrome')
    expect(subtitleArgs).toContain('--skip-download')
    expect(subtitleArgs).toContain('--write-info-json')
    expect(subtitleArgs).toContain('--convert-subs')
    expect(subtitleArgs.join(' ')).not.toContain('player_client=web_safari')
  })
  it('can retry public media without browser cookies when Chrome has no cookie database', () => {
    expect(browserCookiesUnavailable('ERROR: could not find chrome cookies database in "/Users/test/Chrome"')).toBe(true)
    expect(browserCookiesUnavailable('PermissionError: [Errno 1] Operation not permitted')).toBe(true)
    expect(browserCookiesUnavailable('ERROR: video unavailable')).toBe(false)
    expect(youtubeAuthenticationRequired('Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies')).toBe(true)
    expect(youtubeAuthenticationRequired('ERROR: video unavailable')).toBe(false)
    expect(youtubeMediaFormatsUnavailable('WARNING: n challenge solving failed: Some formats may be missing')).toBe(true)
    expect(youtubeMediaFormatsUnavailable('WARNING: Only images are available for download')).toBe(true)
    expect(youtubeMediaFormatsUnavailable('ERROR: video unavailable')).toBe(false)
    expect(sourceDownloadArgs('https://youtube.com/watch?v=x', '/opt/ffmpeg', false)).not.toContain('--cookies-from-browser')
    expect(youtubeSubtitleArgs('https://youtube.com/watch?v=x', '/tmp/%(id)s', false)).not.toContain('--cookies-from-browser')
  })
  it('passes an explicit Chrome profile to yt-dlp', () => {
    expect(sourceDownloadArgs('https://youtube.com/watch?v=x', '/opt/ffmpeg', 'chrome:Profile 2')).toContain('chrome:Profile 2')
  })
  it('pins the cached Whisper revision and fixed burn profile', () => {
    expect(WHISPER_MODEL.revision).toHaveLength(40)
    expect(whisperArgs('/tmp/a.wav', '/cache/snapshot', '/tmp/out')).toEqual([
      '--model', '/cache/snapshot',
      '--output-format', 'srt',
      '--output-dir', '/tmp/out',
      '--output-name', 'english',
      '--language', 'en',
      '--condition-on-previous-text', 'False',
      '--word-timestamps', 'True',
      '--hallucination-silence-threshold', '2',
      '--max-words-per-line', '24',
      '/tmp/a.wav'
    ])
    expect(burnArgs('/tmp/a.mp4', '/tmp/a:b.srt', '/tmp/final.mp4', 'standard').join(' ')).toContain('-crf 20')
  })
  it('normalizes downloaded audio without re-encoding video', () => {
    const args = normalizeDownloadedMediaArgs('source.mp4', 'source.normalized.mp4')
    expect(args).toContain('copy')
    expect(args).toContain('aac')
    expect(args).toContain('+faststart')
  })
  it('downloads the platform thumbnail with the source media', () => {
    const args = sourceDownloadArgs('https://youtube.com/watch?v=x', '/opt/ffmpeg')
    expect(args).toContain('--write-thumbnail')
    expect(args).toContain('/opt/ffmpeg')
    expect(args).not.toContain('--write-subs')
    expect(args.at(-1)).toBe('https://youtube.com/watch?v=x')
  })
  it('falls back to default YouTube clients and remuxes a broader format selection', () => {
    const args = sourceDownloadFallbackArgs('https://youtube.com/watch?v=x', '/opt/ffmpeg', false)
    expect(args.join(' ')).not.toContain('player_client=web_safari')
    expect(args).toContain('--remux-video')
    expect(args).toContain('bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b')
    expect(args).not.toContain('--write-subs')
  })
  it('extracts a bounded fallback thumbnail frame', () => {
    expect(thumbnailFrameArgs('source.mp4', 'thumbnail.jpg', -5)).toEqual([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', '0', '-i', 'source.mp4',
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', 'thumbnail.jpg'
    ])
  })
})
