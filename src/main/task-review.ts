import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AuditResultSchema, glossaryTargetVariants } from '../core/translation'
import { flattenCue, parseCueTsv, parseSrt, validateCues } from '../core/srt'
import { GlossaryImpactPreviewSchema, ReviewTimelineWindowSchema, TaskReviewPageSchema, type GlossaryImpactPreview, type ReviewTimelineWindow, type TaskReviewPage } from '../shared/ipc'
import type { SubtitlePreset, TaskManifest } from '../shared/task-schema'
import { fingerprint, sha256File, sha256Text } from './core/fingerprint'
import { writeJsonAtomic } from './storage/atomic-json'
import { inspectContainedFile, readContainedFile } from './storage/safe-artifact'
import { StaleStepError, type TaskStore } from './storage/task-store'

const MAX_REVIEW_FILE_BYTES = 5 * 1024 * 1024
const GLOSSARY_ARTIFACT_GRACE_MS = 60_000
const MAX_TIMELINE_CACHE_ENTRIES = 8
const VERSIONED_AUDIT_ARTIFACT_NAME = /^audit\.(?:glossary|resolved)-[0-9a-f-]+\.json$/u

type GlossaryEdit = { index: number; expectedSource: string; expectedTarget: string; source: string; target: string }
type TargetMatch = { start: number; end: number; matchedVariant: string }
type PlannedReplacement = TargetMatch & { editIndex: number; expectedTarget: string; target: string }
type GlossaryPlan = {
  before: TaskManifest
  auditArtifact: TaskManifest['artifacts'][string]
  rawAudit: Record<string, unknown>
  glossary: Array<{ source: string; target: string; cueIds: number[] }>
  edits: GlossaryEdit[]
  source: Awaited<ReturnType<typeof reviewSource>>
  finalChinese: Map<string, string>
  preview: GlossaryImpactPreview
}
type TimelineCue = ReviewTimelineWindow['items'][number]
type TimelineCache = { identity: string; items: TimelineCue[] }
type TimelineSourceLoader = typeof reviewSource

async function readBounded(path: string, optional = false): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (info.size > MAX_REVIEW_FILE_BYTES) throw new Error(`字幕审计文件过大：${info.size} bytes`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function cueHash(cueId: number, english: string): string {
  return fingerprint('etch:manual-cue', 1, { cueId, english })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function exactTargetPattern(variant: string): string {
  const first = [...variant][0]
  const last = [...variant].at(-1)
  const latinOrNumber = /[\p{Script=Latin}\p{N}]/u
  const left = first && latinOrNumber.test(first) ? '(?<![\\p{Script=Latin}\\p{N}])' : ''
  const right = last && latinOrNumber.test(last) ? '(?![\\p{Script=Latin}\\p{N}])' : ''
  return `${left}${escapeRegExp(variant)}${right}`
}

function targetMatches(text: string, previousTarget: string): TargetMatch[] {
  const variants = glossaryTargetVariants(previousTarget)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  if (!variants.length) return []
  const pattern = new RegExp(variants.map(exactTargetPattern).join('|'), 'giu')
  return [...text.matchAll(pattern)].flatMap((match) => match.index === undefined
    ? []
    : [{ start: match.index, end: match.index + match[0].length, matchedVariant: match[0] }])
}

function applyReplacements(text: string, replacements: readonly Pick<PlannedReplacement, 'start' | 'end' | 'target'>[]): string {
  return [...replacements]
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .reduce((result, replacement) => `${result.slice(0, replacement.start)}${replacement.target}${result.slice(replacement.end)}`, text)
}

async function readArtifactText(
  taskDirectory: string,
  artifact: TaskManifest['artifacts'][string],
  label: string
): Promise<string> {
  const file = await readContainedFile(taskDirectory, artifact.relativePath, label, {
    maxBytes: MAX_REVIEW_FILE_BYTES,
    expectedSize: artifact.size,
    expectedSha256: artifact.sha256
  })
  return file.bytes.toString('utf8')
}

async function reviewSource(taskDirectory: string, manifest: TaskManifest): Promise<{
  english: ReturnType<typeof parseSrt>
  englishSha256: string
  chinese: Map<string, string>
}> {
  if (manifest.pipeline.stages.audit?.status !== 'completed' || manifest.translation.auditCheckpoint) throw new Error('完成全局审计后才能校对字幕')
  const englishArtifact = manifest.artifacts.englishClean
  const englishText = englishArtifact
    ? await readArtifactText(taskDirectory, englishArtifact, '英文清理字幕产物')
    : await readBounded(join(taskDirectory, 'english.clean.srt'), true)
  const chineseArtifact = manifest.artifacts.chineseCues
  const chineseText = chineseArtifact
    ? await readArtifactText(taskDirectory, chineseArtifact, '中文字幕产物')
    : await readBounded(join(taskDirectory, 'zh_cues.tsv'), true)
  if (!englishText || !chineseText) throw new Error('中英字幕尚未生成')
  const english = parseSrt(englishText)
  validateCues(english)
  const chinese = parseCueTsv(chineseText)
  const ids = new Set(english.map((cue) => cue.id))
  if (ids.size !== chinese.size || [...chinese.keys()].some((id) => !ids.has(id))) throw new Error(`中英 cue ID 不一致：${ids.size}/${chinese.size}`)
  const englishById = new Map(english.map((cue) => [Number(cue.id), flattenCue(cue)]))
  for (const edit of manifest.translation.manualEdits) {
    const englishText = englishById.get(edit.cueId)
    if (!englishText) throw new Error(`人工修改的 cue 已不存在：${edit.cueId}`)
    if (cueHash(edit.cueId, englishText) !== edit.englishCueHash) throw new Error(`cue ${edit.cueId} 的上游英文字幕已变化`)
    chinese.set(String(edit.cueId), edit.translation)
  }
  return {
    english,
    englishSha256: englishArtifact?.sha256 ?? sha256Text(englishText),
    chinese
  }
}

export class TaskReviewService {
  readonly #glossaryCleanupTimers = new Map<string, NodeJS.Timeout>()
  readonly #timelineCache = new Map<string, TimelineCache>()
  readonly #timelineBuilds = new Map<string, Promise<TimelineCache>>()
  readonly #latestTimelineIdentity = new Map<string, string>()

  constructor(
    readonly store: TaskStore,
    readonly isRunning: (taskDirectory: string) => boolean,
    readonly onManifest: (taskDirectory: string, manifest: TaskManifest) => void,
    readonly glossaryArtifactGraceMs = GLOSSARY_ARTIFACT_GRACE_MS,
    readonly timelineSourceLoader: TimelineSourceLoader = reviewSource,
    readonly timelineCacheLimit = MAX_TIMELINE_CACHE_ENTRIES
  ) {}

  forget(taskId: string, taskDirectory?: string): void {
    this.#timelineCache.delete(taskId)
    this.#latestTimelineIdentity.delete(taskId)
    for (const key of this.#timelineBuilds.keys()) {
      if (key.startsWith(`${taskId}\0`)) this.#timelineBuilds.delete(key)
    }
    if (taskDirectory) {
      const timer = this.#glossaryCleanupTimers.get(taskDirectory)
      if (timer) clearTimeout(timer)
      this.#glossaryCleanupTimers.delete(taskDirectory)
    }
  }

  #rememberTimeline(taskId: string, cache: TimelineCache): void {
    this.#timelineCache.delete(taskId)
    this.#timelineCache.set(taskId, cache)
    while (this.#timelineCache.size > Math.max(1, this.timelineCacheLimit)) {
      const evictedTaskId = this.#timelineCache.keys().next().value!
      this.#timelineCache.delete(evictedTaskId)
      this.#latestTimelineIdentity.delete(evictedTaskId)
    }
  }

  async #timelineFor(
    taskDirectory: string,
    manifest: TaskManifest,
    artifactIdentity: string
  ): Promise<TimelineCache> {
    this.#latestTimelineIdentity.delete(manifest.taskId)
    this.#latestTimelineIdentity.set(manifest.taskId, artifactIdentity)
    while (this.#latestTimelineIdentity.size > Math.max(1, this.timelineCacheLimit)) {
      const evictedTaskId = this.#latestTimelineIdentity.keys().next().value!
      this.#latestTimelineIdentity.delete(evictedTaskId)
      this.#timelineCache.delete(evictedTaskId)
    }
    const cached = this.#timelineCache.get(manifest.taskId)
    if (cached?.identity === artifactIdentity) {
      this.#rememberTimeline(manifest.taskId, cached)
      return cached
    }
    const buildKey = `${manifest.taskId}\0${artifactIdentity}`
    let build = this.#timelineBuilds.get(buildKey)
    if (!build) {
      build = this.timelineSourceLoader(taskDirectory, manifest).then((source) => ({
        identity: artifactIdentity,
        items: source.english.map((cue) => ({
          cueId: Number(cue.id),
          startMs: cue.startMs,
          endMs: cue.endMs,
          english: flattenCue(cue),
          chinese: source.chinese.get(cue.id)!
        }))
      }))
      this.#timelineBuilds.set(buildKey, build)
    }
    try {
      const built = await build
      if (this.#latestTimelineIdentity.get(manifest.taskId) === artifactIdentity) {
        this.#rememberTimeline(manifest.taskId, built)
      }
      return built
    } finally {
      if (this.#timelineBuilds.get(buildKey) === build) this.#timelineBuilds.delete(buildKey)
    }
  }

  #scheduleGlossaryArtifactCleanup(taskDirectory: string): void {
    const existing = this.#glossaryCleanupTimers.get(taskDirectory)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.#glossaryCleanupTimers.delete(taskDirectory)
      void this.#cleanupGlossaryArtifacts(taskDirectory).catch((error) => {
        console.error('glossary artifact cleanup failed', { taskDirectory, error })
      })
    }, this.glossaryArtifactGraceMs)
    timer.unref()
    this.#glossaryCleanupTimers.set(taskDirectory, timer)
  }

  #ensureGlossaryArtifactCleanup(taskDirectory: string): void {
    if (!this.#glossaryCleanupTimers.has(taskDirectory)) this.#scheduleGlossaryArtifactCleanup(taskDirectory)
  }

  async #cleanupGlossaryArtifacts(taskDirectory: string): Promise<void> {
    const current = await this.store.load(taskDirectory)
    const currentPath = current.artifacts.audit?.relativePath
    const cutoff = Date.now() - this.glossaryArtifactGraceMs
    const entries = await readdir(taskDirectory, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !VERSIONED_AUDIT_ARTIFACT_NAME.test(entry.name) || entry.name === currentPath) return
      const path = join(taskDirectory, entry.name)
      const info = await stat(path)
      if (info.mtimeMs > cutoff) return
      await rm(path, { force: true })
    }))
  }

  async glossarySummary(taskDirectory: string): Promise<{ glossaryState: 'not-audited' | 'empty' | 'ready' | 'invalid'; glossaryCount: number }> {
    this.#ensureGlossaryArtifactCleanup(taskDirectory)
    try {
      const manifest = await this.store.load(taskDirectory)
      const auditArtifact = manifest.artifacts.audit
      if (!auditArtifact?.valid) return { glossaryState: 'not-audited', glossaryCount: 0 }
      const audit = AuditResultSchema.parse(JSON.parse(await readArtifactText(taskDirectory, auditArtifact, '审计术语表')))
      return { glossaryState: audit.glossary.length ? 'ready' : 'empty', glossaryCount: audit.glossary.length }
    } catch {
      return { glossaryState: 'invalid', glossaryCount: 0 }
    }
  }

  async timelineWindow(
    taskDirectory: string,
    request: {
      taskId: string
      milliseconds: number
      limit: number
      expectedRevision: number
      expectedEnglishSha256?: string
      expectedChineseSha256?: string
    }
  ): Promise<ReviewTimelineWindow> {
    const manifest = await this.store.load(taskDirectory)
    if (manifest.taskId !== request.taskId || manifest.revision !== request.expectedRevision) {
      throw new StaleStepError('任务已更新，请刷新后重试')
    }
    const englishArtifact = manifest.artifacts.englishClean
    const chineseArtifact = manifest.artifacts.chineseCues
    if (request.expectedEnglishSha256 !== englishArtifact?.sha256 || request.expectedChineseSha256 !== chineseArtifact?.sha256) {
      throw new StaleStepError('字幕产物已更新，请刷新后重试')
    }
    const englishPath = englishArtifact?.relativePath ?? 'english.clean.srt'
    const chinesePath = chineseArtifact?.relativePath ?? 'zh_cues.tsv'
    const [englishFileIdentity, chineseFileIdentity] = await Promise.all([
      inspectContainedFile(taskDirectory, englishPath, '英文清理字幕产物', { expectedSize: englishArtifact?.size }),
      inspectContainedFile(taskDirectory, chinesePath, '中文字幕产物', { expectedSize: chineseArtifact?.size })
    ])
    const artifactIdentity = fingerprint('etch:review-timeline', 1, {
      taskId: manifest.taskId,
      revision: manifest.revision,
      english: { path: englishPath, sha256: englishArtifact?.sha256 ?? null, size: englishArtifact?.size ?? englishFileIdentity.size, file: englishFileIdentity },
      chinese: { path: chinesePath, sha256: chineseArtifact?.sha256 ?? null, size: chineseArtifact?.size ?? chineseFileIdentity.size, file: chineseFileIdentity },
      manualEdits: manifest.translation.manualEdits.map(({ cueId, translation, englishCueHash, updatedAt }) => ({ cueId, translation, englishCueHash, updatedAt }))
    })
    const cache = await this.#timelineFor(taskDirectory, manifest, artifactIdentity)
    if (!cache.items.length) throw new Error('字幕时间轴为空')
    const center = timelineCueIndex(cache.items, request.milliseconds)
    const offset = Math.max(0, Math.min(cache.items.length - request.limit, center - Math.floor(request.limit / 2)))
    const items = cache.items.slice(offset, offset + request.limit)
    const first = items[0]
    const last = items.at(-1)!
    const rangeStartMs = offset === 0 ? 0 : first.startMs
    const durationMs = Math.round((manifest.runtime.durationSeconds ?? 0) * 1000)
    const rangeEndMs = offset + items.length === cache.items.length
      ? Math.max(last.endMs, durationMs, request.milliseconds + 1)
      : last.endMs
    return ReviewTimelineWindowSchema.parse({
      taskId: manifest.taskId,
      revision: manifest.revision,
      artifactIdentity,
      rangeStartMs,
      rangeEndMs,
      items
    })
  }

  async #glossaryPlan(taskDirectory: string, expectedRevision: number, edits: readonly GlossaryEdit[]): Promise<GlossaryPlan> {
    if (this.isRunning(taskDirectory)) throw new Error('任务运行中，请等当前阶段结束后再应用术语')
    const before = await this.store.load(taskDirectory)
    if (before.revision !== expectedRevision) throw new StaleStepError('任务已被更新，请刷新后重试')
    const reviewStage = before.pipeline.stages.review
    if (reviewStage?.status !== 'checkpoint' || reviewStage.checkpointId !== 'manual-review') {
      throw new Error('任务当前不在人工校对 checkpoint')
    }
    if (before.translation.auditCheckpoint) throw new Error('请先完成术语审计裁决，再应用术语')
    const auditArtifact = before.artifacts.audit
    if (!auditArtifact?.valid) throw new Error('尚未生成可编辑的审计术语表')
    const rawAudit = JSON.parse(await readArtifactText(taskDirectory, auditArtifact, '审计术语表')) as unknown
    if (!rawAudit || typeof rawAudit !== 'object' || Array.isArray(rawAudit)) throw new Error('审计术语表格式无效')
    const audit = AuditResultSchema.parse(rawAudit)
    const glossary = audit.glossary.map((entry) => ({ ...entry, cueIds: [...entry.cueIds] }))
    const normalizedEdits = edits.map((edit) => ({ ...edit, source: edit.source.trim(), target: edit.target.trim() }))
    if (normalizedEdits.some((edit) => !edit.source || !edit.target)) throw new Error('原文术语和统一译法不能为空')
    const source = await reviewSource(taskDirectory, before)
    const englishCueIds = new Set(source.english.map((cue) => Number(cue.id)))
    const replacementsByCue = new Map<number, PlannedReplacement[]>()
    const impacts: GlossaryImpactPreview['impacts'] = []

    for (const edit of normalizedEdits) {
      const current = glossary[edit.index]
      if (!current || current.source !== edit.expectedSource || current.target !== edit.expectedTarget) {
        throw new StaleStepError('术语表已被更新，请刷新后重试')
      }
      const cues: GlossaryImpactPreview['impacts'][number]['cues'] = []
      for (const cueId of [...new Set(current.cueIds)].sort((left, right) => left - right)) {
        if (!englishCueIds.has(cueId)) throw new Error(`审计术语引用了不存在的 cue：${current.source} #${cueId}`)
        const beforeText = source.chinese.get(String(cueId))
        if (beforeText === undefined) throw new Error(`中文字幕缺少 cue：${cueId}`)
        if (edit.target === edit.expectedTarget) {
          cues.push({ cueId, before: beforeText, after: beforeText, matched: false, reason: 'target-unchanged' })
          continue
        }
        const matches = targetMatches(beforeText, edit.expectedTarget)
        if (!matches.length) {
          const alreadyNextTarget = targetMatches(beforeText, edit.target)
          if (alreadyNextTarget.length) {
            const cueReplacements = replacementsByCue.get(cueId) ?? []
            cueReplacements.push(...alreadyNextTarget.map((match) => ({
              ...match,
              editIndex: edit.index,
              expectedTarget: edit.target,
              target: match.matchedVariant
            })))
            replacementsByCue.set(cueId, cueReplacements)
            cues.push({
              cueId,
              before: beforeText,
              after: beforeText,
              matched: true,
              matchedVariant: alreadyNextTarget[0].matchedVariant,
              reason: 'already-next-target'
            })
            continue
          }
        }
        const replacements = matches.map((match) => ({
          ...match,
          editIndex: edit.index,
          expectedTarget: edit.expectedTarget,
          target: edit.target
        }))
        if (replacements.length) {
          const cueReplacements = replacementsByCue.get(cueId) ?? []
          cueReplacements.push(...replacements)
          replacementsByCue.set(cueId, cueReplacements)
        }
        const after = applyReplacements(beforeText, replacements)
        cues.push({
          cueId,
          before: beforeText,
          after,
          matched: matches.length > 0,
          ...(matches[0]?.matchedVariant ? { matchedVariant: matches[0].matchedVariant } : {}),
          reason: matches.length ? 'matched-target' : 'target-not-found'
        })
      }
      current.source = edit.source
      current.target = edit.target
      impacts.push({
        index: edit.index,
        source: edit.source,
        previousTarget: edit.expectedTarget,
        nextTarget: edit.target,
        cues
      })
    }

    const finalChinese = new Map(source.chinese)
    for (const [cueId, replacements] of replacementsByCue) {
      const ordered = [...replacements].sort((left, right) => left.start - right.start || right.end - left.end || left.editIndex - right.editIndex)
      let furthestAny: PlannedReplacement | undefined
      let furthestMutation: PlannedReplacement | undefined
      for (const current of ordered) {
        const currentMutates = current.target !== current.matchedVariant
        const conflict = currentMutates ? furthestAny : furthestMutation
        if (conflict && current.start < conflict.end) {
          throw new Error(`cue ${cueId} 的术语匹配范围重叠：“${conflict.expectedTarget}”与“${current.expectedTarget}”；请拆分术语后重新预览`)
        }
        if (!furthestAny || current.end > furthestAny.end) furthestAny = current
        if (currentMutates && (!furthestMutation || current.end > furthestMutation.end)) furthestMutation = current
      }
      const beforeText = source.chinese.get(String(cueId))!
      finalChinese.set(String(cueId), applyReplacements(beforeText, ordered))
    }

    const referencedCueIds = [...new Set(impacts.flatMap((impact) => impact.cues.map((cue) => cue.cueId)))]
      .sort((left, right) => left - right)
    const finalCues: GlossaryImpactPreview['finalCues'] = referencedCueIds.map((cueId) => {
      const beforeText = source.chinese.get(String(cueId))
      const afterText = finalChinese.get(String(cueId))
      if (beforeText === undefined || afterText === undefined) throw new Error(`中文字幕缺少 cue：${cueId}`)
      return { cueId, before: beforeText, after: afterText }
    })

    const previewWithoutFingerprint = {
      taskId: before.taskId,
      revision: before.revision,
      finalCues,
      impacts
    }
    const impactFingerprint = fingerprint('etch:glossary-impact', 1, {
      ...previewWithoutFingerprint,
      auditSha256: auditArtifact.sha256,
      englishSha256: source.englishSha256,
      edits: normalizedEdits.map(({ index, expectedSource, expectedTarget, source: nextSource, target }) => ({
        index, expectedSource, expectedTarget, source: nextSource, target
      }))
    })
    const preview = GlossaryImpactPreviewSchema.parse({ ...previewWithoutFingerprint, impactFingerprint })
    return {
      before,
      auditArtifact,
      rawAudit: rawAudit as Record<string, unknown>,
      glossary,
      edits: normalizedEdits,
      source,
      finalChinese,
      preview
    }
  }

  async previewGlossaryApply(taskDirectory: string, expectedRevision: number, edits: readonly GlossaryEdit[]): Promise<GlossaryImpactPreview> {
    return (await this.#glossaryPlan(taskDirectory, expectedRevision, edits)).preview
  }

  async applyGlossary(
    taskDirectory: string,
    expectedRevision: number,
    impactFingerprint: string,
    edits: readonly GlossaryEdit[]
  ): Promise<{ manifest: TaskManifest; preview: GlossaryImpactPreview }> {
    const plan = await this.#glossaryPlan(taskDirectory, expectedRevision, edits)
    if (plan.preview.impactFingerprint !== impactFingerprint) throw new StaleStepError('术语影响范围已变化，请重新预览后再应用')
    const nextAudit = { ...plan.rawAudit, glossary: plan.glossary }
    AuditResultSchema.parse(nextAudit)
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(nextAudit, null, 2)}\n`, 'utf8')
    if (serializedBytes > MAX_REVIEW_FILE_BYTES) throw new Error(`字幕审计文件过大：${serializedBytes} bytes`)

    const changedCues = new Map<number, string>()
    for (const [cueId, after] of plan.finalChinese) {
      if (after !== plan.source.chinese.get(cueId)) changedCues.set(Number(cueId), after)
    }
    const sourceChanged = plan.edits.some((edit) => edit.source !== edit.expectedSource)
    const targetChanged = plan.edits.some((edit) => edit.target !== edit.expectedTarget)
    const targetNotFoundCount = new Set(plan.preview.impacts.flatMap((impact) =>
      impact.cues.filter((cue) => cue.reason === 'target-not-found').map((cue) => cue.cueId))).size
    const matchedNoopCount = new Set(plan.preview.impacts.flatMap((impact) =>
      impact.cues.filter((cue) => cue.matched && cue.after === cue.before).map((cue) => cue.cueId))).size
    const currentMessage = changedCues.size
      ? targetNotFoundCount
        ? `已同步 ${changedCues.size} 条译文；${targetNotFoundCount} 处引用未找到旧译法，等待人工确认`
        : matchedNoopCount
          ? `已同步 ${changedCues.size} 条译文；${matchedNoopCount} 处引用已符合新译法，等待完成校对`
          : `已同步 ${changedCues.size} 条译文，等待完成校对`
      : targetChanged
        ? targetNotFoundCount
          ? `已保存统一译法；${targetNotFoundCount} 处引用未找到旧译法，等待人工确认`
          : matchedNoopCount
            ? `已保存统一译法；${matchedNoopCount} 处引用已符合新译法，无需改写`
            : '已保存统一译法，引用译文无需改写'
        : sourceChanged
          ? '已保存原文术语修改，译文无需同步'
          : '术语内容未变化，译文无需同步'
    const englishById = new Map(plan.source.english.map((cue) => [Number(cue.id), flattenCue(cue)]))
    const mutationId = randomUUID()
    const relativePath = `audit.glossary-${mutationId}.json`
    const path = join(taskDirectory, relativePath)
    let committed = false
    try {
      await writeJsonAtomic(path, nextAudit)
      const info = await stat(path)
      const nextArtifact = {
        relativePath,
        sha256: await sha256File(path),
        size: info.size,
        valid: true,
        producer: 'user-glossary-edit',
        inputFingerprint: fingerprint('etch:user-glossary-apply', 1, {
          previousAuditSha: plan.auditArtifact.sha256,
          impactFingerprint
        })
      }
      const updatedAt = new Date().toISOString()
      const updated = await this.store.mutate(taskDirectory, (manifest) => {
        if (manifest.artifacts.audit?.sha256 !== plan.auditArtifact.sha256) throw new StaleStepError('术语表已被更新，请刷新后重试')
        const reviewStage = manifest.pipeline.stages.review
        if (reviewStage?.status !== 'checkpoint' || reviewStage.checkpointId !== 'manual-review') {
          throw new StaleStepError('人工校对状态已变化，请刷新后重试')
        }
        manifest.artifacts.audit = nextArtifact
        if (changedCues.size) {
          const manualEdits = new Map(manifest.translation.manualEdits.map((edit) => [edit.cueId, edit]))
          for (const [cueId, translation] of changedCues) {
            const english = englishById.get(cueId)
            if (!english) throw new StaleStepError(`cue ${cueId} 的上游英文字幕已变化`)
            manualEdits.set(cueId, { cueId, translation, englishCueHash: cueHash(cueId, english), updatedAt })
          }
          manifest.translation.manualEdits = [...manualEdits.values()].sort((left, right) => left.cueId - right.cueId)
          for (const stage of ['srt', 'burn', 'verify'] as const) {
            const state = manifest.pipeline.stages[stage]
            state.status = 'stale'
            delete state.errorCode
            delete state.checkpointId
            delete state.activeLease
          }
          for (const artifact of ['chineseCues', 'bilingual', 'final', 'burnLog', 'verification']) {
            if (manifest.artifacts[artifact]) manifest.artifacts[artifact].valid = false
          }
          delete manifest.runtime.finalRelativePath
          delete manifest.runtime.completedAt
        }
        manifest.runtime.currentMessage = currentMessage
      }, expectedRevision)
      committed = true
      try {
        this.onManifest(taskDirectory, updated)
      } catch (error) {
        console.error('glossary apply index refresh failed after commit', { taskId: updated.taskId, revision: updated.revision, mutationId, error })
      }
      this.#scheduleGlossaryArtifactCleanup(taskDirectory)
      return { manifest: updated, preview: plan.preview }
    } finally {
      if (!committed) await rm(path, { force: true }).catch(() => undefined)
    }
  }

  async page(taskDirectory: string, offset: number, limit: number): Promise<TaskReviewPage> {
    this.#ensureGlossaryArtifactCleanup(taskDirectory)
    const manifest = await this.store.load(taskDirectory)
    let glossary: Array<{ source: string; target: string; cueIds: number[] }> = []
    let glossaryState: TaskReviewPage['glossaryState'] = 'not-audited'
    const auditArtifact = manifest.artifacts.audit
    if (auditArtifact?.valid) {
      const audit = AuditResultSchema.parse(JSON.parse(await readArtifactText(taskDirectory, auditArtifact, '审计术语表')))
      glossary = audit.glossary
      glossaryState = glossary.length ? 'ready' : 'empty'
    }
    const running = this.isRunning(taskDirectory)
    const glossaryEditable = glossaryState === 'ready' && !running && !manifest.translation.auditCheckpoint
    const glossaryEditMessage = glossaryState !== 'ready'
      ? undefined
      : running
        ? '任务运行中，请等当前阶段结束后再编辑术语'
        : manifest.translation.auditCheckpoint
          ? '请先完成术语审计裁决，再编辑术语表'
          : undefined

    let source: Awaited<ReturnType<typeof reviewSource>>
    try {
      source = await reviewSource(taskDirectory, manifest)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === '中英字幕尚未生成' || message === '完成全局审计后才能校对字幕') {
        return TaskReviewPageSchema.parse({
          taskId: manifest.taskId, revision: manifest.revision, availability: 'not-ready', message,
          offset, total: 0, items: [], glossaryState, glossary, glossaryEditable, glossaryEditMessage
        })
      }
      throw error
    }

    if (glossaryState === 'ready') {
      const cueIds = new Set(source.english.map((cue) => Number(cue.id)))
      for (const entry of glossary) {
        if (entry.cueIds.some((cueId) => !cueIds.has(cueId))) throw new Error(`审计术语引用了不存在的 cue：${entry.source}`)
      }
    }

    const items = source.english.slice(offset, offset + limit).map((cue) => ({
      cueId: Number(cue.id),
      startMs: cue.startMs,
      endMs: cue.endMs,
      english: flattenCue(cue),
      chinese: source.chinese.get(cue.id)!
    }))
    return TaskReviewPageSchema.parse({
      taskId: manifest.taskId, revision: manifest.revision, availability: 'ready', offset,
      total: source.english.length, items, glossaryState, glossary, glossaryEditable, glossaryEditMessage
    })
  }

  async updateGlossary(
    taskDirectory: string,
    expectedRevision: number,
    edits: readonly { index: number; expectedSource: string; expectedTarget: string; source: string; target: string }[]
  ): Promise<TaskManifest> {
    if (this.isRunning(taskDirectory)) throw new Error('任务运行中，请等当前阶段结束后再编辑术语')
    const before = await this.store.load(taskDirectory)
    if (before.revision !== expectedRevision) throw new StaleStepError('任务已被更新，请刷新后重试')
    if (before.translation.auditCheckpoint) throw new Error('请先完成术语审计裁决，再编辑术语表')
    const auditArtifact = before.artifacts.audit
    if (!auditArtifact?.valid) throw new Error('尚未生成可编辑的审计术语表')
    const rawAudit = JSON.parse(await readArtifactText(taskDirectory, auditArtifact, '审计术语表')) as unknown
    if (!rawAudit || typeof rawAudit !== 'object' || Array.isArray(rawAudit)) throw new Error('审计术语表格式无效')
    const audit = AuditResultSchema.parse(rawAudit)
    const glossary = audit.glossary.map((entry) => ({ ...entry, cueIds: [...entry.cueIds] }))
    const normalizedEdits = edits.map((edit) => ({ ...edit, source: edit.source.trim(), target: edit.target.trim() }))
    if (normalizedEdits.some((edit) => !edit.source || !edit.target)) throw new Error('原文术语和统一译法不能为空')
    for (const edit of normalizedEdits) {
      const current = glossary[edit.index]
      if (!current || current.source !== edit.expectedSource || current.target !== edit.expectedTarget) {
        throw new StaleStepError('术语表已被更新，请刷新后重试')
      }
      current.source = edit.source
      current.target = edit.target
    }
    if (normalizedEdits.every((edit) => edit.source === edit.expectedSource && edit.target === edit.expectedTarget)) return before

    const nextAudit = { ...(rawAudit as Record<string, unknown>), glossary }
    AuditResultSchema.parse(nextAudit)
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(nextAudit, null, 2)}\n`, 'utf8')
    if (serializedBytes > MAX_REVIEW_FILE_BYTES) throw new Error(`字幕审计文件过大：${serializedBytes} bytes`)

    const mutationId = randomUUID()
    const relativePath = `audit.glossary-${mutationId}.json`
    const path = join(taskDirectory, relativePath)
    let committed = false
    try {
      await writeJsonAtomic(path, nextAudit)
      const info = await stat(path)
      const nextArtifact = {
        relativePath,
        sha256: await sha256File(path),
        size: info.size,
        valid: true,
        producer: 'user-glossary-edit',
        inputFingerprint: fingerprint('etch:user-glossary', 1, {
          previousAuditSha: auditArtifact.sha256,
          edits: normalizedEdits.map(({ index, source, target }) => ({ index, source, target }))
        })
      }
      const updated = await this.store.mutate(taskDirectory, (manifest) => {
        if (manifest.artifacts.audit?.sha256 !== auditArtifact.sha256) throw new StaleStepError('术语表已被更新，请刷新后重试')
        manifest.artifacts.audit = nextArtifact
      }, expectedRevision)
      committed = true
      try {
        this.onManifest(taskDirectory, updated)
      } catch (error) {
        console.error('glossary index refresh failed after commit', { taskId: updated.taskId, revision: updated.revision, mutationId, error })
      }
      console.info('glossary updated', {
        taskId: updated.taskId,
        previousRevision: before.revision,
        revision: updated.revision,
        previousAuditSha: auditArtifact.sha256,
        auditSha: nextArtifact.sha256,
        mutationId
      })
      this.#scheduleGlossaryArtifactCleanup(taskDirectory)
      return updated
    } finally {
      if (!committed) await rm(path, { force: true }).catch(() => undefined)
    }
  }

  async update(taskDirectory: string, expectedRevision: number, edits: readonly { cueId: number; translation: string }[]): Promise<TaskManifest> {
    if (this.isRunning(taskDirectory)) throw new Error('任务运行中，请等当前阶段结束后再编辑')
    const before = await this.store.load(taskDirectory)
    const source = await reviewSource(taskDirectory, before)
    const englishById = new Map(source.english.map((cue) => [Number(cue.id), flattenCue(cue)]))
    for (const edit of edits) if (!englishById.has(edit.cueId)) throw new Error(`cue 不存在：${edit.cueId}`)
    const updatedAt = new Date().toISOString()
    const updated = await this.store.mutate(taskDirectory, (manifest) => {
      const manualEdits = new Map(manifest.translation.manualEdits.map((edit) => [edit.cueId, edit]))
      for (const edit of edits) manualEdits.set(edit.cueId, {
        cueId: edit.cueId,
        translation: edit.translation.trim(),
        englishCueHash: cueHash(edit.cueId, englishById.get(edit.cueId)!),
        updatedAt
      })
      manifest.translation.manualEdits = [...manualEdits.values()].sort((left, right) => left.cueId - right.cueId)
      for (const stage of ['srt', 'burn', 'verify'] as const) {
        const state = manifest.pipeline.stages[stage]
        state.status = 'stale'
        delete state.errorCode
        delete state.checkpointId
        delete state.activeLease
      }
      for (const artifact of ['chineseCues', 'bilingual', 'final', 'burnLog', 'verification']) {
        if (manifest.artifacts[artifact]) manifest.artifacts[artifact].valid = false
      }
      delete manifest.runtime.finalRelativePath
      delete manifest.runtime.completedAt
      manifest.runtime.currentMessage = `已保存 ${edits.length} 处字幕修改，等待重新生成成片`
    }, expectedRevision)
    this.onManifest(taskDirectory, updated)
    return updated
  }

  async updateSubtitlePreset(taskDirectory: string, expectedRevision: number, preset: SubtitlePreset): Promise<TaskManifest> {
    if (this.isRunning(taskDirectory)) throw new Error('任务运行中，请等当前阶段结束后再修改压制预设')
    const before = await this.store.load(taskDirectory)
    if (before.revision !== expectedRevision) throw new StaleStepError('任务已被更新，请刷新后重试')
    if (before.render.subtitlePreset === preset) return before
    const updated = await this.store.mutate(taskDirectory, (manifest) => {
      manifest.render.subtitlePreset = preset
      const hasPublishedRender = ['final', 'burnLog', 'verification'].some((name) => manifest.artifacts[name]?.valid)
      let requiresRebuild = hasPublishedRender
      for (const stage of ['burn', 'verify'] as const) {
        const state = manifest.pipeline.stages[stage]
        if (state.status === 'pending' || state.status === 'ready' || state.status === 'skipped') continue
        requiresRebuild = true
        state.status = 'stale'
        delete state.errorCode
        delete state.checkpointId
        delete state.activeLease
      }
      for (const artifact of ['final', 'burnLog', 'verification']) {
        if (manifest.artifacts[artifact]) manifest.artifacts[artifact].valid = false
      }
      delete manifest.runtime.finalRelativePath
      delete manifest.runtime.completedAt
      if (requiresRebuild) manifest.runtime.currentMessage = '已更新当前任务字幕字号，等待重新压制成片'
    }, expectedRevision)
    this.onManifest(taskDirectory, updated)
    return updated
  }
}

function timelineCueIndex(items: readonly TimelineCue[], milliseconds: number): number {
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (items[middle].startMs <= milliseconds) low = middle + 1
    else high = middle
  }
  const previous = Math.max(0, low - 1)
  return items[previous].endMs > milliseconds || low >= items.length ? previous : low
}
