import { z } from 'zod'
import { BilibiliPublicationSchema } from './bilibili'

export const STAGE_IDS = [
  'source',
  'inspect',
  'english',
  'cues',
  'translate',
  'audit',
  'review',
  'srt',
  'burn',
  'verify',
  'digest',
  'summary',
  'illustrate'
] as const

export const StageIdSchema = z.enum(STAGE_IDS)
export type StageId = z.infer<typeof StageIdSchema>

export const TaskKindSchema = z.enum(['subtitle', 'summary'])
export type TaskKind = z.infer<typeof TaskKindSchema>

// 字幕任务与总结任务共用同一条阶段序列；不属于本类型的阶段在创建时就写成 skipped。
export const SUBTITLE_ONLY_STAGES = ['translate', 'audit', 'review', 'srt', 'burn', 'verify'] as const
export const SUMMARY_ONLY_STAGES = ['digest', 'summary', 'illustrate'] as const

export function stageBelongsToKind(stage: StageId, kind: TaskKind): boolean {
  if ((SUBTITLE_ONLY_STAGES as readonly string[]).includes(stage)) return kind === 'subtitle'
  if ((SUMMARY_ONLY_STAGES as readonly string[]).includes(stage)) return kind === 'summary'
  return true
}

export function lastStageForKind(kind: TaskKind): StageId {
  return [...STAGE_IDS].reverse().find((stage) => stageBelongsToKind(stage, kind))!
}

export const StageStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'checkpoint',
  'paused',
  'failed',
  'completed',
  'stale',
  'skipped'
])

export const StepLeaseSchema = z.object({
  runId: z.string().uuid(),
  stage: StageIdSchema,
  manifestRevision: z.number().int().nonnegative(),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  acquiredAt: z.string().datetime({ offset: true })
})
export type StepLease = z.infer<typeof StepLeaseSchema>

export const StageStateSchema = z.object({
  status: StageStatusSchema.default('pending'),
  attempt: z.number().int().nonnegative().default(0),
  progress: z.number().min(0).max(1).optional(),
  errorCode: z.string().optional(),
  checkpointId: z.string().optional(),
  activeLease: StepLeaseSchema.optional()
})

export const ArtifactSchema = z.object({
  relativePath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  valid: z.boolean(),
  producer: z.string().min(1),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
})

export const ProviderIdSchema = z.enum(['claude', 'codex', 'qoder', 'opencode'])
export type ProviderId = z.infer<typeof ProviderIdSchema>
export const SubtitlePresetSchema = z.enum(['compact', 'standard', 'large'])
export type SubtitlePreset = z.infer<typeof SubtitlePresetSchema>

export const ModelSelectionSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('cli-default') }),
  z.object({ source: z.literal('discovered'), modelId: z.string().trim().min(1) }),
  z.object({ source: z.literal('user-entered'), modelId: z.string().trim().min(1) })
])
export type ModelSelection = z.infer<typeof ModelSelectionSchema>

export const SessionGenerationSchema = z.object({
  id: z.string().uuid(),
  provider: ProviderIdSchema,
  model: ModelSelectionSchema,
  externalSessionId: z.string().min(1).optional(),
  cliVersion: z.string().min(1).optional(),
  stateRoot: z.string().min(1),
  status: z.enum(['active', 'closed', 'lost']),
  reason: z.enum(['initial', 'provider-switch', 'model-switch', 'resume-replacement']),
  createdAt: z.string().datetime({ offset: true }),
  closedAt: z.string().datetime({ offset: true }).optional()
})
export type SessionGeneration = z.infer<typeof SessionGenerationSchema>

const AuditAmbiguitySchema = z.object({
  cueId: z.number().int().positive(),
  en: z.string(),
  before: z.string(),
  recommended: z.string(),
  reason: z.string().min(1),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().positive().optional()
}).superRefine((value, context) => {
  if ((value.startMs === undefined) !== (value.endMs === undefined)) {
    context.addIssue({ code: 'custom', message: '字幕时间码必须同时包含开始和结束时间' })
  } else if (value.startMs !== undefined && value.endMs !== undefined && value.endMs <= value.startMs) {
    context.addIssue({ code: 'custom', message: '字幕结束时间必须晚于开始时间' })
  }
})

export const TaskInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().url() }),
  z.object({ kind: z.literal('local'), sourcePath: z.string().min(1) })
])
export type TaskInput = z.infer<typeof TaskInputSchema>

export function taskInputName(input: TaskInput): string {
  return input.kind === 'url' ? input.url : input.sourcePath
}

export const SUMMARY_DRAFT_IDS = ['A', 'B', 'C'] as const
export const SummaryDraftIdSchema = z.enum(SUMMARY_DRAFT_IDS)
export const SUMMARY_SCORE_KEYS = ['factuality', 'completeness', 'structure', 'readability', 'conversation', 'finalComment'] as const
export const SUMMARY_SCORE_LABELS: Record<(typeof SUMMARY_SCORE_KEYS)[number], string> = {
  factuality: '事实保真',
  completeness: '信息完整',
  structure: '叙事结构',
  readability: '中文可读性',
  conversation: '对话感',
  finalComment: '最后评论'
}

const SummaryDraftEvidenceSchema = z.object({
  id: SummaryDraftIdSchema,
  title: z.string().trim().min(1).max(200),
  sections: z.array(z.string().trim().min(1).max(200)).min(3).max(40),
  length: z.number().int().positive(),
  opening: z.string().trim().min(1).max(1000),
  finalThesis: z.string().trim().min(1).max(1000),
  contributions: z.array(z.string().trim().min(1).max(500)).min(2).max(10)
})

const SummaryScoreSchema = z.object(
  Object.fromEntries(SUMMARY_SCORE_KEYS.map((key) => [key, z.number().min(0).max(10)])) as Record<
    (typeof SUMMARY_SCORE_KEYS)[number],
    z.ZodNumber
  >
)

export const SummaryDraftRecordSchema = z.object({
  analysisNote: z.string().trim().min(1).max(4000),
  drafts: z.array(SummaryDraftEvidenceSchema).length(3),
  scores: z.record(SummaryDraftIdSchema, SummaryScoreSchema),
  baseDraft: SummaryDraftIdSchema,
  baseReason: z.string().trim().min(1).max(2000),
  omissions: z.array(z.string().trim().min(1).max(1000)).max(60),
  omissionNote: z.string().trim().max(2000).default(''),
  selfCheck: z.string().trim().min(1).max(4000)
})
export type SummaryDraftRecord = z.infer<typeof SummaryDraftRecordSchema>

export const SUMMARY_IMAGE_FILENAME = /^\d{2}-[a-z0-9][a-z0-9-]*\.png$/u
export const SummaryImagePlanEntrySchema = z.object({
  filename: z.string().regex(SUMMARY_IMAGE_FILENAME),
  alt: z.string().trim().min(1).max(200),
  anchor: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(40).max(4000)
})
export type SummaryImagePlanEntry = z.infer<typeof SummaryImagePlanEntrySchema>

// 配图产物的 artifact key；renderer 与主进程必须用同一个推导规则。
export function summaryImageArtifactKey(filename: string): string {
  return `summaryImage:${filename}`
}

export const IllustrationPhaseSchema = z.enum(['agent-pending', 'cover-review', 'rest', 'done', 'skipped'])
export type IllustrationPhase = z.infer<typeof IllustrationPhaseSchema>

const IllustrationSchema = z.object({
  phase: IllustrationPhaseSchema.default('agent-pending'),
  provider: ProviderIdSchema.optional(),
  model: ModelSelectionSchema.optional(),
  planned: z.array(SummaryImagePlanEntrySchema).max(12).default([]),
  generated: z.array(z.string().regex(SUMMARY_IMAGE_FILENAME)).max(12).default([]),
  pending: z.array(z.object({
    filename: z.string().regex(SUMMARY_IMAGE_FILENAME),
    reason: z.string().trim().min(1).max(300)
  })).max(12).default([]),
  coverAcceptedAt: z.string().datetime({ offset: true }).optional()
})

const SummaryStateSchema = z.object({
  digestSegments: z.number().int().nonnegative().default(0),
  draftRecord: SummaryDraftRecordSchema.optional(),
  illustration: IllustrationSchema.default({ phase: 'agent-pending', planned: [], generated: [], pending: [] })
})
export type SummaryState = z.infer<typeof SummaryStateSchema>

const DEFAULT_SUMMARY_STATE = {
  digestSegments: 0,
  illustration: { phase: 'agent-pending' as const, planned: [], generated: [], pending: [] }
}

const TaskManifestV3Schema = z.object({
  schemaVersion: z.literal(3),
  revision: z.number().int().nonnegative(),
  taskId: z.string().uuid(),
  kind: TaskKindSchema.default('subtitle'),
  title: z.string(),
  taskDir: z.literal('.'),
  input: TaskInputSchema,
  render: z.object({ subtitlePreset: SubtitlePresetSchema.default('standard') }).default({ subtitlePreset: 'standard' }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  pipeline: z.object({ stages: z.record(z.string(), StageStateSchema) }),
  artifacts: z.record(z.string(), ArtifactSchema).default({}),
  translation: z.object({
    styleNote: z.string().trim().max(1000).default(''),
    selectedProvider: ProviderIdSchema.optional(),
    selectedModel: ModelSelectionSchema.optional(),
    activeGenerationId: z.string().uuid().optional(),
    sessionGenerations: z.array(SessionGenerationSchema).default([]),
    auditDecisions: z.array(z.object({ cueId: z.number().int().positive(), translation: z.string(), resolvedAt: z.string().datetime({ offset: true }) })).default([]),
    manualEdits: z.array(z.object({
      cueId: z.number().int().positive(),
      translation: z.string().trim().min(1).max(2000),
      englishCueHash: z.string().regex(/^[a-f0-9]{64}$/),
      updatedAt: z.string().datetime({ offset: true })
    })).default([]),
    auditCheckpoint: z.object({ ambiguities: z.array(AuditAmbiguitySchema).min(1) }).optional(),
    batches: z.array(z.object({
      id: z.string().min(1),
      startCue: z.number().int().positive(),
      endCue: z.number().int().positive(),
      inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      status: z.enum(['pending', 'running', 'verified', 'failed', 'stale'])
    })).default([])
  }).default({ styleNote: '', sessionGenerations: [], auditDecisions: [], manualEdits: [], batches: [] }),
  runtime: z.object({
    currentMessage: z.string().default('等待开始'),
    userPaused: z.boolean().default(false),
    videoId: z.string().optional(),
    uploadDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    durationSeconds: z.number().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    subtitleKind: z.enum(['manual', 'automatic', 'whisper']).optional(),
    finalRelativePath: z.string().optional(),
    completedAt: z.string().datetime({ offset: true }).optional()
  }).default({ currentMessage: '等待开始', userPaused: false }),
  publication: BilibiliPublicationSchema,
  summary: SummaryStateSchema.default(DEFAULT_SUMMARY_STATE),
  identityConflict: z.boolean().default(false)
})

function stagesForKind(kind: TaskKind, existing: Record<string, unknown> = {}): Record<string, unknown> {
  const stages = { ...existing }
  for (const stage of STAGE_IDS) {
    if (stages[stage]) continue
    stages[stage] = { status: stageBelongsToKind(stage, kind) ? 'pending' : 'skipped', attempt: 0 }
  }
  return stages
}

export const TaskManifestSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  let value = raw as Record<string, unknown>
  if (value.schemaVersion === 1) {
    value = { ...value, schemaVersion: 2, publication: { autoPublish: false, status: 'idle', attempt: 0 } }
  }
  if (value.schemaVersion === 2) {
    value = { ...value, schemaVersion: 3, kind: 'subtitle', summary: DEFAULT_SUMMARY_STATE }
  }
  // 旧 manifest 没有新阶段条目；缺阶段会让流水线把它当成待执行，所以必须补齐。
  const kind = value.kind === 'summary' ? 'summary' : 'subtitle'
  const pipeline = value.pipeline
  if (pipeline && typeof pipeline === 'object' && !Array.isArray(pipeline)) {
    const stages = (pipeline as Record<string, unknown>).stages
    if (stages && typeof stages === 'object' && !Array.isArray(stages)) {
      value = { ...value, pipeline: { ...pipeline, stages: stagesForKind(kind, stages as Record<string, unknown>) } }
    }
  }
  return value
}, TaskManifestV3Schema)
export type TaskManifest = z.infer<typeof TaskManifestSchema>

export function createTaskManifest(
  input: z.input<typeof TaskInputSchema>,
  title = '',
  provider?: ProviderId,
  styleNote = '',
  subtitlePreset: SubtitlePreset = 'standard',
  autoPublish = false,
  kind: TaskKind = 'subtitle'
): TaskManifest {
  const now = new Date().toISOString()
  const parsedInput = TaskInputSchema.parse(input)
  const stages = stagesForKind(kind)
  stages.source = { status: 'ready', attempt: 0 }
  return TaskManifestSchema.parse({
    schemaVersion: 3,
    revision: 0,
    taskId: globalThis.crypto.randomUUID(),
    kind,
    title: title.trim() || taskInputName(parsedInput),
    taskDir: '.',
    input: parsedInput,
    render: { subtitlePreset },
    createdAt: now,
    updatedAt: now,
    pipeline: { stages },
    artifacts: {},
    translation: { styleNote, selectedProvider: provider, selectedModel: { source: 'cli-default' }, sessionGenerations: [], batches: [] },
    runtime: { currentMessage: '等待开始', userPaused: false },
    publication: { autoPublish: kind === 'summary' ? false : autoPublish, status: 'idle', attempt: 0 },
    summary: DEFAULT_SUMMARY_STATE,
    identityConflict: false
  })
}

export function migrateTaskManifest(raw: unknown): TaskManifest {
  const manifest = TaskManifestSchema.parse(raw)
  if (!manifest.title.trim()) manifest.title = taskInputName(manifest.input)
  for (const state of Object.values(manifest.pipeline.stages)) {
    if (!['completed', 'skipped'].includes(state.status)) continue
    delete state.errorCode
    delete state.checkpointId
    delete state.activeLease
  }
  return manifest
}
