export interface SrtCue {
  id: string
  startMs: number
  endMs: number
  lines: string[]
}

const TIMING = /^(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)$/

function timeToMs(parts: readonly string[]): number {
  const [hours, minutes, seconds, milliseconds] = parts.map(Number)
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + milliseconds
}

function parseTiming(line: string): [number, number] | null {
  const match = TIMING.exec(line.trim())
  if (!match) return null
  const start = timeToMs(match.slice(1, 5))
  const end = timeToMs(match.slice(5, 9))
  return [start, end]
}

export function parseSrt(input: string): SrtCue[] {
  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/)
  const cues: SrtCue[] = []
  let index = 0

  while (index < lines.length) {
    while (index < lines.length && !lines[index].trim()) index += 1
    if (index >= lines.length) break
    const id = lines[index].trim()
    if (!/^\d+$/.test(id)) {
      index += 1
      continue
    }
    index += 1
    while (index < lines.length && !lines[index].trim()) index += 1
    const timing = index < lines.length ? parseTiming(lines[index]) : null
    if (!timing) continue
    index += 1
    const content: string[] = []
    while (index < lines.length) {
      const current = lines[index].trim()
      if (/^\d+$/.test(current) && index + 1 < lines.length && parseTiming(lines[index + 1])) break
      if (current) content.push(current)
      index += 1
    }
    if (content.length > 0) cues.push({ id, startMs: timing[0], endMs: timing[1], lines: content })
  }
  return cues
}

export function formatTimestamp(value: number): string {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`无效 SRT 时间：${value}`)
  const hours = Math.floor(value / 3_600_000)
  const minutes = Math.floor((value % 3_600_000) / 60_000)
  const seconds = Math.floor((value % 60_000) / 1_000)
  const milliseconds = value % 1_000
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`
}

export function serializeSrt(cues: readonly SrtCue[]): string {
  validateCues(cues)
  return `${cues.map((cue) => `${cue.id}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.lines.join('\n')}`).join('\n\n')}\n`
}

export function flattenCue(cue: SrtCue): string {
  return cue.lines.join(' ').replace(/\s+/g, ' ').trim()
}

// Caption sources mark a speaker change with `>>` at the start of a line (escaped as `&gt;&gt;` by
// some tracks). It is caption chrome, not speech, so it must not reach the translator or get burned
// into the frame. Only a line-leading run of two or more is a marker; `>>` inside a line can be
// real content in a programming talk.
const SPEAKER_MARKER = /^(?:>|&gt;){2,}\s*/u

export function stripSpeakerMarkers(cues: readonly SrtCue[]): SrtCue[] {
  return cues
    .map((cue) => ({ ...cue, lines: cue.lines.map((line) => line.replace(SPEAKER_MARKER, '').trim()).filter(Boolean) }))
    .filter((cue) => cue.lines.length > 0)
}

export function extractCueTsv(cues: readonly SrtCue[]): string {
  validateCues(cues)
  return `${cues.map((cue) => `${cue.id}\t${flattenCue(cue)}`).join('\n')}\n`
}

export function parseCueTsv(input: string, requireText = true): Map<string, string> {
  const result = new Map<string, string>()
  for (const [lineIndex, line] of input.split(/\r?\n/).entries()) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab < 1) throw new Error(`TSV 第 ${lineIndex + 1} 行缺少 tab`)
    const id = line.slice(0, tab).trim()
    const text = line.slice(tab + 1).trim()
    if (!/^\d+$/.test(id)) throw new Error(`TSV 第 ${lineIndex + 1} 行 ID 无效`)
    if (requireText && !text) throw new Error(`TSV 第 ${lineIndex + 1} 行译文为空`)
    if (result.has(id)) throw new Error(`TSV ID 重复：${id}`)
    result.set(id, text)
  }
  return result
}

export function applyCueEdits(input: string, edits: readonly { cueId: number; translation: string }[]): string {
  const cues = parseCueTsv(input)
  for (const edit of edits) {
    const id = String(edit.cueId)
    if (!cues.has(id)) throw new Error(`人工修改的 cue 不存在：${id}`)
    const translation = edit.translation.trim()
    if (!translation || /[\t\r\n]/u.test(translation)) throw new Error(`cue ${id} 的人工译文无效`)
    cues.set(id, translation)
  }
  return `${[...cues].map(([id, text]) => `${id}\t${text}`).join('\n')}\n`
}

export function dedupeRolling(cues: readonly SrtCue[]): SrtCue[] {
  let previousLines = new Set<string>()
  let previousRawEndMs: number | undefined
  const kept: SrtCue[] = []
  for (const cue of cues) {
    if (previousRawEndMs !== undefined && cue.startMs > previousRawEndMs + 1_000) previousLines = new Set()
    const lines = cue.lines.map((line) => line.trim()).filter(Boolean)
    const newLines = lines.filter((line) => !previousLines.has(line))
    previousLines = new Set(lines)
    previousRawEndMs = cue.endMs
    if (newLines.length === 0) continue
    const text = newLines.join(' ')
    const previous = kept.at(-1)
    if (previous && cue.startMs - previous.startMs <= 50) {
      previous.endMs = Math.max(previous.endMs, cue.endMs)
      previous.lines = [`${previous.lines[0]} ${text}`]
      continue
    }
    kept.push({ id: String(kept.length + 1), startMs: cue.startMs, endMs: cue.endMs, lines: [text] })
  }
  for (let index = 0; index < kept.length - 1; index += 1) {
    const latestNonOverlappingEnd = Math.max(kept[index].startMs + 1, kept[index + 1].startMs - 50)
    kept[index].endMs = Math.min(kept[index].endMs, latestNonOverlappingEnd)
  }
  return kept
}

export function mergeBilingual(english: readonly SrtCue[], chineseTsv: string): SrtCue[] {
  validateCues(english)
  const chinese = parseCueTsv(chineseTsv)
  const englishIds = new Set(english.map((cue) => cue.id))
  if (chinese.size !== english.length) throw new Error(`中英文 cue 数不一致：${chinese.size}/${english.length}`)
  for (const id of chinese.keys()) if (!englishIds.has(id)) throw new Error(`中文 cue ID 不存在：${id}`)
  return english.map((cue) => ({ ...cue, lines: [chinese.get(cue.id)!, flattenCue(cue)] }))
}

export function validateCues(cues: readonly SrtCue[]): void {
  const ids = new Set<string>()
  let previousStart = -1
  for (const cue of cues) {
    if (!/^\d+$/.test(cue.id)) throw new Error(`无效 cue ID：${cue.id}`)
    if (ids.has(cue.id)) throw new Error(`重复 cue ID：${cue.id}`)
    if (cue.startMs < previousStart) throw new Error(`时间轴非单调：${cue.id}`)
    if (cue.endMs <= cue.startMs) throw new Error(`cue 结束时间无效：${cue.id}`)
    if (cue.lines.length === 0 || cue.lines.every((line) => !line.trim())) throw new Error(`cue 内容为空：${cue.id}`)
    ids.add(cue.id)
    previousStart = cue.startMs
  }
}
