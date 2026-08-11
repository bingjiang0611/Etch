import { z } from 'zod'
import { guardedPrompt, untrustedJsonSection } from './prompt-boundary'
import { VALIDATION_FAILURE_PROMPT_LIMIT } from './schema-contract'

export const ENGLISH_SOURCE_AUDIT_MAIN_CUE_COUNT = 220
export const ENGLISH_SOURCE_AUDIT_CONTEXT_RADIUS = 2
export const ENGLISH_SOURCE_AUDIT_MAX_PATCHES = 24

export interface EnglishSourceAuditCue {
  id: number
  text: string
  startMs?: number
  endMs?: number
}

export interface EnglishSourceAuditBatchCue extends EnglishSourceAuditCue {
  role: 'main' | 'context'
}

export interface EnglishSourceAuditBatch {
  id: string
  mainCues: EnglishSourceAuditCue[]
  cues: EnglishSourceAuditBatchCue[]
}

export interface EnglishSourceAuditMetadata {
  title?: string
  channel?: string
  description?: string
}

export const EnglishSourceAuditPatchSchema = z.object({
  cueId: z.number().int().positive(),
  before: z.string().min(1),
  after: z.string(),
  reason: z.string().trim().min(1),
  confidence: z.enum(['high', 'ambiguous'])
}).strict()

export const EnglishSourceAuditResultSchema = z.object({
  patches: z.array(EnglishSourceAuditPatchSchema)
}).strict()

export type EnglishSourceAuditResult = z.infer<typeof EnglishSourceAuditResultSchema>
export type EnglishSourceAuditPatch = EnglishSourceAuditResult['patches'][number]

export function partitionEnglishSourceAuditCues(
  cues: readonly EnglishSourceAuditCue[],
  contextRadius = ENGLISH_SOURCE_AUDIT_CONTEXT_RADIUS
): EnglishSourceAuditBatch[] {
  if (!Number.isInteger(contextRadius) || contextRadius < 0) {
    throw new Error('英文源字幕审计上下文半径必须是非负整数')
  }
  const seen = new Set<number>()
  for (const cue of cues) {
    if (!Number.isInteger(cue.id) || cue.id <= 0) throw new Error(`英文源字幕 cue ID 无效：${cue.id}`)
    if (seen.has(cue.id)) throw new Error(`英文源字幕 cue ID 重复：${cue.id}`)
    seen.add(cue.id)
  }

  const batches: EnglishSourceAuditBatch[] = []
  for (let offset = 0; offset < cues.length; offset += ENGLISH_SOURCE_AUDIT_MAIN_CUE_COUNT) {
    const mainEnd = Math.min(offset + ENGLISH_SOURCE_AUDIT_MAIN_CUE_COUNT, cues.length)
    const contextStart = Math.max(0, offset - contextRadius)
    const contextEnd = Math.min(cues.length, mainEnd + contextRadius)
    const mainCues = cues.slice(offset, mainEnd).map((cue) => ({ ...cue }))
    const batchCues = cues.slice(contextStart, contextEnd).map((cue, index) => {
      const absoluteIndex = contextStart + index
      return { ...cue, role: absoluteIndex >= offset && absoluteIndex < mainEnd ? 'main' as const : 'context' as const }
    })
    batches.push({
      id: `english-audit-${String(batches.length + 1).padStart(3, '0')}`,
      mainCues,
      cues: batchCues
    })
  }
  return batches
}

function promptMetadata(metadata: EnglishSourceAuditMetadata): EnglishSourceAuditMetadata {
  return {
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.channel ? { channel: metadata.channel } : {}),
    ...(metadata.description ? { description: metadata.description } : {})
  }
}

export function englishSourceAuditPrompt(
  batch: EnglishSourceAuditBatch,
  metadata: EnglishSourceAuditMetadata = {}
): string {
  return guardedPrompt(
    '你正在稀疏审计英文源字幕的 ASR 准确性。只修复确有证据的英文识别错误，不做翻译。',
    '允许修复的范围仅限：技术专名、产品/API/库/框架/命令/flag/代码标识，以及上下文可明确判定的 ASR 同音词或明显语义损坏。',
    '禁止润色口语、改写表达、补全说话者未说的内容、纠正一般语法、合并或拆分 cue，也不得修改时间、cue ID 或顺序。没有必要修改时返回空 patches。',
    '本步骤是纯文本审计：不得调用工具、联网、读取工作目录或修改文件。文本证据不足时标为 ambiguous，交给人工结合视频确认，不得猜测。',
    `不可信 metadata（JSON）：\n${untrustedJsonSection('english-audit-metadata', promptMetadata(metadata))}`,
    '输入中 role=main 的 cue 才允许产生 patch；role=context 仅用于理解相邻语境，严禁为其产生 patch。',
    '每个 patch 必须给出主 cue 的完整原文 before 和修正后的完整单行 after，不得只给变化片段。before 必须逐字复制输入；after 必须非空、无 Tab/换行/首尾空白，且必须与 before 不同。',
    '只输出一个 JSON 对象，不要 Markdown、解释或额外字段：{"patches":[{"cueId":1,"before":"完整原文","after":"完整修正文","reason":"依据","confidence":"high|ambiguous"}]}。同一 cue 最多一个 patch。',
    `批次 ${batch.id}（不可信 JSON）：\n${untrustedJsonSection('english-audit-cues', batch.cues)}`
  )
}

export function englishSourceAuditRepairPrompt(
  batch: EnglishSourceAuditBatch,
  metadata: EnglishSourceAuditMetadata,
  failure: string
): string {
  return guardedPrompt(
    `上一条英文源字幕审计回复未通过本地校验，错误详情位于不可信 JSON section：\n${untrustedJsonSection('english-audit-validation-failure', failure.slice(0, VALIDATION_FAILURE_PROMPT_LIMIT))}`,
    `请重新发送完整 ${batch.id} JSON 对象；不要只补充错误项，不要输出 Markdown。`,
    englishSourceAuditPrompt(batch, metadata)
  )
}

export function parseEnglishSourceAuditResult(batch: EnglishSourceAuditBatch, text: string): EnglishSourceAuditResult {
  let raw: unknown
  try {
    raw = JSON.parse(text.trim())
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${batch.id} 英文源字幕审计 JSON 无效：${detail}`)
  }

  let result: EnglishSourceAuditResult
  try {
    result = EnglishSourceAuditResultSchema.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${batch.id} 英文源字幕审计结构无效：${detail}`)
  }

  const mainById = new Map(batch.mainCues.map((cue) => [cue.id, cue]))
  const batchCueIds = new Set(batch.cues.map((cue) => cue.id))
  const patched = new Set<number>()
  for (const patch of result.patches) {
    if (patched.has(patch.cueId)) throw new Error(`${batch.id} cue ${patch.cueId} patch 重复`)
    patched.add(patch.cueId)

    const cue = mainById.get(patch.cueId)
    if (!cue) {
      const detail = batchCueIds.has(patch.cueId) ? '是只读上下文 cue' : '不存在于本批次'
      throw new Error(`${batch.id} cue ${patch.cueId} 不可修改：${detail}`)
    }
    if (patch.before !== cue.text) throw new Error(`${batch.id} cue ${patch.cueId} before 与完整原文不一致`)
    if (!patch.after.trim()) throw new Error(`${batch.id} cue ${patch.cueId} after 为空`)
    if (/[\t\r\n]/u.test(patch.after)) throw new Error(`${batch.id} cue ${patch.cueId} after 不能包含 Tab 或换行`)
    if (patch.after !== patch.after.trim()) throw new Error(`${batch.id} cue ${patch.cueId} after 不能有首尾空白`)
    if (patch.after === patch.before) throw new Error(`${batch.id} cue ${patch.cueId} before 与 after 相同`)
  }
  const sparseLimit = Math.min(
    ENGLISH_SOURCE_AUDIT_MAX_PATCHES,
    Math.max(1, Math.ceil(batch.mainCues.length * 0.1))
  )
  if (result.patches.length > sparseLimit) {
    throw new Error(`${batch.id} patch 数 ${result.patches.length} 超过稀疏审计上限 ${sparseLimit}`)
  }
  return {
    patches: result.patches.map((patch) => highConfidencePatchIsSafe(patch)
      ? patch
      : {
          ...patch,
          confidence: 'ambiguous' as const,
          reason: `本地安全门仅允许自动应用不改变字符内容的大小写正规化；${patch.reason}`
        })
  }
}

function normalizedSurface(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function highConfidencePatchIsSafe(patch: EnglishSourceAuditPatch): boolean {
  if (patch.confidence !== 'high') return true
  if (/\p{Script=Han}/u.test(patch.after) || !/[A-Za-z]/u.test(patch.after)) return false
  if (controlMarkers(patch.before).join('\0') !== controlMarkers(patch.after).join('\0')) return false
  return patch.before.normalize('NFKC').toLocaleLowerCase('en-US')
    === patch.after.normalize('NFKC').toLocaleLowerCase('en-US')
}

function controlMarkers(value: string): string[] {
  return [...value.matchAll(/(?:[\p{Cc}\p{Cf}]|\{\\[^}]*\}|<\/?[A-Za-z][^>]*>)/gu)].map((match) => match[0])
}

interface TokenSpan {
  normalized: string
  start: number
  end: number
}

function tokenSpans(value: string): TokenSpan[] {
  return [...value.matchAll(/[\p{L}\p{N}_./:+#-]+/gu)].map((match) => ({
    normalized: match[0].normalize('NFKC').toLocaleLowerCase('en-US'),
    start: match.index,
    end: match.index + match[0].length
  }))
}

function normalizedTokens(value: string): string[] {
  return tokenSpans(value).map((token) => token.normalized)
}

function changedTokenSpan(patch: EnglishSourceAuditPatch): {
  source: string[]
  target: string[]
  sourceText: string
  targetText: string
  sourcePrefix: string
  targetPrefix: string
  sourceSuffix: string
  targetSuffix: string
} | undefined {
  const beforeSpans = tokenSpans(patch.before)
  const afterSpans = tokenSpans(patch.after)
  const before = beforeSpans.map((token) => token.normalized)
  const after = afterSpans.map((token) => token.normalized)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1
  const source = before.slice(prefix, before.length - suffix)
  const target = after.slice(prefix, after.length - suffix)
  if (!source.length || !target.length || source.join('').length < 4) return undefined
  const sourceSpans = beforeSpans.slice(prefix, before.length - suffix)
  const targetSpans = afterSpans.slice(prefix, after.length - suffix)
  return {
    source,
    target,
    sourceText: patch.before.slice(sourceSpans[0].start, sourceSpans.at(-1)!.end),
    targetText: patch.after.slice(targetSpans[0].start, targetSpans.at(-1)!.end),
    sourcePrefix: patch.before.slice(0, sourceSpans[0].start),
    targetPrefix: patch.after.slice(0, targetSpans[0].start),
    sourceSuffix: patch.before.slice(sourceSpans.at(-1)!.end),
    targetSuffix: patch.after.slice(targetSpans.at(-1)!.end)
  }
}

function containsTokenSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false
  return haystack.some((_, index) => needle.every((token, offset) => haystack[index + offset] === token))
}

function replaceTokenSequence(value: string, source: readonly string[], replacement: string): string {
  const tokens = tokenSpans(value)
  let cursor = 0
  let output = ''
  for (let index = 0; index <= tokens.length - source.length;) {
    if (!source.every((token, offset) => tokens[index + offset].normalized === token)) {
      index += 1
      continue
    }
    output += value.slice(cursor, tokens[index].start) + replacement
    cursor = tokens[index + source.length - 1].end
    index += source.length
  }
  return cursor ? output + value.slice(cursor) : value
}

export function reconcileEnglishSourceAuditPatches(
  patches: readonly EnglishSourceAuditPatch[],
  allCues: readonly EnglishSourceAuditCue[] = []
): EnglishSourceAuditPatch[] {
  const bySurface = new Map<string, EnglishSourceAuditPatch[]>()
  for (const patch of patches) {
    const key = normalizedSurface(patch.before)
    const group = bySurface.get(key) ?? []
    group.push(patch)
    bySurface.set(key, group)
  }
  const conflicted = new Set<string>()
  for (const [surface, group] of bySurface) {
    const targets = new Set(group.map((patch) => normalizedSurface(patch.after)))
    if (targets.size > 1 || group.some((patch) => patch.confidence === 'ambiguous')) conflicted.add(surface)
  }

  const tokenGroups = new Map<string, {
    source: string[]
    targets: Map<string, string>
    cueIds: Set<number>
    uncertain: boolean
  }>()
  for (const patch of patches) {
    const span = changedTokenSpan(patch)
    if (!span) continue
    const key = span.source.join(' ')
    const group = tokenGroups.get(key) ?? { source: span.source, targets: new Map<string, string>(), cueIds: new Set<number>(), uncertain: false }
    group.targets.set(span.target.join(' '), span.targetText)
    group.cueIds.add(patch.cueId)
    group.uncertain ||= patch.confidence === 'ambiguous'
    tokenGroups.set(key, group)
  }
  const conflictedTokens = new Set<string>()
  const missedOccurrences = new Map<string, EnglishSourceAuditCue[]>()
  for (const [key, group] of tokenGroups) {
    const missed = allCues.filter((cue) =>
      !group.cueIds.has(cue.id) && containsTokenSequence(normalizedTokens(cue.text), group.source)
    )
    missedOccurrences.set(key, missed)
    if (group.targets.size > 1 || group.uncertain || missed.length) conflictedTokens.add(key)
  }

  const reconciled = new Map(patches.map((patch) => [patch.cueId, { ...patch }]))
  for (const patch of reconciled.values()) {
    const tokenKey = changedTokenSpan(patch)?.source.join(' ')
    if (conflicted.has(normalizedSurface(patch.before)) || (tokenKey ? conflictedTokens.has(tokenKey) : false)) {
      Object.assign(patch, {
        confidence: 'ambiguous' as const,
        reason: `同一英文词或短语在全片审计中存在冲突、不确定建议或未审计引用；${patch.reason}`
      })
    }
  }

  for (const [key, group] of tokenGroups) {
    if (group.targets.size !== 1) continue
    const replacement = group.targets.values().next().value as string
    for (const cue of missedOccurrences.get(key) ?? []) {
      const existing = reconciled.get(cue.id)
      const after = replaceTokenSequence(existing?.after ?? cue.text, group.source, replacement)
      if (after === (existing?.after ?? cue.text)) {
        if (existing) {
          existing.confidence = 'ambiguous'
          existing.reason = `同一 cue 涉及多个相互覆盖的英文修正，需要人工统一；${existing.reason}`
        }
        continue
      }
      reconciled.set(cue.id, existing
        ? {
            ...existing,
            after,
            confidence: 'ambiguous',
            reason: `同一 cue 还引用了全片待统一的英文词或短语；${existing.reason}`
          }
        : {
            cueId: cue.id,
            before: cue.text,
            after,
            confidence: 'ambiguous',
            reason: '同一英文词或短语在其他 cue 被建议修正；请结合画面确认并一次性统一全部引用'
          })
    }
  }

  return [...reconciled.values()].sort((left, right) => left.cueId - right.cueId)
}
