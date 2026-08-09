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
const SUMMARY_ONLY = ['digest', 'research', 'summary', 'illustrate'] as const
const DOCUMENT_STAGES = ['source', 'inspect', 'translate', 'review', 'verify'] as const

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
      expect(stageBelongsToKind(stage, 'subtitle') || stageBelongsToKind(stage, 'summary') || stageBelongsToKind(stage, 'document')).toBe(true)
    }
    expect(lastStageForKind('subtitle')).toBe('verify')
    expect(lastStageForKind('summary')).toBe('illustrate')
    expect(lastStageForKind('document')).toBe('verify')
  })

  it('网页翻译只启用五个文档阶段且禁止投稿', () => {
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/article' }, '', 'codex', '', 'standard', true, 'document', '', 'convert')
    expect(manifest.kind).toBe('document')
    expect(manifest.document.processingMode).toBe('convert')
    expect(manifest.publication.autoPublish).toBe(false)
    for (const stage of STAGE_IDS) {
      expect(manifest.pipeline.stages[stage].status === 'skipped').toBe(!DOCUMENT_STAGES.includes(stage as (typeof DOCUMENT_STAGES)[number]))
    }
    expect(manifest.pipeline.stages.source.status).toBe('ready')
  })
})

describe('manifest v2 → v6 迁移', () => {
  it('补齐 kind、summary、research、lineage、document 块与缺失的新阶段条目', () => {
    const current = createTaskManifest({ kind: 'url', url: 'https://example.com/video' })
    const legacy = structuredClone(current) as unknown as Record<string, unknown>
    legacy.schemaVersion = 2
    delete legacy.kind
    delete legacy.summary
    const stages = { ...(legacy.pipeline as { stages: Record<string, unknown> }).stages }
    for (const stage of SUMMARY_ONLY) delete stages[stage]
    legacy.pipeline = { stages }

    const migrated = migrateTaskManifest(legacy)

    expect(migrated.schemaVersion).toBe(6)
    expect(migrated.kind).toBe('subtitle')
    expect(migrated.lineage).toEqual({ rootTaskId: migrated.taskId })
    expect(migrated.summary.illustration.phase).toBe('agent-pending')
    expect(migrated.summary.illustration.planned).toEqual([])
    expect(migrated.summary.research).toMatchObject({ status: 'skipped', claims: [], queryCount: 0 })
    expect(migrated.document).toMatchObject({
      workflowVersion: 1,
      processingMode: 'auto',
      translationMode: 'legacy-direct',
      targetLanguage: 'zh-CN',
      blockCount: 0,
      translatedBlockCount: 0,
      warnings: []
    })
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

  it('v5 总结任务在 digest 完成后插入 research，并把 summary 退回 pending', () => {
    const legacy = structuredClone(createTaskManifest(
      { kind: 'url', url: 'https://example.com/video' },
      '', 'codex', '', 'standard', false, 'summary'
    )) as unknown as Record<string, unknown>
    legacy.schemaVersion = 5
    delete legacy.video
    const pipeline = legacy.pipeline as { stages: Record<string, { status: string }> }
    delete pipeline.stages.research
    pipeline.stages.digest.status = 'completed'
    pipeline.stages.summary.status = 'ready'

    const migrated = migrateTaskManifest(legacy)

    expect(migrated.pipeline.stages.research.status).toBe('ready')
    expect(migrated.pipeline.stages.summary.status).toBe('pending')
    expect(migrated.summary.research).toMatchObject({ status: 'idle', claims: [], queryCount: 0 })
  })

  it('已开始写作的 v5 总结任务跳过 research，保持旧合同可读', () => {
    const legacy = structuredClone(createTaskManifest(
      { kind: 'url', url: 'https://example.com/video' },
      '', 'codex', '', 'standard', false, 'summary'
    )) as unknown as Record<string, unknown>
    legacy.schemaVersion = 5
    delete legacy.video
    const pipeline = legacy.pipeline as { stages: Record<string, { status: string }> }
    delete pipeline.stages.research
    pipeline.stages.digest.status = 'completed'
    pipeline.stages.summary.status = 'completed'

    const migrated = migrateTaskManifest(legacy)

    expect(migrated.pipeline.stages.research.status).toBe('skipped')
    expect(migrated.pipeline.stages.summary.status).toBe('completed')
    expect(migrated.summary.research.status).toBe('skipped')
    expect(migrated.summary.research.limitations).toContain('旧任务沿用原总结合同，未补跑外部核验')
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
