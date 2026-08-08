import { describe, expect, it } from 'vitest'
import {
  SUMMARY_IMAGE_FILENAME,
  SUMMARY_SCORE_KEYS,
  createTaskManifest,
  lastStageForKind,
  migrateTaskManifest,
  stageBelongsToKind,
  summaryImageArtifactKey,
  STAGE_IDS
} from '../src/shared/task-schema'

const SUBTITLE_ONLY = ['translate', 'audit', 'review', 'srt', 'burn', 'verify'] as const
const SUMMARY_ONLY = ['digest', 'summary', 'illustrate'] as const

describe('任务类型与阶段集合', () => {
  it('字幕任务把总结阶段直接标为 skipped', () => {
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' })
    expect(manifest.kind).toBe('subtitle')
    for (const stage of SUMMARY_ONLY) expect(manifest.pipeline.stages[stage].status).toBe('skipped')
    expect(manifest.pipeline.stages.translate.status).toBe('pending')
    expect(manifest.pipeline.stages.source.status).toBe('ready')
  })

  it('总结任务跳过翻译、压制与投稿相关阶段', () => {
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'qoder', '', 'standard', true, 'summary')
    expect(manifest.kind).toBe('summary')
    for (const stage of SUBTITLE_ONLY) expect(manifest.pipeline.stages[stage].status).toBe('skipped')
    for (const stage of SUMMARY_ONLY) expect(manifest.pipeline.stages[stage].status).toBe('pending')
    expect(manifest.publication.autoPublish).toBe(false)
  })

  it('每个阶段都能判定所属任务类型，最后一个阶段随类型变化', () => {
    for (const stage of STAGE_IDS) {
      expect(stageBelongsToKind(stage, 'subtitle') || stageBelongsToKind(stage, 'summary')).toBe(true)
    }
    expect(lastStageForKind('subtitle')).toBe('verify')
    expect(lastStageForKind('summary')).toBe('illustrate')
  })
})

describe('manifest v2 → v3 迁移', () => {
  it('补齐 kind、summary 块与缺失的新阶段条目', () => {
    const current = createTaskManifest({ kind: 'url', url: 'https://example.com/video' })
    const legacy = structuredClone(current) as unknown as Record<string, unknown>
    legacy.schemaVersion = 2
    delete legacy.kind
    delete legacy.summary
    const stages = { ...(legacy.pipeline as { stages: Record<string, unknown> }).stages }
    for (const stage of SUMMARY_ONLY) delete stages[stage]
    legacy.pipeline = { stages }

    const migrated = migrateTaskManifest(legacy)

    expect(migrated.schemaVersion).toBe(3)
    expect(migrated.kind).toBe('subtitle')
    expect(migrated.summary.illustration.phase).toBe('agent-pending')
    expect(migrated.summary.illustration.planned).toEqual([])
    // 缺阶段会让流水线把新阶段当成待执行，必须补成 skipped。
    for (const stage of SUMMARY_ONLY) expect(migrated.pipeline.stages[stage].status).toBe('skipped')
  })

  it('总结任务的缺失阶段按自己的类型补齐', () => {
    const current = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'qoder', '', 'standard', false, 'summary')
    const legacy = structuredClone(current) as unknown as Record<string, unknown>
    const stages = { ...(legacy.pipeline as { stages: Record<string, unknown> }).stages }
    delete stages.digest
    legacy.pipeline = { stages }

    const migrated = migrateTaskManifest(legacy)

    expect(migrated.pipeline.stages.digest.status).toBe('pending')
    expect(migrated.pipeline.stages.burn.status).toBe('skipped')
  })
})

describe('配图 schema 约束', () => {
  it('只接受 NN-slug.png 形式的配图文件名', () => {
    expect(SUMMARY_IMAGE_FILENAME.test('00-cover.png')).toBe(true)
    expect(SUMMARY_IMAGE_FILENAME.test('02-market-shift.png')).toBe(true)
    expect(SUMMARY_IMAGE_FILENAME.test('cover.png')).toBe(false)
    expect(SUMMARY_IMAGE_FILENAME.test('00-Cover.png')).toBe(false)
    expect(SUMMARY_IMAGE_FILENAME.test('../00-cover.png')).toBe(false)
    expect(SUMMARY_IMAGE_FILENAME.test('00-cover.jpg')).toBe(false)
  })

  it('artifact key 由文件名唯一推导', () => {
    expect(summaryImageArtifactKey('00-cover.png')).toBe('summaryImage:00-cover.png')
    expect(summaryImageArtifactKey('01-overview.png')).not.toBe(summaryImageArtifactKey('00-cover.png'))
  })

  it('评分表固定为六项', () => {
    expect([...SUMMARY_SCORE_KEYS]).toEqual(['factuality', 'completeness', 'structure', 'readability', 'conversation', 'finalComment'])
  })
})
