import { z } from 'zod'
import { BilibiliAccountSchema, BilibiliPartitionSchema, BilibiliPublicationDraftSchema, BilibiliQrStateSchema, type BilibiliAccount, type BilibiliPartition, type BilibiliPublicationDraft, type BilibiliQrState } from './bilibili'
import { DocumentProcessingModeSchema, DocumentTranslationModeSchema, ModelSelectionSchema, ProviderIdSchema, StageIdSchema, StageStatusSchema, SubtitlePresetSchema, SummaryDraftRecordSchema, SummaryImagePlanEntrySchema, TaskKindSchema, TaskManifestSchema } from './task-schema'
import { AppSettingsSchema, ToolIdSchema, type AppSettings } from './settings-schema'
import { SelectedModelSchema, type ProviderModelCatalog } from './model-catalog'
import { POOL_KINDS } from './pipeline'

export const ChromeCookieAccessSchema = z.enum(['granted', 'denied', 'missing'])
export type ChromeCookieAccess = z.infer<typeof ChromeCookieAccessSchema>

export const BootstrapSchema = z.object({
  version: z.string(),
  arch: z.string(),
  showFullDiskAccessOnboarding: z.boolean(),
  chromeCookieAccess: ChromeCookieAccessSchema,
  startupDiagnostics: z.object({
    discoveryErrors: z.array(z.object({
      location: z.string().min(1).max(4096),
      code: z.enum(['invalid-manifest', 'unreadable']),
      summary: z.string().max(300)
    })).max(100),
    identityConflicts: z.array(z.object({
      taskId: z.string().uuid(),
      locations: z.array(z.string().min(1).max(4096)).min(2).max(20)
    })).max(100)
  })
})
export type Bootstrap = z.infer<typeof BootstrapSchema>
export type RuntimeDiagnostics = Bootstrap['startupDiagnostics']

export const TaskScheduleSchema = z.enum(['idle', 'waiting', 'active'])
export type TaskSchedule = z.infer<typeof TaskScheduleSchema>

export const TaskSummarySchema = z.object({
  taskId: z.string().uuid(),
  rootTaskId: z.string().uuid().optional(),
  reusedFromTaskId: z.string().uuid().optional(),
  title: z.string(),
  kind: TaskKindSchema.default('subtitle'),
  category: z.string().max(64).default(''),
  status: StageStatusSchema,
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
  schedule: TaskScheduleSchema.default('idle'),
  waitingStage: StageIdSchema.optional()
})

export const PipelineActivitySchema = z.object({
  limit: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  pools: z.record(z.enum(POOL_KINDS), z.object({
    active: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative()
  }))
})
export type PipelineActivity = z.infer<typeof PipelineActivitySchema>

export const IDLE_PIPELINE_ACTIVITY: PipelineActivity = {
  limit: 3,
  pools: Object.fromEntries(POOL_KINDS.map((kind) => [kind, { active: 0, waiting: 0 }])) as PipelineActivity['pools']
}

export const QueuePageSchema = z.object({
  items: z.array(TaskSummarySchema),
  total: z.number().int().nonnegative(),
  activity: PipelineActivitySchema
})
export type QueuePage = z.infer<typeof QueuePageSchema>

export const CreateUrlsSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(50),
  provider: ProviderIdSchema,
  kind: TaskKindSchema.default('subtitle'),
  styleNote: z.string().trim().max(1000).default(''),
  autoPublish: z.boolean().default(false),
  category: z.string().trim().max(64).default(''),
  documentMode: DocumentProcessingModeSchema.default('auto'),
  documentTranslationMode: DocumentTranslationModeSchema.exclude(['legacy-direct']).default('normal'),
  documentAudience: z.string().trim().min(1).max(200).default('general'),
  documentWritingStyle: z.string().trim().min(1).max(200).default('storytelling'),
  model: SelectedModelSchema.default({ source: 'cli-default' })
}).superRefine((value, context) => {
  value.urls.forEach((url, index) => {
    const protocol = new URL(url).protocol
    if (protocol !== 'http:' && protocol !== 'https:') {
      context.addIssue({ code: 'custom', path: ['urls', index], message: '内容链接只支持 http 或 https' })
    }
  })
})

export const CreateCompanionSchema = z.object({
  taskId: z.string().uuid(),
  provider: ProviderIdSchema,
  styleNote: z.string().trim().max(1000).default(''),
  autoPublish: z.boolean().default(false),
  model: SelectedModelSchema.default({ source: 'cli-default' })
})

export const TaskDetailSchema = z.object({ taskDirectory: z.string().min(1), manifest: TaskManifestSchema, mediaUrl: z.string().url().optional() })
export type TaskDetail = z.infer<typeof TaskDetailSchema>

export const TaskIdPayloadSchema = z.object({ taskId: z.string().uuid() })
export const TaskThumbnailPayloadSchema = TaskIdPayloadSchema.extend({ expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u) })
export const TaskThumbnailDataUrlSchema = z.string().startsWith('data:image/').max(3_000_000).optional()
export const DeleteTaskModeSchema = z.enum(['record-only', 'all-artifacts'])
export type DeleteTaskMode = z.infer<typeof DeleteTaskModeSchema>
export const DeleteTaskPayloadSchema = TaskIdPayloadSchema.extend({ mode: DeleteTaskModeSchema })
export const SetTaskCategoryPayloadSchema = TaskIdPayloadSchema.extend({ category: z.string().trim().max(64) })
export const BilibiliQrSessionPayloadSchema = z.object({ sessionId: z.string().uuid() })
export const BilibiliPublicationStartPayloadSchema = TaskIdPayloadSchema.extend({ draft: BilibiliPublicationDraftSchema })
export const BilibiliPublicationCoverSchema = z.object({
  cancelled: z.boolean(),
  coverRelativePath: z.string().min(1).optional(),
  dataUrl: z.string().startsWith('data:image/jpeg;base64,').max(4_000_000).optional()
})
export type BilibiliPublicationCover = z.infer<typeof BilibiliPublicationCoverSchema>

export const ReviewPagePayloadSchema = z.object({
  taskId: z.string().uuid(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(100)
})
export const ReviewTimelineWindowPayloadSchema = z.object({
  taskId: z.string().uuid(),
  milliseconds: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100).default(100),
  expectedRevision: z.number().int().nonnegative(),
  expectedEnglishSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedChineseSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional()
})
const ReviewTimelineCueSchema = z.object({
  cueId: z.number().int().positive(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  english: z.string().min(1).max(10_000),
  chinese: z.string().min(1).max(2000)
})
export const ReviewTimelineWindowSchema = z.object({
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  artifactIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
  rangeStartMs: z.number().int().nonnegative(),
  rangeEndMs: z.number().int().positive(),
  items: z.array(ReviewTimelineCueSchema).max(100)
})
export type ReviewTimelineWindow = z.infer<typeof ReviewTimelineWindowSchema>
export const ReviewGlossaryEntrySchema = z.object({
  source: z.string().min(1).max(500),
  target: z.string().min(1).max(500),
  cueIds: z.array(z.number().int().positive()).max(5000)
})
export const TaskReviewPageSchema = z.object({
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  availability: z.enum(['ready', 'not-ready']),
  message: z.string().optional(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  items: z.array(z.object({
    cueId: z.number().int().positive(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    english: z.string().min(1).max(10_000),
    chinese: z.string().min(1).max(2000)
  })).max(200),
  glossaryState: z.enum(['not-audited', 'empty', 'ready']),
  glossary: z.array(ReviewGlossaryEntrySchema).max(5000),
  glossaryEditable: z.boolean(),
  glossaryEditMessage: z.string().optional()
})
export type TaskReviewPage = z.infer<typeof TaskReviewPageSchema>

export const GlossaryCatalogPayloadSchema = z.object({
  query: z.string().trim().max(500).default(''),
  offset: z.number().int().nonnegative().default(0),
  limit: z.literal(50).default(50)
})
export const GlossaryCatalogItemSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.string().min(1).max(500),
  target: z.string().min(1).max(500),
  sourceCount: z.number().int().positive(),
  sourceTitles: z.array(z.string()).max(5),
  updatedAt: z.string().datetime({ offset: true })
})
export const GlossaryCatalogPageSchema = z.object({
  revision: z.number().int().nonnegative(),
  query: z.string(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  items: z.array(GlossaryCatalogItemSchema).max(50)
})
export type GlossaryCatalogPage = z.infer<typeof GlossaryCatalogPageSchema>
export const DeleteGlossaryEntrySchema = z.object({
  entryId: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedRevision: z.number().int().nonnegative()
})
export const DeleteGlossaryEntryResultSchema = z.object({ revision: z.number().int().nonnegative() })

const CueEditSchema = z.object({
  cueId: z.number().int().positive(),
  translation: z.string().trim().min(1).max(2000).refine((value) => !/[\t\r\n]/u.test(value), '译文不能包含 Tab 或换行')
})
export const UpdateCuesSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  edits: z.array(CueEditSchema).min(1).max(100)
}).superRefine((value, context) => {
  if (new Set(value.edits.map((item) => item.cueId)).size !== value.edits.length) context.addIssue({ code: 'custom', message: 'cue ID 不能重复' })
  if (value.edits.reduce((total, item) => total + item.translation.length, 0) > 100_000) context.addIssue({ code: 'custom', message: '单次修改文本过长' })
})

const GlossaryEditTextSchema = z.string()
  .trim()
  .min(1, '术语不能为空')
  .max(500)
  .refine((value) => !Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  }), '术语不能包含 Tab、换行或控制字符')

export const UpdateGlossarySchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  edits: z.array(z.object({
    index: z.number().int().nonnegative().max(4999),
    expectedSource: z.string().min(1).max(500),
    expectedTarget: z.string().min(1).max(500),
    source: GlossaryEditTextSchema,
    target: GlossaryEditTextSchema
  })).min(1).max(100)
}).superRefine((value, context) => {
  if (new Set(value.edits.map((item) => item.index)).size !== value.edits.length) context.addIssue({ code: 'custom', message: '术语序号不能重复' })
  const length = value.edits.reduce((total, item) => total + item.expectedSource.length + item.expectedTarget.length + item.source.length + item.target.length, 0)
  if (length > 100_000) context.addIssue({ code: 'custom', message: '单次术语修改文本过长' })
})

export const GlossaryApplyPayloadSchema = UpdateGlossarySchema.safeExtend({
  impactFingerprint: z.string().regex(/^[a-f0-9]{64}$/u)
})

export const GlossaryImpactCueSchema = z.object({
  cueId: z.number().int().positive(),
  before: z.string().max(2000),
  after: z.string().max(2000),
  matched: z.boolean(),
  matchedVariant: z.string().min(1).max(500).optional(),
  reason: z.enum(['matched-target', 'already-next-target', 'target-not-found', 'target-unchanged'])
})

export const GlossaryFinalCueSchema = z.object({
  cueId: z.number().int().positive(),
  before: z.string().max(2000),
  after: z.string().max(2000)
})

export const GlossaryImpactPreviewSchema = z.object({
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  impactFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  finalCues: z.array(GlossaryFinalCueSchema).max(5000),
  impacts: z.array(z.object({
    index: z.number().int().nonnegative().max(4999),
    source: z.string().min(1).max(500),
    previousTarget: z.string().min(1).max(500),
    nextTarget: z.string().min(1).max(500),
    cues: z.array(GlossaryImpactCueSchema).max(5000)
  })).min(1).max(100)
})
export type GlossaryImpactPreview = z.infer<typeof GlossaryImpactPreviewSchema>

export const GlossaryApplyResultSchema = z.object({
  detail: TaskDetailSchema,
  preview: GlossaryImpactPreviewSchema
})
export type GlossaryApplyResult = z.infer<typeof GlossaryApplyResultSchema>

export const CompleteReviewSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative()
})

export const UpdateSubtitlePresetSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  preset: SubtitlePresetSchema
})

export const RecoveryStateSchema = z.object({ hold: z.boolean(), interruptedTasks: z.number().int().nonnegative() })
export type RecoveryState = z.infer<typeof RecoveryStateSchema>
const AuditDecisionTextSchema = z.string()
  .trim()
  .min(1, '裁决字幕不能为空')
  .max(2000, '裁决字幕不能超过 2000 个字符')
  .refine((value) => !/[\t\r\n]/u.test(value), '裁决字幕不能包含 Tab 或换行')
export const ResolveAuditSchema = z.object({
  taskId: z.string().uuid(),
  decisions: z.array(z.object({ cueId: z.number().int().positive(), translation: AuditDecisionTextSchema })).min(1)
}).superRefine((value, context) => {
  if (new Set(value.decisions.map((decision) => decision.cueId)).size !== value.decisions.length) {
    context.addIssue({ code: 'custom', message: 'cue ID 不能重复' })
  }
})
export const ToolHealthSnapshotSchema = z.object({
  tool: ToolIdSchema,
  status: z.enum(['ready', 'missing', 'invalid', 'timeout']),
  executable: z.string().optional(),
  version: z.string().optional(),
  summaryZh: z.string()
})
export type ToolHealthSnapshot = z.infer<typeof ToolHealthSnapshotSchema>

export const InstallableToolSchema = z.enum(['yt-dlp', 'ffmpeg', 'ffprobe', 'python', 'mlx_whisper'])
export type InstallableTool = z.infer<typeof InstallableToolSchema>
export const ToolInstallPayloadSchema = z.object({ tool: InstallableToolSchema })
export const ToolInstallResultSchema = z.object({ outcome: z.enum(['launched', 'homebrew-missing']) })
export type ToolInstallResult = z.infer<typeof ToolInstallResultSchema>

export const ImageCapabilitySchema = z.object({
  provider: ProviderIdSchema,
  available: z.boolean(),
  reason: z.string().max(300).optional()
})
export type ImageCapabilityInfo = z.infer<typeof ImageCapabilitySchema>

export const SummaryImageStateSchema = z.object({
  filename: z.string().min(1),
  alt: z.string(),
  anchor: z.string(),
  status: z.enum(['ready', 'pending']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  reason: z.string().max(300).optional()
})

export const SummaryPageSchema = z.object({
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  availability: z.enum(['ready', 'not-ready']),
  message: z.string().optional(),
  markdown: z.string().max(2_000_000).default(''),
  images: z.array(SummaryImageStateSchema).max(12).default([]),
  draftRecord: SummaryDraftRecordSchema.optional(),
  illustrationPhase: z.string().default('agent-pending'),
  imageCapabilities: z.array(ImageCapabilitySchema).max(8).default([])
})
export type SummaryPage = z.infer<typeof SummaryPageSchema>

export const SummaryImagePayloadSchema = z.object({
  taskId: z.string().uuid(),
  filename: z.string().min(1).max(120),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u)
})
export const SummaryImageDataUrlSchema = z.string().startsWith('data:image/png;base64,').max(11_000_000).optional()

export const ResolveIllustrationAgentSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  choice: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('generate'), provider: ProviderIdSchema, model: ModelSelectionSchema }),
    z.object({ mode: z.literal('skip') })
  ])
})

export const ResolveIllustrationCoverSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  decision: z.enum(['accept', 'retry-with-agent', 'skip'])
})

export const ResolveVideoCheckpointSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  decision: z.enum(['accept', 'retry', 'cancel'])
})

export const ResolveResearchCheckpointSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  decision: z.enum(['continue-unverified', 'retry', 'cancel'])
})

export const ResolveDocumentTranslationCostSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  decision: z.enum(['proceed', 'cancel'])
})

export const ExportSummaryResultSchema = z.object({
  cancelled: z.boolean(),
  directory: z.string().optional(),
  images: z.number().int().nonnegative().default(0)
})
export type ExportSummaryResult = z.infer<typeof ExportSummaryResultSchema>
export type SummaryImagePlanEntry = z.infer<typeof SummaryImagePlanEntrySchema>

export const DocumentMetadataSchema = z.object({
  sourceUrl: z.string().url(),
  sourceTitle: z.string().max(1000).default(''),
  siteName: z.string().max(500).optional(),
  author: z.string().max(500).optional(),
  screenName: z.string().max(100).optional(),
  publishedAt: z.string().max(100).optional(),
  contentType: z.enum(['web', 'x-post', 'x-article']),
  mediaExpected: z.number().int().nonnegative().default(0),
  mediaLocalized: z.number().int().nonnegative().default(0),
  engagement: z.object({
    replies: z.number().int().nonnegative().optional(),
    retweets: z.number().int().nonnegative().optional(),
    likes: z.number().int().nonnegative().optional(),
    bookmarks: z.number().int().nonnegative().optional(),
    views: z.number().int().nonnegative().optional()
  }).optional()
})
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>

export const DocumentVerificationSchema = z.object({
  valid: z.boolean(),
  sourceBlocks: z.number().int().nonnegative(),
  translatedBlocks: z.number().int().nonnegative(),
  sourceHeadings: z.number().int().nonnegative(),
  translatedHeadings: z.number().int().nonnegative(),
  expectedMedia: z.number().int().nonnegative(),
  localizedMedia: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(500)).max(100).default([])
})
export type DocumentVerification = z.infer<typeof DocumentVerificationSchema>

export const DocumentPageSchema = z.object({
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  availability: z.enum(['ready', 'not-ready']),
  message: z.string().max(500).optional(),
  sourceMarkdown: z.string().max(5_000_000).default(''),
  translatedMarkdown: z.string().max(5_000_000).default(''),
  metadata: DocumentMetadataSchema.optional(),
  verification: DocumentVerificationSchema.optional()
})
export type DocumentPage = z.infer<typeof DocumentPageSchema>

export const UpdateDocumentTranslationSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  markdown: z.string().min(1).max(5_000_000)
})

export const ExportDocumentResultSchema = z.object({
  cancelled: z.boolean(),
  directory: z.string().optional(),
  media: z.number().int().nonnegative().default(0)
})
export type ExportDocumentResult = z.infer<typeof ExportDocumentResultSchema>

export const DocumentHtmlRouteSchema = z.enum(['preview', 'template', 'frontend-design'])
export const StartDocumentHtmlSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  route: DocumentHtmlRouteSchema.default('preview'),
  templateId: z.string().trim().min(1).max(100).optional()
})
export const ResolveDocumentHtmlStyleSchema = z.object({
  taskId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  direction: z.enum(['A', 'B', 'C', 'D'])
})
export const DocumentHtmlPageSchema = z.object({
  taskId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['idle', 'running', 'checkpoint', 'failed', 'completed']),
  phase: z.enum(['route', 'preview', 'generate', 'verify', 'done']),
  previewHtml: z.string().max(3_000_000).optional(),
  selectedDirection: z.enum(['A', 'B', 'C', 'D']).optional(),
  templateId: z.string().max(100).optional(),
  errorCode: z.string().max(500).optional(),
  verification: z.object({
    staticValid: z.boolean(),
    browserValid: z.boolean(),
    issues: z.array(z.string().max(500)).max(100)
  }).optional()
})
export type DocumentHtmlPage = z.infer<typeof DocumentHtmlPageSchema>
export const ExportDocumentHtmlResultSchema = z.object({
  cancelled: z.boolean(),
  path: z.string().optional()
})
export type ExportDocumentHtmlResult = z.infer<typeof ExportDocumentHtmlResultSchema>

export interface EtchApi {
  bootstrap(): Promise<Bootstrap>
  queuePage(offset?: number, limit?: number): Promise<QueuePage>
  createUrls(urls: string[], provider: z.infer<typeof CreateUrlsSchema>['provider'], styleNote?: string, autoPublish?: boolean, kind?: z.infer<typeof TaskKindSchema>, category?: string, documentMode?: z.infer<typeof DocumentProcessingModeSchema>, documentTranslationMode?: 'normal' | 'refined', documentAudience?: string, documentWritingStyle?: string, model?: z.infer<typeof SelectedModelSchema>): Promise<QueuePage>
  createCompanion(taskId: string, provider: z.infer<typeof ProviderIdSchema>, styleNote?: string, autoPublish?: boolean, model?: z.infer<typeof SelectedModelSchema>): Promise<TaskDetail>
  modelCatalog(provider: z.infer<typeof ProviderIdSchema>): Promise<ProviderModelCatalog>
  taskDetail(taskId: string): Promise<TaskDetail>
  taskThumbnail(taskId: string, expectedSha256: string): Promise<string | undefined>
  startTask(taskId: string): Promise<TaskDetail>
  stopTask(taskId: string): Promise<TaskDetail>
  deleteTask(taskId: string, mode: DeleteTaskMode): Promise<QueuePage>
  setTaskCategory(taskId: string, category: string): Promise<QueuePage>
  revealTask(taskId: string): Promise<void>
  recoveryState(): Promise<RecoveryState>
  releaseRecovery(): Promise<RecoveryState>
  resolveAudit(taskId: string, decisions: Array<{ cueId: number; translation: string }>): Promise<TaskDetail>
  resolveVideoCheckpoint(taskId: string, expectedRevision: number, decision: z.infer<typeof ResolveVideoCheckpointSchema>['decision']): Promise<TaskDetail>
  resolveResearchCheckpoint(taskId: string, expectedRevision: number, decision: z.infer<typeof ResolveResearchCheckpointSchema>['decision']): Promise<TaskDetail>
  resolveDocumentTranslationCost(taskId: string, expectedRevision: number, decision: z.infer<typeof ResolveDocumentTranslationCostSchema>['decision']): Promise<TaskDetail>
  resolveIllustrationAgent(taskId: string, expectedRevision: number, choice: z.infer<typeof ResolveIllustrationAgentSchema>['choice']): Promise<TaskDetail>
  resolveIllustrationCover(taskId: string, expectedRevision: number, decision: z.infer<typeof ResolveIllustrationCoverSchema>['decision']): Promise<TaskDetail>
  summaryPage(taskId: string): Promise<SummaryPage>
  summaryImage(taskId: string, filename: string, expectedSha256: string): Promise<string | undefined>
  exportSummary(taskId: string): Promise<ExportSummaryResult>
  documentPage(taskId: string): Promise<DocumentPage>
  updateDocumentTranslation(taskId: string, expectedRevision: number, markdown: string): Promise<TaskDetail>
  exportDocument(taskId: string): Promise<ExportDocumentResult>
  openDocumentSource(taskId: string): Promise<void>
  documentHtmlPage(taskId: string): Promise<DocumentHtmlPage>
  startDocumentHtml(taskId: string, expectedRevision: number, route?: z.infer<typeof DocumentHtmlRouteSchema>, templateId?: string): Promise<TaskDetail>
  resolveDocumentHtmlStyle(taskId: string, expectedRevision: number, direction: z.infer<typeof ResolveDocumentHtmlStyleSchema>['direction']): Promise<TaskDetail>
  exportDocumentHtml(taskId: string): Promise<ExportDocumentHtmlResult>
  completeReview(taskId: string, expectedRevision: number): Promise<TaskDetail>
  reviewPage(taskId: string, offset?: number, limit?: number): Promise<TaskReviewPage>
  reviewTimelineWindow(taskId: string, milliseconds: number, expectedRevision: number, expectedEnglishSha256?: string, expectedChineseSha256?: string, limit?: number): Promise<ReviewTimelineWindow>
  glossaryCatalogPage(query?: string, offset?: number): Promise<GlossaryCatalogPage>
  deleteGlossaryEntry(entryId: string, expectedRevision: number): Promise<{ revision: number }>
  updateCues(taskId: string, expectedRevision: number, edits: Array<{ cueId: number; translation: string }>): Promise<TaskDetail>
  updateGlossary(taskId: string, expectedRevision: number, edits: z.infer<typeof UpdateGlossarySchema>['edits']): Promise<TaskDetail>
  updateSubtitlePreset(taskId: string, expectedRevision: number, preset: z.infer<typeof SubtitlePresetSchema>): Promise<TaskDetail>
  previewGlossaryApply(taskId: string, expectedRevision: number, edits: z.infer<typeof UpdateGlossarySchema>['edits']): Promise<GlossaryImpactPreview>
  applyGlossary(taskId: string, expectedRevision: number, impactFingerprint: string, edits: z.infer<typeof UpdateGlossarySchema>['edits']): Promise<GlossaryApplyResult>
  getSettings(): Promise<AppSettings>
  updateSettings(settings: AppSettings): Promise<AppSettings>
  detectTools(): Promise<ToolHealthSnapshot[]>
  installTool(tool: InstallableTool): Promise<ToolInstallResult>
  bilibiliAccount(): Promise<BilibiliAccount>
  startBilibiliQrLogin(): Promise<BilibiliQrState>
  pollBilibiliQrLogin(sessionId: string): Promise<BilibiliQrState>
  disconnectBilibili(): Promise<BilibiliAccount>
  bilibiliPartitions(): Promise<BilibiliPartition[]>
  selectBilibiliCover(taskId: string): Promise<BilibiliPublicationCover>
  publishToBilibili(taskId: string, draft: BilibiliPublicationDraft): Promise<TaskDetail>
  stopBilibiliPublication(taskId: string): Promise<TaskDetail>
  continueBilibiliPublication(taskId: string): Promise<TaskDetail>
  openBilibiliCreatorCenter(): Promise<void>
  setVideoFullscreen(fullscreen: boolean): Promise<void>
  requestChromeCookieAccess(): Promise<boolean>
  chromeCookieAccess(): Promise<ChromeCookieAccess>
  dismissFullDiskAccessGuide(): Promise<void>
  relaunchApp(): Promise<void>
  onVideoFullscreenChanged(listener: (fullscreen: boolean) => void): () => void
  onToolHealthChanged(listener: (health: ToolHealthSnapshot) => void): () => void
  onOpenSettings(listener: () => void): () => void
}

export { AppSettingsSchema }
export { BilibiliAccountSchema, BilibiliPartitionSchema, BilibiliPublicationDraftSchema, BilibiliQrStateSchema }
