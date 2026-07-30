import { describe, expect, it } from 'vitest'
import { ResolveAuditSchema } from '../src/shared/ipc'
import { TaskManifestSchema, createTaskManifest } from '../src/shared/task-schema'

function manifestWithAmbiguity(ambiguity: Record<string, unknown>): unknown {
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/audit' }, '', 'codex')
  manifest.translation.auditCheckpoint = {
    ambiguities: [ambiguity as NonNullable<typeof manifest.translation.auditCheckpoint>['ambiguities'][number]],
  }
  return manifest
}

describe('audit IPC schemas', () => {
  it('keeps legacy audit ambiguities valid while accepting a complete cue time range', () => {
    const legacy = TaskManifestSchema.parse(manifestWithAmbiguity({
      cueId: 1,
      en: 'Legacy cue.',
      before: '旧字幕。',
      recommended: '新字幕。',
      reason: '待核对',
    }))
    expect(legacy.translation.auditCheckpoint?.ambiguities[0]).not.toHaveProperty('startMs')

    const timed = TaskManifestSchema.parse(manifestWithAmbiguity({
      cueId: 2,
      en: 'Timed cue.',
      before: 'Cloud Code.',
      recommended: 'Claude Code.',
      reason: '技术名称待核对',
      startMs: 3_250,
      endMs: 5_500,
    }))
    expect(timed.translation.auditCheckpoint?.ambiguities[0]).toMatchObject({ startMs: 3_250, endMs: 5_500 })
  })

  it('rejects partial or reversed audit cue time ranges', () => {
    expect(TaskManifestSchema.safeParse(manifestWithAmbiguity({
      cueId: 1,
      en: 'Cue.',
      before: 'Before.',
      recommended: 'After.',
      reason: '待核对',
      startMs: 1_000,
    })).success).toBe(false)
    expect(TaskManifestSchema.safeParse(manifestWithAmbiguity({
      cueId: 1,
      en: 'Cue.',
      before: 'Before.',
      recommended: 'After.',
      reason: '待核对',
      startMs: 2_000,
      endMs: 2_000,
    })).success).toBe(false)
  })

  it('normalizes safe audit decisions and rejects duplicate IDs or invalid text', () => {
    const taskId = crypto.randomUUID()
    expect(ResolveAuditSchema.parse({ taskId, decisions: [{ cueId: 1, translation: '  Claude Code  ' }] }).decisions)
      .toEqual([{ cueId: 1, translation: 'Claude Code' }])

    for (const decisions of [
      [{ cueId: 1, translation: 'A' }, { cueId: 1, translation: 'B' }],
      [{ cueId: 1, translation: '   ' }],
      [{ cueId: 1, translation: 'line one\nline two' }],
      [{ cueId: 1, translation: 'x'.repeat(2001) }],
    ]) {
      expect(ResolveAuditSchema.safeParse({ taskId, decisions }).success).toBe(false)
    }
  })
})
