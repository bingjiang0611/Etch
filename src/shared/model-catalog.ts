import { z } from 'zod'
import { ProviderIdSchema, type ModelSelection, type ProviderId } from './task-schema'

export const MODEL_ID_MAX = 200
export const MODEL_CATALOG_MAX = 200

// A model id is spliced into an argv array as the value of `--model`. Requiring the first character
// to be alphanumeric is what stops a pasted `--dangerously-skip-permissions` from being handed to a
// CLI as a flag instead of a value; the rest of the class covers every id the four CLIs emit today
// (`opencode/big-pickle`, `claude-opus-4-8[1m]`, `qwen3.8-v116-dogfood-crit`).
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+[\]-]*$/u

export const ModelIdSchema = z.string().trim().min(1).max(MODEL_ID_MAX).regex(MODEL_ID_PATTERN, '模型 ID 只能包含字母、数字与 . _ : @ / + - [ ]，且必须以字母或数字开头')

// Mirrors ModelSelectionSchema but bounds and character-checks the id at the creation boundary.
// The persisted schema stays permissive so manifests written by older builds still load.
export const SelectedModelSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('cli-default') }),
  z.object({ source: z.literal('discovered'), modelId: ModelIdSchema }),
  z.object({ source: z.literal('user-entered'), modelId: ModelIdSchema })
])

export const CLI_DEFAULT_MODEL: ModelSelection = { source: 'cli-default' }

export function normalizeModelId(raw: string): string | undefined {
  const parsed = ModelIdSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

export function modelSelectionId(model: ModelSelection): string {
  return model.source === 'cli-default' ? '' : model.modelId
}

export const ModelCatalogEntrySchema = z.object({
  modelId: ModelIdSchema,
  label: z.string().trim().min(1).max(MODEL_ID_MAX)
})
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>

// ready = the CLI enumerated its own models. unsupported = this CLI has no listing command at all.
// failed = the listing command exists but this run could not be trusted. Only `ready` may carry
// entries, so a degraded probe can never be mistaken for a catalog.
export const ModelCatalogStatusSchema = z.enum(['ready', 'unsupported', 'failed'])
export type ModelCatalogStatus = z.infer<typeof ModelCatalogStatusSchema>

export const ProviderModelCatalogSchema = z.object({
  provider: ProviderIdSchema,
  status: ModelCatalogStatusSchema,
  entries: z.array(ModelCatalogEntrySchema).max(MODEL_CATALOG_MAX),
  reasonZh: z.string().max(300),
  checkedAt: z.string().datetime({ offset: true })
}).superRefine((value, context) => {
  if (value.status !== 'ready' && value.entries.length) {
    context.addIssue({ code: 'custom', path: ['entries'], message: '降级的模型目录不得携带条目' })
  }
})
export type ProviderModelCatalog = z.infer<typeof ProviderModelCatalogSchema>

export const ModelCatalogPayloadSchema = z.object({ provider: ProviderIdSchema })

export function defaultModelForProvider(
  defaults: Partial<Record<ProviderId, ModelSelection>>,
  provider: ProviderId
): ModelSelection {
  const configured = defaults[provider]
  const parsed = SelectedModelSchema.safeParse(configured)
  return parsed.success ? parsed.data : CLI_DEFAULT_MODEL
}
