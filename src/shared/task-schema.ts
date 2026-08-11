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
  'research',
  'summary',
  'illustrate'
] as const

export const StageIdSchema = z.enum(STAGE_IDS)
export type StageId = z.infer<typeof StageIdSchema>

export const TaskKindSchema = z.enum(['subtitle', 'summary', 'document'])
export type TaskKind = z.infer<typeof TaskKindSchema>

// 视频的两种成果继续共享前四步；document 复用现有五个调度阶段，但执行独立的文档逻辑。
export const SHARED_STAGE_IDS = ['source', 'inspect', 'english', 'cues'] as const satisfies readonly StageId[]
export const SUBTITLE_ONLY_STAGES = ['translate', 'audit', 'review', 'srt', 'burn', 'verify'] as const
export const SUMMARY_ONLY_STAGES = ['digest', 'research', 'summary', 'illustrate'] as const
export const DOCUMENT_STAGE_IDS = ['source', 'inspect', 'translate', 'review', 'verify'] as const satisfies readonly StageId[]

export function stageBelongsToKind(stage: StageId, kind: TaskKind): boolean {
  if (kind === 'document') return (DOCUMENT_STAGE_IDS as readonly string[]).includes(stage)
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

export const MediaSourcePlatformSchema = z.enum(['youtube', 'generic'])
export type MediaSourcePlatform = z.infer<typeof MediaSourcePlatformSchema>

export const VideoCheckpointKindSchema = z.enum(['low-resolution', 'whisper-quality', 'large-translation'])
export type VideoCheckpointKind = z.infer<typeof VideoCheckpointKindSchema>

const VideoCheckpointSchema = z.object({
  kind: VideoCheckpointKindSchema,
  checkpointId: z.string().uuid(),
  stage: StageIdSchema,
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().trim().min(1).max(500),
  metrics: z.object({
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    cueCount: z.number().int().nonnegative().optional(),
    batchCount: z.number().int().nonnegative().optional(),
    musicRatio: z.number().min(0).max(1).optional(),
    uniqueTextRatio: z.number().min(0).max(1).optional(),
    latinCharacterCount: z.number().int().nonnegative().optional()
  }).default({}),
  createdAt: z.string().datetime({ offset: true })
})

const VideoCheckpointDecisionSchema = z.object({
  kind: VideoCheckpointKindSchema,
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['accept', 'retry', 'cancel']),
  resolvedAt: z.string().datetime({ offset: true })
})

const VideoWorkflowStateSchema = z.object({
  sourcePlatform: MediaSourcePlatformSchema.optional(),
  checkpoint: VideoCheckpointSchema.optional(),
  decisions: z.array(VideoCheckpointDecisionSchema).max(100).default([])
})

const DEFAULT_VIDEO_WORKFLOW_STATE = { decisions: [] as z.infer<typeof VideoCheckpointDecisionSchema>[] }

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
  contributions: z.array(z.string().trim().min(1).max(500)).min(2).max(10),
  digestRefs: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
  localIssues: z.array(z.string().trim().min(1).max(500)).max(100).default([])
})

const SummaryScoreSchema = z.object(
  Object.fromEntries(SUMMARY_SCORE_KEYS.map((key) => [key, z.number().min(0).max(10)])) as Record<
    (typeof SUMMARY_SCORE_KEYS)[number],
    z.ZodNumber
  >
)

export const SummaryDraftRecordSchema = z.object({
  contractVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  analysisNote: z.string().trim().min(1).max(4000),
  drafts: z.array(SummaryDraftEvidenceSchema).length(3),
  scores: z.record(SummaryDraftIdSchema, SummaryScoreSchema),
  scoreTotals: z.record(SummaryDraftIdSchema, z.number().nonnegative()).optional(),
  baseDraft: SummaryDraftIdSchema,
  baseReason: z.string().trim().min(1).max(2000),
  omissions: z.array(z.string().trim().min(1).max(1000)).max(60),
  omissionEvidence: z.array(z.object({
    digestId: z.string().trim().min(1).max(100),
    status: z.enum(['covered', 'omitted', 'not-applicable']),
    note: z.string().trim().min(1).max(1000)
  })).max(300).default([]),
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

export const SummaryResearchSourceSchema = z.object({
  url: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  }, '外部证据来源必须是 http 或 https 页面'),
  title: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(2000),
  publishedAt: z.string().trim().min(1).max(100).optional(),
  retrievedAt: z.string().datetime({ offset: true })
})

export const SummaryResearchClaimSchema = z.object({
  id: z.string().regex(/^R\d{2,3}$/),
  digestId: z.string().trim().min(1).max(100),
  claim: z.string().trim().min(1).max(2000),
  verdict: z.enum(['verified', 'contradicted', 'unresolved']),
  sources: z.array(SummaryResearchSourceSchema).max(10),
  note: z.string().trim().min(1).max(2000)
}).superRefine((value, context) => {
  if (value.verdict !== 'unresolved' && value.sources.length === 0) {
    context.addIssue({ code: 'custom', message: '已核验或矛盾的事实必须附外部来源' })
  }
})
export type SummaryResearchClaim = z.infer<typeof SummaryResearchClaimSchema>

const SummaryResearchSchema = z.object({
  status: z.enum(['idle', 'checkpoint', 'completed', 'skipped', 'unavailable']).default('idle'),
  claims: z.array(SummaryResearchClaimSchema).max(100).default([]),
  queryCount: z.number().int().nonnegative().default(0),
  limitations: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
  completedAt: z.string().datetime({ offset: true }).optional()
})

const SummaryStateSchema = z.object({
  digestSegments: z.number().int().nonnegative().default(0),
  draftRecord: SummaryDraftRecordSchema.optional(),
  research: SummaryResearchSchema.default({ status: 'idle', claims: [], queryCount: 0, limitations: [] }),
  illustration: IllustrationSchema.default({ phase: 'agent-pending', planned: [], generated: [], pending: [] })
})
export type SummaryState = z.infer<typeof SummaryStateSchema>

const DEFAULT_SUMMARY_STATE = {
  digestSegments: 0,
  research: { status: 'idle' as const, claims: [], queryCount: 0, limitations: [] as string[] },
  illustration: { phase: 'agent-pending' as const, planned: [], generated: [], pending: [] }
}

export const DocumentProcessingModeSchema = z.enum(['auto', 'convert', 'translate'])
export type DocumentProcessingMode = z.infer<typeof DocumentProcessingModeSchema>
export const DocumentTranslationModeSchema = z.enum(['legacy-direct', 'normal', 'refined'])
export type DocumentTranslationMode = z.infer<typeof DocumentTranslationModeSchema>
export const DocumentSourceSchema = z.enum(['web', 'x-post', 'x-article'])
export type DocumentSource = z.infer<typeof DocumentSourceSchema>

export const DocumentTranslationPhaseSchema = z.enum([
  'pending',
  'analyze',
  'plan',
  'draft',
  'critique',
  'revise',
  'polish',
  'done'
])
export type DocumentTranslationPhase = z.infer<typeof DocumentTranslationPhaseSchema>

const DocumentTranslationBatchSchema = z.object({
  id: z.string().min(1),
  blockIds: z.array(z.string().min(1)).min(1),
  fragmentIds: z.array(z.string().min(1)).default([]),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'running', 'verified', 'failed', 'stale']),
  attempt: z.number().int().nonnegative().default(0),
  artifactKey: z.string().min(1).optional(),
  artifact: ArtifactSchema.optional()
})

export const DocumentHtmlDirectionSchema = z.enum(['A', 'B', 'C', 'D'])
export type DocumentHtmlDirection = z.infer<typeof DocumentHtmlDirectionSchema>

const DocumentHtmlPublicationSchema = z.object({
  status: z.enum(['idle', 'running', 'checkpoint', 'failed', 'completed']).default('idle'),
  phase: z.enum(['route', 'preview', 'generate', 'verify', 'done']).default('route'),
  inputArtifactKey: z.enum(['sourceMarkdown', 'translatedMarkdown']).optional(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  templateId: z.string().trim().min(1).max(100).optional(),
  selectedDirection: DocumentHtmlDirectionSchema.optional(),
  publicationRunId: z.string().uuid().optional(),
  checkpointId: z.string().uuid().optional(),
  errorCode: z.string().trim().min(1).max(500).optional(),
  completedAt: z.string().datetime({ offset: true }).optional()
})

const DocumentStateSchema = z.object({
  workflowVersion: z.union([z.literal(1), z.literal(2)]).default(2),
  processingMode: DocumentProcessingModeSchema.default('auto'),
  resolvedAction: z.enum(['convert', 'translate']).optional(),
  translationMode: DocumentTranslationModeSchema.default('normal'),
  translationPhase: DocumentTranslationPhaseSchema.default('pending'),
  translationRunId: z.string().uuid().optional(),
  translationBatches: z.array(DocumentTranslationBatchSchema).default([]),
  phaseArtifacts: z.record(z.string(), ArtifactSchema).default({}),
  translationCostCheckpoint: z.object({
    checkpointId: z.string().uuid(),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    batchCount: z.number().int().positive(),
    characterCount: z.number().int().positive()
  }).optional(),
  translationCostAcceptedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  audience: z.string().trim().min(1).max(200).default('general'),
  writingStyle: z.string().trim().min(1).max(200).default('storytelling'),
  resolvedSource: DocumentSourceSchema.optional(),
  sourceLanguage: z.string().trim().min(1).max(32).optional(),
  targetLanguage: z.literal('zh-CN').default('zh-CN'),
  blockCount: z.number().int().nonnegative().default(0),
  translatedBlockCount: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  reviewCompletedAt: z.string().datetime({ offset: true }).optional(),
  htmlPublication: DocumentHtmlPublicationSchema.default({ status: 'idle', phase: 'route' })
})
export type DocumentState = z.infer<typeof DocumentStateSchema>

const DEFAULT_DOCUMENT_STATE = {
  workflowVersion: 2 as const,
  processingMode: 'auto' as const,
  translationMode: 'normal' as const,
  translationPhase: 'pending' as const,
  translationBatches: [],
  phaseArtifacts: {},
  audience: 'general',
  writingStyle: 'storytelling',
  targetLanguage: 'zh-CN' as const,
  blockCount: 0,
  translatedBlockCount: 0,
  warnings: [] as string[],
  htmlPublication: { status: 'idle' as const, phase: 'route' as const }
}

const TaskManifestV6Schema = z.object({
  schemaVersion: z.literal(6),
  revision: z.number().int().nonnegative(),
  taskId: z.string().uuid(),
  lineage: z.object({
    rootTaskId: z.string().uuid(),
    reusedFromTaskId: z.string().uuid().optional()
  }),
  kind: TaskKindSchema.default('subtitle'),
  title: z.string(),
  // 分类只是归档位：空串 = 未分类，引用已删分类时也按未分类处理，不影响流水线。
  category: z.string().trim().max(64).default(''),
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
      status: z.enum(['pending', 'running', 'verified', 'failed', 'stale']),
      attempt: z.number().int().nonnegative().default(0),
      artifact: ArtifactSchema.optional()
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
  video: VideoWorkflowStateSchema.default(DEFAULT_VIDEO_WORKFLOW_STATE),
  summary: SummaryStateSchema.default(DEFAULT_SUMMARY_STATE),
  document: DocumentStateSchema.default(DEFAULT_DOCUMENT_STATE),
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
  if (value.schemaVersion === 3) {
    value = { ...value, schemaVersion: 4, lineage: { rootTaskId: value.taskId } }
  }
  if (value.schemaVersion === 4) {
    value = {
      ...value,
      schemaVersion: 5,
      document: {
        processingMode: 'auto',
        targetLanguage: 'zh-CN',
        blockCount: 0,
        translatedBlockCount: 0,
        warnings: []
      }
    }
  }
  if (value.schemaVersion === 5) {
    const legacyKind = value.kind === 'summary' || value.kind === 'document' ? value.kind : 'subtitle'
    const pipeline = value.pipeline && typeof value.pipeline === 'object' && !Array.isArray(value.pipeline)
      ? value.pipeline as Record<string, unknown>
      : {}
    const legacyStages = pipeline.stages && typeof pipeline.stages === 'object' && !Array.isArray(pipeline.stages)
      ? pipeline.stages as Record<string, unknown>
      : {}
    const digestStatus = (legacyStages.digest as { status?: unknown } | undefined)?.status
    const summaryStatus = (legacyStages.summary as { status?: unknown } | undefined)?.status
    const artifacts = value.artifacts && typeof value.artifacts === 'object' && !Array.isArray(value.artifacts)
      ? value.artifacts as Record<string, unknown>
      : {}
    const summaryAlreadyStarted = Boolean(artifacts.summaryArticle)
      || (typeof summaryStatus === 'string' && !['pending', 'ready', 'skipped'].includes(summaryStatus))
    const researchStatus = legacyKind !== 'summary' || summaryAlreadyStarted
      ? 'skipped'
      : digestStatus === 'completed'
        ? 'ready'
        : 'pending'
    const legacySummary = value.summary && typeof value.summary === 'object' && !Array.isArray(value.summary)
      ? value.summary as Record<string, unknown>
      : {}
    const legacyDocument = value.document && typeof value.document === 'object' && !Array.isArray(value.document)
      ? value.document as Record<string, unknown>
      : {}
    value = {
      ...value,
      schemaVersion: 6,
      pipeline: {
        ...pipeline,
        stages: {
          ...legacyStages,
          research: { status: researchStatus, attempt: 0 },
          ...(researchStatus === 'ready' && summaryStatus === 'ready'
            ? { summary: { ...(legacyStages.summary as Record<string, unknown>), status: 'pending' } }
            : {})
        }
      },
      video: DEFAULT_VIDEO_WORKFLOW_STATE,
      summary: {
        ...legacySummary,
        research: {
          status: researchStatus === 'skipped' ? 'skipped' : 'idle',
          claims: [],
          queryCount: 0,
          limitations: researchStatus === 'skipped' ? ['旧任务沿用原总结合同，未补跑外部核验'] : []
        }
      },
      document: {
        ...legacyDocument,
        workflowVersion: 1,
        translationMode: 'legacy-direct',
        translationPhase: 'pending',
        translationBatches: [],
        phaseArtifacts: {},
        audience: 'general',
        writingStyle: 'storytelling',
        htmlPublication: { status: 'idle', phase: 'route' }
      }
    }
  }
  // 旧 manifest 没有新阶段条目；缺阶段会让流水线把它当成待执行，所以必须补齐。
  const kind = value.kind === 'summary' || value.kind === 'document' ? value.kind : 'subtitle'
  const pipeline = value.pipeline
  if (pipeline && typeof pipeline === 'object' && !Array.isArray(pipeline)) {
    const stages = (pipeline as Record<string, unknown>).stages
    if (stages && typeof stages === 'object' && !Array.isArray(stages)) {
      value = { ...value, pipeline: { ...pipeline, stages: stagesForKind(kind, stages as Record<string, unknown>) } }
    }
  }
  return value
}, TaskManifestV6Schema)
export type TaskManifest = z.infer<typeof TaskManifestSchema>

export function taskThumbnailArtifact(manifest: TaskManifest): TaskManifest['artifacts'][string] | undefined {
  const thumbnail = manifest.artifacts.thumbnail
  if (thumbnail?.valid) return thumbnail
  // 0.2.10 以前的 X 文档已本地化图片，但没有发布标准 thumbnail。
  // 仅对 X 内容兼容首张媒体；普通网页的首图可能只是 tracking pixel。
  if (manifest.kind !== 'document'
    || (manifest.document.resolvedSource !== 'x-article' && manifest.document.resolvedSource !== 'x-post')) {
    return undefined
  }
  return Object.entries(manifest.artifacts)
    .filter(([key, artifact]) => key.startsWith('documentMedia:') && artifact.valid)
    .sort(([left], [right]) => left.localeCompare(right))[0]?.[1]
}

export function createTaskManifest(
  input: z.input<typeof TaskInputSchema>,
  title = '',
  provider?: ProviderId,
  styleNote = '',
  subtitlePreset: SubtitlePreset = 'standard',
  autoPublish = false,
  kind: TaskKind = 'subtitle',
  category = '',
  documentMode: DocumentProcessingMode = 'auto',
  documentTranslationMode: Exclude<DocumentTranslationMode, 'legacy-direct'> = 'normal',
  documentAudience = 'general',
  documentWritingStyle = 'storytelling',
  model: ModelSelection = { source: 'cli-default' }
): TaskManifest {
  const now = new Date().toISOString()
  const parsedInput = TaskInputSchema.parse(input)
  const taskId = globalThis.crypto.randomUUID()
  const stages = stagesForKind(kind)
  stages.source = { status: 'ready', attempt: 0 }
  return TaskManifestSchema.parse({
    schemaVersion: 6,
    revision: 0,
    taskId,
    lineage: { rootTaskId: taskId },
    kind,
    title: title.trim() || taskInputName(parsedInput),
    category,
    taskDir: '.',
    input: parsedInput,
    render: { subtitlePreset },
    createdAt: now,
    updatedAt: now,
    pipeline: { stages },
    artifacts: {},
    translation: { styleNote, selectedProvider: provider, selectedModel: provider ? model : { source: 'cli-default' }, sessionGenerations: [], batches: [] },
    runtime: { currentMessage: '等待开始', userPaused: false },
    publication: { autoPublish: kind === 'subtitle' ? autoPublish : false, status: 'idle', attempt: 0 },
    video: DEFAULT_VIDEO_WORKFLOW_STATE,
    summary: DEFAULT_SUMMARY_STATE,
    document: {
      ...DEFAULT_DOCUMENT_STATE,
      processingMode: documentMode,
      translationMode: documentTranslationMode,
      audience: documentAudience.trim() || 'general',
      writingStyle: documentWritingStyle.trim() || 'storytelling'
    },
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
