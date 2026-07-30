import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { flattenCue, parseSrt, serializeSrt, validateCues, type SrtCue } from '../../core/srt'
import { fingerprint, sha256File } from '../core/fingerprint'
import { writeJsonAtomic } from '../storage/atomic-json'
import { writeTextAtomic } from '../storage/atomic-text'
import { readContainedFile, sha256ContainedFile } from '../storage/safe-artifact'
import type { ProcessResult, ProcessSpec } from '../runtime/process-runner'
import { audioSegmentArgs, whisperArgs } from './commands'

const SEGMENT_BODY_SECONDS = 20 * 60
const SEGMENT_OVERLAP_SECONDS = 2
const CACHE_SCHEMA_VERSION = 2
const MERGE_ALGORITHM_VERSION = 1
const MAX_SIDECAR_BYTES = 256 * 1024
const MAX_WHISPER_LOG_BYTES = 8 * 1024 * 1024
const WHISPER_LOG_TRUNCATED = '[Etch segmented Whisper diagnostic tail truncated]'

const ExecutableIdentitySchema = z.object({
  path: z.string().min(1),
  identity: z.string().min(1),
  version: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
})
const SegmentPlanIdentitySchema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  modelRevision: z.string().min(1),
  startMilliseconds: z.number().int().nonnegative(),
  durationMilliseconds: z.number().int().positive(),
  ffmpeg: ExecutableIdentitySchema,
  mlxWhisper: ExecutableIdentitySchema,
  ffmpegArguments: z.array(z.string()),
  whisperArguments: z.array(z.string()),
  mergeAlgorithmVersion: z.literal(MERGE_ALGORITHM_VERSION)
})
const SegmentSidecarSchema = z.object({
  schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
  key: z.string().regex(/^[a-f0-9]{64}$/u),
  identity: SegmentPlanIdentitySchema.extend({
    audioSha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }),
  srtSha256: z.string().regex(/^[a-f0-9]{64}$/u)
})
type SegmentSidecar = z.infer<typeof SegmentSidecarSchema>
type SegmentPlanIdentity = z.infer<typeof SegmentPlanIdentitySchema>

export interface SegmentedWhisperOptions {
  taskDirectory: string
  sourceRelativePath: string
  sourceSha256: string
  sourceSize: number
  durationSeconds: number
  ffmpeg: string
  ffmpegIdentity: string
  ffmpegVersion: string
  ffmpegSha256: string
  mlxWhisper: string
  mlxIdentity: string
  mlxVersion: string
  mlxSha256: string
  modelSnapshot: string
  modelRevision: string
  env: NodeJS.ProcessEnv
  run(spec: ProcessSpec): Promise<ProcessResult>
}

export interface SegmentedWhisperResult {
  srt: string
  log: string
  segmentCount: number
  reusedSegments: number
}

export async function transcribeSegmentedWhisper(options: SegmentedWhisperOptions): Promise<SegmentedWhisperResult> {
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= SEGMENT_BODY_SECONDS) {
    throw new Error('分段 Whisper 仅接受超过 20 分钟的媒体')
  }
  await sha256ContainedFile(options.taskDirectory, options.sourceRelativePath, 'Whisper 源视频', {
    expectedSize: options.sourceSize,
    expectedSha256: options.sourceSha256
  })
  const cacheRoot = join(options.taskDirectory, '.etch-whisper-cache')
  await ensureCacheRoot(cacheRoot)
  const segments = segmentPlan(options.durationSeconds)
  const cues: SrtCue[][] = []
  const log = new BoundedDiagnosticLog()
  let reusedSegments = 0
  let snapshotDirectory: string | undefined
  let snapshot: Promise<string> | undefined
  const sourceSnapshot = (): Promise<string> => {
    snapshot ??= (async () => {
      snapshotDirectory = await mkdtemp(join(cacheRoot, '.source-'))
      const snapshotPath = join(snapshotDirectory, 'source.mp4')
      await copyFile(
        join(options.taskDirectory, options.sourceRelativePath),
        snapshotPath,
        constants.COPYFILE_FICLONE
      )
      await sha256ContainedFile(snapshotDirectory, 'source.mp4', 'Whisper 源视频快照', {
        expectedSize: options.sourceSize,
        expectedSha256: options.sourceSha256
      })
      return snapshotPath
    })()
    return snapshot
  }
  try {
    for (const [index, segment] of segments.entries()) {
      const result = await transcribeSegment(options, cacheRoot, segment, sourceSnapshot)
      cues.push(result.cues)
      reusedSegments += Number(result.reused)
      log.append(`segment ${index + 1}/${segments.length} ${result.reused ? 'cache-hit' : 'transcribed'} key=${result.key}\n`)
      for (const process of result.processes) log.appendProcess(process)
    }
  } finally {
    if (snapshotDirectory) await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
  const merged = mergeSegments(cues, segments)
  return {
    srt: serializeSrt(merged),
    log: log.toString(),
    segmentCount: segments.length,
    reusedSegments
  }
}

type SegmentPlan = { startSeconds: number; durationSeconds: number }

function segmentPlan(durationSeconds: number): SegmentPlan[] {
  const count = Math.ceil(durationSeconds / SEGMENT_BODY_SECONDS)
  return Array.from({ length: count }, (_, index) => {
    const bodyStart = index * SEGMENT_BODY_SECONDS
    const startSeconds = Math.max(0, bodyStart - (index ? SEGMENT_OVERLAP_SECONDS : 0))
    const endSeconds = Math.min(durationSeconds, (index + 1) * SEGMENT_BODY_SECONDS)
    return { startSeconds, durationSeconds: endSeconds - startSeconds }
  })
}

async function transcribeSegment(
  options: SegmentedWhisperOptions,
  cacheRoot: string,
  segment: SegmentPlan,
  sourceSnapshot: () => Promise<string>
): Promise<{ cues: SrtCue[]; key: string; reused: boolean; processes: ProcessResult[] }> {
  const ffmpegArguments = audioSegmentArgs(
    join(options.taskDirectory, options.sourceRelativePath),
    segment.startSeconds,
    segment.durationSeconds,
    'segment.wav'
  )
  const whisperArguments = whisperArgs('segment.wav', options.modelSnapshot, '.')
  const planIdentity: SegmentPlanIdentity = {
    sourceSha256: options.sourceSha256,
    modelRevision: options.modelRevision,
    startMilliseconds: Math.round(segment.startSeconds * 1000),
    durationMilliseconds: Math.round(segment.durationSeconds * 1000),
    ffmpeg: {
      path: options.ffmpeg,
      identity: options.ffmpegIdentity,
      version: options.ffmpegVersion,
      sha256: options.ffmpegSha256
    },
    mlxWhisper: {
      path: options.mlxWhisper,
      identity: options.mlxIdentity,
      version: options.mlxVersion,
      sha256: options.mlxSha256
    },
    ffmpegArguments,
    whisperArguments,
    mergeAlgorithmVersion: MERGE_ALGORITHM_VERSION
  }
  const key = fingerprint('etch:whisper-segment-cache', CACHE_SCHEMA_VERSION, planIdentity)
  const publishedDirectory = join(cacheRoot, key)
  let cached = await loadCachedSegment(options.taskDirectory, publishedDirectory, key, planIdentity, segment.durationSeconds)
  if (cached.state === 'valid') return { cues: cached.cues, key, reused: true, processes: [] }
  if (cached.state === 'invalid' && !await quarantineInvalidCache(publishedDirectory, cached.directoryIdentity)) {
    cached = await loadCachedSegment(options.taskDirectory, publishedDirectory, key, planIdentity, segment.durationSeconds)
    if (cached.state === 'valid') return { cues: cached.cues, key, reused: true, processes: [] }
    throw new Error(`Whisper segment cache ${key} 在校验期间变化`)
  }

  const candidate = await mkdtemp(join(cacheRoot, '.candidate-'))
  const audioPath = join(candidate, 'segment.wav')
  let published = false
  try {
    const extractionArguments = audioSegmentArgs(
      await sourceSnapshot(),
      segment.startSeconds,
      segment.durationSeconds,
      'segment.wav'
    )
    const extraction = await options.run({
      command: options.ffmpeg,
      args: extractionArguments,
      cwd: candidate,
      env: options.env,
      timeoutMs: 30 * 60_000
    })
    if (extraction.exitCode !== 0 || extraction.timedOut || extraction.cancelled) {
      throw new Error(commandFailure('Whisper 音频分段失败', extraction))
    }
    const audioSha256 = await sha256File(audioPath)
    const identity: SegmentSidecar['identity'] = {
      ...planIdentity,
      audioSha256
    }

    const transcription = await options.run({
      command: options.mlxWhisper,
      args: whisperArguments,
      cwd: candidate,
      env: options.env,
      timeoutMs: 2 * 60 * 60_000
    })
    if (transcription.exitCode !== 0 || transcription.timedOut || transcription.cancelled) {
      throw new Error(commandFailure('Whisper 分段转录失败', transcription))
    }
    const srtPath = join(candidate, 'english.srt')
    const rawSrt = (await readContainedFile(candidate, 'english.srt', 'Whisper segment candidate', {
      maxBytes: 25 * 1024 * 1024
    })).bytes.toString('utf8')
    const segmentCues = parseSegmentSrt(rawSrt)
    validateSegmentCues(segmentCues, segment.durationSeconds)
    const canonicalSrt = serializeSrt(segmentCues)
    await writeTextAtomic(srtPath, canonicalSrt)
    const srtSha256 = await sha256File(srtPath)
    const sidecar: SegmentSidecar = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      key,
      identity,
      srtSha256
    }
    await writeJsonAtomic(join(candidate, 'segment.json'), sidecar)
    await rm(audioPath, { force: true })
    try {
      await rename(candidate, publishedDirectory)
      published = true
      return {
        cues: segmentCues,
        key,
        reused: false,
        processes: [extraction, transcription]
      }
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      const concurrent = await loadCachedSegment(
        options.taskDirectory,
        publishedDirectory,
        key,
        planIdentity,
        segment.durationSeconds,
        audioSha256
      )
      if (concurrent.state === 'valid' && concurrent.srtSha256 === srtSha256) {
        return { cues: concurrent.cues, key, reused: true, processes: [extraction, transcription] }
      }
      const conflict = join(cacheRoot, `.conflict-${key}-${randomUUID()}`)
      try {
        await rename(candidate, conflict)
        published = true
      } catch {
        // finally removes the candidate if it could not be isolated.
      }
      throw new Error(`Whisper segment cache ${key} 存在身份冲突，候选已隔离`)
    }
  } finally {
    if (!published) await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function loadCachedSegment(
  taskDirectory: string,
  directory: string,
  key: string,
  planIdentity: SegmentPlanIdentity,
  durationSeconds: number,
  expectedAudioSha256?: string
): Promise<
  | { state: 'missing' }
  | { state: 'invalid'; directoryIdentity: string }
  | { state: 'valid'; cues: SrtCue[]; srtSha256: string }
> {
  let directoryIdentity = ''
  try {
    const directoryInfo = await lstat(directory)
    directoryIdentity = `${directoryInfo.dev}:${directoryInfo.ino}:${directoryInfo.ctimeMs}`
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return { state: 'invalid', directoryIdentity }
    const sidecarRelativePath = relative(taskDirectory, join(directory, 'segment.json'))
    const sidecarFile = await readContainedFile(taskDirectory, sidecarRelativePath, 'Whisper segment sidecar', {
      maxBytes: MAX_SIDECAR_BYTES
    })
    const sidecar = SegmentSidecarSchema.parse(JSON.parse(sidecarFile.bytes.toString('utf8')))
    const { audioSha256, ...cachedPlanIdentity } = sidecar.identity
    if (sidecar.key !== key
      || fingerprint('etch:whisper-segment-cache', CACHE_SCHEMA_VERSION, cachedPlanIdentity) !== key
      || fingerprint('etch:whisper-segment-plan', CACHE_SCHEMA_VERSION, cachedPlanIdentity)
        !== fingerprint('etch:whisper-segment-plan', CACHE_SCHEMA_VERSION, planIdentity)
      || (expectedAudioSha256 !== undefined && audioSha256 !== expectedAudioSha256)) {
      return { state: 'invalid', directoryIdentity }
    }
    const srtRelativePath = relative(taskDirectory, join(directory, 'english.srt'))
    const contained = await readContainedFile(taskDirectory, srtRelativePath, 'Whisper segment cache', {
      maxBytes: 25 * 1024 * 1024,
      expectedSha256: sidecar.srtSha256
    })
    const cues = parseSegmentSrt(contained.bytes.toString('utf8'))
    validateSegmentCues(cues, durationSeconds)
    return { state: 'valid', cues, srtSha256: sidecar.srtSha256 }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && !directoryIdentity
      ? { state: 'missing' }
      : { state: 'invalid', directoryIdentity }
  }
}

async function quarantineInvalidCache(directory: string, expectedIdentity: string): Promise<boolean> {
  try {
    const info = await lstat(directory)
    if (`${info.dev}:${info.ino}:${info.ctimeMs}` !== expectedIdentity) return false
    await rename(directory, `${directory}.invalid-${randomUUID()}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

function validateSegmentCues(cues: readonly SrtCue[], durationSeconds: number): void {
  validateCues(cues)
  const maximum = Math.round(durationSeconds * 1000) + 1_000
  if (cues.some((cue) => cue.startMs > maximum || cue.endMs > maximum)) {
    throw new Error('Whisper 分段字幕超出音频时间边界')
  }
}

function mergeSegments(segmentCues: readonly SrtCue[][], plans: readonly SegmentPlan[]): SrtCue[] {
  const merged: Array<{ cue: SrtCue; segmentIndex: number }> = []
  for (const [segmentIndex, cues] of segmentCues.entries()) {
    const offset = Math.round(plans[segmentIndex].startSeconds * 1000)
    const overlapStart = segmentIndex * SEGMENT_BODY_SECONDS * 1000 - SEGMENT_OVERLAP_SECONDS * 1000
    const overlapEnd = segmentIndex * SEGMENT_BODY_SECONDS * 1000
    for (const cue of cues) {
      const global = { ...cue, startMs: cue.startMs + offset, endMs: cue.endMs + offset }
      const normalized = normalizeCue(global)
      const duplicate = normalized && segmentIndex > 0 && global.startMs < overlapEnd && global.endMs > overlapStart
        ? [...merged].reverse().find((entry) =>
            entry.segmentIndex === segmentIndex - 1
            && entry.cue.startMs < overlapEnd
            && entry.cue.endMs > overlapStart
            && entry.cue.endMs > global.startMs
            && global.endMs > entry.cue.startMs
            && normalizeCue(entry.cue) === normalized
          )
        : undefined
      if (duplicate) {
        duplicate.cue.startMs = Math.min(duplicate.cue.startMs, global.startMs)
        duplicate.cue.endMs = Math.max(duplicate.cue.endMs, global.endMs)
        continue
      }
      merged.push({ cue: global, segmentIndex })
    }
  }
  merged.sort((left, right) => left.cue.startMs - right.cue.startMs || left.cue.endMs - right.cue.endMs)
  const renumbered = merged.map(({ cue }, index) => ({ ...cue, id: String(index + 1) }))
  validateCues(renumbered)
  return renumbered
}

function parseSegmentSrt(raw: string): SrtCue[] {
  const normalized = raw.replace(/^\uFEFF/u, '').trim()
  if (!normalized) return []
  const blocks = normalized.split(/\r?\n[ \t]*\r?\n/u)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u)
    if (!/^\d+$/u.test(lines[0]?.trim() ?? '')
      || !/^\d+:\d{2}:\d{2},\d{3}\s*-->\s*\d+:\d{2}:\d{2},\d{3}$/u.test(lines[1]?.trim() ?? '')
      || !lines.slice(2).some((line) => line.trim())) {
      throw new Error('Whisper 分段字幕包含无效 block')
    }
  }
  const cues = parseSrt(raw)
  if (blocks.length !== cues.length) throw new Error('Whisper 分段字幕包含无法解析的 block')
  return cues
}

async function ensureCacheRoot(cacheRoot: string): Promise<void> {
  try {
    const existing = await lstat(cacheRoot)
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Whisper segment cache 根目录必须是普通目录')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(cacheRoot, { recursive: true })
  const created = await lstat(cacheRoot)
  if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('Whisper segment cache 根目录必须是普通目录')
}

function normalizeCue(cue: SrtCue): string {
  return flattenCue(cue).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

class BoundedDiagnosticLog {
  #tail = Buffer.alloc(0)
  #truncated = false

  append(value: string): void {
    if (!value) return
    const incoming = Buffer.from(value)
    if (incoming.length >= MAX_WHISPER_LOG_BYTES) {
      this.#tail = Buffer.from(incoming.subarray(incoming.length - MAX_WHISPER_LOG_BYTES))
      this.#truncated = true
      return
    }
    if (this.#tail.length + incoming.length <= MAX_WHISPER_LOG_BYTES) {
      this.#tail = Buffer.concat([this.#tail, incoming])
      return
    }
    const keep = MAX_WHISPER_LOG_BYTES - incoming.length
    this.#tail = Buffer.concat([this.#tail.subarray(this.#tail.length - keep), incoming])
    this.#truncated = true
  }

  appendProcess(result: ProcessResult): void {
    if (result.stdoutTruncated) this.append('[Etch stdout diagnostic tail truncated]\n')
    this.append(result.stdout)
    if (result.stdout && !result.stdout.endsWith('\n')) this.append('\n')
    if (result.stderrTruncated) this.append('[Etch stderr diagnostic tail truncated]\n')
    this.append(result.stderr)
    if (result.stderr && !result.stderr.endsWith('\n')) this.append('\n')
  }

  toString(): string {
    const marker = this.#truncated ? `${WHISPER_LOG_TRUNCATED}\n` : ''
    const markerBytes = Buffer.byteLength(marker)
    const available = Math.max(0, MAX_WHISPER_LOG_BYTES - markerBytes - 1)
    const tail = this.#tail.subarray(Math.max(0, this.#tail.length - available)).toString('utf8')
    return `${marker}${tail}${tail.endsWith('\n') ? '' : '\n'}`
  }
}

function commandFailure(prefix: string, result: ProcessResult): string {
  const detail = result.stderr.trim().split(/\r?\n/u).slice(-8).join(' ')
  return `${prefix}${detail ? `：${detail}` : ''}`.slice(0, 500)
}
