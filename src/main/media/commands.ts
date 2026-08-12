import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const WHISPER_MODEL = {
  repo: 'mlx-community/whisper-large-v3-turbo',
  revision: 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb'
} as const

export const WHISPER_MODEL_SNAPSHOTS_DIR = join(homedir(), '.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo/snapshots')

export interface WhisperModelSnapshot {
  path: string
  revision: string
  pinned: boolean
}

async function hasWhisperSnapshotFiles(path: string): Promise<boolean> {
  try {
    await access(join(path, 'config.json'))
    await access(join(path, 'weights.safetensors'))
    return true
  } catch {
    return false
  }
}

export async function resolveWhisperModelSnapshot(snapshotsDir = WHISPER_MODEL_SNAPSHOTS_DIR): Promise<WhisperModelSnapshot> {
  const pinned = join(snapshotsDir, WHISPER_MODEL.revision)
  if (await hasWhisperSnapshotFiles(pinned)) return { path: pinned, revision: WHISPER_MODEL.revision, pinned: true }
  let entries: string[]
  try {
    entries = await readdir(snapshotsDir)
  } catch {
    return { path: WHISPER_MODEL.repo, revision: 'latest', pinned: false }
  }
  for (const entry of [...entries].sort()) {
    const candidate = join(snapshotsDir, entry)
    if (entry !== WHISPER_MODEL.revision && await hasWhisperSnapshotFiles(candidate)) return { path: candidate, revision: entry, pinned: false }
  }
  return { path: WHISPER_MODEL.repo, revision: 'latest', pinned: false }
}

const SINGLE_MEDIA_ARGS = [
  '--no-playlist',
  '--socket-timeout', '30',
  '--retries', '3',
  '--fragment-retries', '3'
] as const

const BOUNDED_MEDIA_ARGS = [...SINGLE_MEDIA_ARGS, '--max-filesize', '4G'] as const

function browserCookieArgs(browserCookie: string | false): string[] {
  return browserCookie ? ['--cookies-from-browser', browserCookie] : []
}

export function browserCookiesUnavailable(stderr: string): boolean {
  return /could not find .* cookies database|operation not permitted|permission denied|failed to decrypt/iu.test(stderr)
}

export function youtubeAuthenticationRequired(stderr: string): boolean {
  return /sign in to confirm you(?:'|’)re not a bot|use --cookies-from-browser or --cookies/iu.test(stderr)
}

export function youtubeMediaFormatsUnavailable(stderr: string): boolean {
  return /(?:n|signature) challenge solving failed|only images are available|no video formats found|requested format is not available/iu.test(stderr)
}

export function youtubeSubtitleArgs(url: string, outputTemplate: string, browserCookie: string | false = 'chrome'): string[] {
  return [
    ...SINGLE_MEDIA_ARGS,
    ...browserCookieArgs(browserCookie), '--remote-components', 'ejs:github',
    '--skip-download', '--write-info-json', '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en',
    '--sub-format', 'srt/best', '--convert-subs', 'srt', '-o', outputTemplate, url
  ]
}

export function sourceDownloadArgs(url: string, ffmpegLocation: string, browserCookie: string | false = 'chrome'): string[] {
  return [
    ...BOUNDED_MEDIA_ARGS,
    ...browserCookieArgs(browserCookie), '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:player_client=web_safari',
    '--ffmpeg-location', ffmpegLocation, '--continue', '--no-overwrites',
    '-f', 'b[protocol^=m3u8][height<=1080][ext=mp4]/b[protocol^=m3u8][height<=1080]', '--merge-output-format', 'mp4',
    '--write-info-json', '--write-thumbnail', '-o', 'source.%(ext)s', url
  ]
}

export function sourceDownloadFallbackArgs(url: string, ffmpegLocation: string, browserCookie: string | false = 'chrome'): string[] {
  return [
    ...BOUNDED_MEDIA_ARGS,
    ...browserCookieArgs(browserCookie), '--remote-components', 'ejs:github',
    '--ffmpeg-location', ffmpegLocation, '--continue', '--no-overwrites',
    '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4', '--remux-video', 'mp4',
    '--write-info-json', '--write-thumbnail', '-o', 'source.%(ext)s', url
  ]
}

export function genericSourceDownloadArgs(url: string, ffmpegLocation: string): string[] {
  return [
    ...BOUNDED_MEDIA_ARGS,
    '--ffmpeg-location', ffmpegLocation, '--continue', '--no-overwrites',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4', '--remux-video', 'mp4',
    '--write-info-json', '--write-thumbnail', '-o', 'source.%(ext)s', url
  ]
}

export function normalizeDownloadedMediaArgs(source: string, output: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'warning', '-i', source, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output]
}

export function thumbnailFrameArgs(source: string, output: string, second: number): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, second)), '-i', source,
    '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', output
  ]
}

export function audioSegmentArgs(source: string, startSeconds: number, durationSeconds: number, output: string): string[] {
  return ['-v', 'error', '-ss', String(startSeconds), '-t', String(durationSeconds), '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output]
}

export function whisperArgs(audio: string, modelSnapshot: string, outputDirectory: string): string[] {
  return [
    '--model', modelSnapshot,
    '--output-format', 'srt',
    '--output-dir', outputDirectory,
    '--output-name', 'english',
    '--language', 'en',
    '--condition-on-previous-text', 'False',
    '--word-timestamps', 'True',
    '--hallucination-silence-threshold', '2',
    '--max-words-per-line', '24',
    audio
  ]
}

const PRESETS = {
  compact: 'FontName=Arial,FontSize=16,Outline=1,Shadow=0,MarginV=18',
  standard: 'FontName=Arial,FontSize=20,Outline=1,Shadow=0,MarginV=24',
  large: 'FontName=Arial,FontSize=25,Outline=2,Shadow=0,MarginV=30'
} as const

export function burnArgs(source: string, subtitles: string, output: string, preset: keyof typeof PRESETS): string[] {
  const escaped = subtitles.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "'\\''")
  return ['-v', 'error', '-i', source, '-vf', `subtitles='${escaped}':force_style='${PRESETS[preset]}'`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output]
}
