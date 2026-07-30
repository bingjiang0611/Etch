import { z } from 'zod'
import { ProviderIdSchema, StageStatusSchema, SubtitlePresetSchema, TaskManifestSchema } from './task-schema'
import { AppSettingsSchema, ToolIdSchema, type AppSettings } from './settings-schema'

export const BootstrapSchema = z.object({
  version: z.string(),
  arch: z.string(),
  showFullDiskAccessOnboarding: z.boolean(),
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

export const TaskSummarySchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  status: StageStatusSchema,
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true })
})

export const QueuePageSchema = z.object({
  items: z.array(TaskSummarySchema),
  total: z.number().int().nonnegative()
})
export type QueuePage = z.infer<typeof QueuePageSchema>

export const CreateUrlsSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(50),
  provider: ProviderIdSchema,
  styleNote: z.string().trim().max(1000).default('')
})

export const TaskDetailSchema = z.object({ taskDirectory: z.string().min(1), manifest: TaskManifestSchema, mediaUrl: z.string().url().optional() })
export type TaskDetail = z.infer<typeof TaskDetailSchema>

export const TaskIdPayloadSchema = z.object({ taskId: z.string().uuid() })
export const TaskThumbnailPayloadSchema = TaskIdPayloadSchema.extend({ expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u) })
export const TaskThumbnailDataUrlSchema = z.string().startsWith('data:image/').max(3_000_000).optional()
export const DeleteTaskModeSchema = z.enum(['record-only', 'all-artifacts'])
export type DeleteTaskMode = z.infer<typeof DeleteTaskModeSchema>
export const DeleteTaskPayloadSchema = TaskIdPayloadSchema.extend({ mode: DeleteTaskModeSchema })

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

export interface EtchApi {
  bootstrap(): Promise<Bootstrap>
  queuePage(offset?: number, limit?: number): Promise<QueuePage>
  createUrls(urls: string[], provider: z.infer<typeof CreateUrlsSchema>['provider'], styleNote?: string): Promise<QueuePage>
  taskDetail(taskId: string): Promise<TaskDetail>
  taskThumbnail(taskId: string, expectedSha256: string): Promise<string | undefined>
  startTask(taskId: string): Promise<TaskDetail>
  stopTask(taskId: string): Promise<TaskDetail>
  deleteTask(taskId: string, mode: DeleteTaskMode): Promise<QueuePage>
  revealTask(taskId: string): Promise<void>
  recoveryState(): Promise<RecoveryState>
  releaseRecovery(): Promise<RecoveryState>
  resolveAudit(taskId: string, decisions: Array<{ cueId: number; translation: string }>): Promise<TaskDetail>
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
  openFullDiskAccessSettings(): Promise<void>
  onOpenSettings(listener: () => void): () => void
}

export { AppSettingsSchema }
