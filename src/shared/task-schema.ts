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
  'verify'
] as const

export const StageIdSchema = z.enum(STAGE_IDS)
export type StageId = z.infer<typeof StageIdSchema>

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

const TaskManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().nonnegative(),
  taskId: z.string().uuid(),
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
  identityConflict: z.boolean().default(false)
})
export const TaskManifestSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const legacy = raw as Record<string, unknown>
  if (legacy.schemaVersion !== 1) return raw
  return {
    ...legacy,
    schemaVersion: 2,
    publication: { autoPublish: false, status: 'idle', attempt: 0 }
  }
}, TaskManifestV2Schema)
export type TaskManifest = z.infer<typeof TaskManifestSchema>

export function createTaskManifest(
  input: z.input<typeof TaskInputSchema>,
  title = '',
  provider?: ProviderId,
  styleNote = '',
  subtitlePreset: SubtitlePreset = 'standard',
  autoPublish = false
): TaskManifest {
  const now = new Date().toISOString()
  const parsedInput = TaskInputSchema.parse(input)
  const stages = Object.fromEntries(STAGE_IDS.map((stage) => [stage, { status: stage === 'source' ? 'ready' : 'pending', attempt: 0 }]))
  return TaskManifestSchema.parse({
    schemaVersion: 2,
    revision: 0,
    taskId: globalThis.crypto.randomUUID(),
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
    publication: { autoPublish, status: 'idle', attempt: 0 },
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
