import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyCueEdits, dedupeRolling, extractCueTsv, mergeBilingual, parseSrt, serializeSrt, stripSpeakerMarkers } from '../src/core/srt'

const fixture = (name: string): string => readFileSync(resolve('fixtures/srt', name), 'utf8')

describe('SRT core', () => {
  it('parses blank lines after timing and flattens multiline cues', () => {
    const cues = parseSrt(fixture('manual-with-gap.srt'))
    expect(cues).toHaveLength(2)
    expect(extractCueTsv(cues)).toBe('1\tHello there.\n2\tThis cue has two lines.\n')
    expect(parseSrt(serializeSrt(cues))).toEqual(cues)
  })

  it('matches the original rolling dedupe behavior', () => {
    const deduped = dedupeRolling(parseSrt(fixture('rolling.srt')))
    expect(deduped.map((cue) => cue.lines[0])).toEqual(['Hello', 'world', 'again'])
    expect(deduped.map((cue) => cue.endMs)).toEqual([10, 1010, 2010])
  })

  it('normalizes rolling caption overlaps to one active cue', () => {
    const deduped = dedupeRolling([
      { id: '1', startMs: 0, endMs: 4_000, lines: ['Redis'] },
      { id: '2', startMs: 1_500, endMs: 5_000, lines: ['Redis', 'and Valkey'] },
      { id: '3', startMs: 3_000, endMs: 6_000, lines: ['and Valkey', 'for caching'] }
    ])

    expect(deduped.map((cue) => cue.lines[0])).toEqual(['Redis', 'and Valkey', 'for caching'])
    expect(deduped.map((cue) => [cue.startMs, cue.endMs])).toEqual([
      [0, 1_450],
      [1_500, 2_950],
      [3_000, 6_000]
    ])
  })

  it('preserves a legitimate line that reappears after the rolling window', () => {
    const deduped = dedupeRolling([
      { id: '1', startMs: 0, endMs: 1_500, lines: ['Thank you'] },
      { id: '2', startMs: 1_500, endMs: 3_000, lines: ['for watching'] },
      { id: '3', startMs: 3_000, endMs: 4_500, lines: ['Thank you'] }
    ])

    expect(deduped.map((cue) => cue.lines[0])).toEqual(['Thank you', 'for watching', 'Thank you'])
  })

  it('preserves identical adjacent cues when a real time gap separates them', () => {
    const deduped = dedupeRolling([
      { id: '1', startMs: 0, endMs: 1_000, lines: ['Thank you'] },
      { id: '2', startMs: 5_000, endMs: 6_000, lines: ['Thank you'] }
    ])

    expect(deduped.map((cue) => cue.lines[0])).toEqual(['Thank you', 'Thank you'])
    expect(deduped.map((cue) => [cue.startMs, cue.endMs])).toEqual([[0, 1_000], [5_000, 6_000]])
  })

  it('coalesces distinct rolling text emitted at the same timestamp', () => {
    const deduped = dedupeRolling([
      { id: '1', startMs: 1_000, endMs: 2_000, lines: ['git clone'] },
      { id: '2', startMs: 1_000, endMs: 3_000, lines: ['the repository'] },
      { id: '3', startMs: 1_200, endMs: 4_000, lines: ['and install'] }
    ])

    expect(deduped.map((cue) => cue.lines[0])).toEqual(['git clone the repository', 'and install'])
    expect(deduped[0].endMs).toBe(1_150)
  })

  it('drops caption speaker markers before dedupe and translation', () => {
    const stripped = stripSpeakerMarkers([
      { id: '1', startMs: 0, endMs: 1_000, lines: ['>> Yep.'] },
      { id: '2', startMs: 1_000, endMs: 2_000, lines: ['&gt;&gt;&gt;No space here', '>> and a second speaker'] },
      { id: '3', startMs: 2_000, endMs: 3_000, lines: ['>>'] },
      { id: '4', startMs: 3_000, endMs: 4_000, lines: ['shift x >> 2 stays', '> a shell prompt stays'] }
    ])

    expect(stripped.map((cue) => cue.lines)).toEqual([
      ['Yep.'],
      ['No space here', 'and a second speaker'],
      ['shift x >> 2 stays', '> a shell prompt stays']
    ])
    expect(dedupeRolling(stripped).map((cue) => cue.lines[0])).toEqual([
      'Yep.',
      'No space here and a second speaker',
      'shift x >> 2 stays > a shell prompt stays'
    ])
  })

  it('requires exact bilingual cue coverage', () => {
    const english = parseSrt(fixture('manual-with-gap.srt'))
    const merged = mergeBilingual(english, '1\t你好。\n2\t这一条有两行。\n')
    expect(merged[0].lines).toEqual(['你好。', 'Hello there.'])
    expect(() => mergeBilingual(english, '1\t你好。\n')).toThrow('cue 数不一致')
  })

  it('applies manual translations without changing cue order', () => {
    expect(applyCueEdits('1\t你好。\n2\t旧译文。\n', [{ cueId: 2, translation: '新译文。' }])).toBe('1\t你好。\n2\t新译文。\n')
    expect(() => applyCueEdits('1\t你好。\n', [{ cueId: 2, translation: '不存在。' }])).toThrow('cue 不存在')
  })
})
