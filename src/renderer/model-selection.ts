import {
  CLI_DEFAULT_MODEL,
  ModelIdSchema,
  SelectedModelSchema,
  defaultModelForProvider,
  modelSelectionId,
  normalizeModelId,
  type ProviderModelCatalog
} from '../shared/model-catalog'
import { PROVIDER_IDS } from './provider-availability'
import type { ModelSelection, ProviderId } from '../shared/task-schema'

export const NEW_TASK_MODEL_STORAGE_KEY = 'etch:new-task-model:v1'
export const AUTO_MODEL_VALUE = ''
export const CUSTOM_MODEL_VALUE = '__custom__'
export const MODEL_ID_HINT = '模型 ID 只能包含字母、数字与 . _ : @ / + - [ ]，且必须以字母或数字开头'

type ModelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type ModelStorageAccess = ModelStorage | (() => ModelStorage)
export type RememberedModels = Partial<Record<ProviderId, ModelSelection>>

function resolveStorage(access: ModelStorageAccess): ModelStorage {
  return typeof access === 'function' ? access() : access
}

export function loadLastNewTaskModels(access: ModelStorageAccess): RememberedModels {
  try {
    const storage = resolveStorage(access)
    const raw = storage.getItem(NEW_TASK_MODEL_STORAGE_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') {
      storage.removeItem(NEW_TASK_MODEL_STORAGE_KEY)
      return {}
    }
    const remembered: RememberedModels = {}
    for (const provider of PROVIDER_IDS) {
      const candidate = SelectedModelSchema.safeParse(parsed[provider])
      if (candidate.success) remembered[provider] = candidate.data
    }
    return remembered
  } catch {
    // A remembered choice is a convenience; unreadable storage just falls back to the settings default.
    return {}
  }
}

export function saveLastNewTaskModel(access: ModelStorageAccess, provider: ProviderId, model: ModelSelection): void {
  if (!SelectedModelSchema.safeParse(model).success) return
  try {
    const storage = resolveStorage(access)
    storage.setItem(NEW_TASK_MODEL_STORAGE_KEY, JSON.stringify({ ...loadLastNewTaskModels(storage), [provider]: model }))
  } catch {
    // Remembering the last choice must never prevent a task from being created.
  }
}

// Remembered choice for this provider wins, then the configured per-provider default, then the CLI's
// own default. A model is never carried across providers: ids are not portable between the four CLIs.
export function resolveNewTaskModel(
  remembered: RememberedModels,
  configuredDefaults: Partial<Record<ProviderId, ModelSelection>>,
  provider: ProviderId
): ModelSelection {
  const stored = remembered[provider]
  if (stored && SelectedModelSchema.safeParse(stored).success) return stored
  return defaultModelForProvider(configuredDefaults, provider)
}

export interface ModelFieldState {
  model: ModelSelection
  custom: boolean
  draft: string
}

export function modelFieldStateFor(model: ModelSelection): ModelFieldState {
  return model.source === 'user-entered'
    ? { model, custom: true, draft: model.modelId }
    : { model, custom: false, draft: '' }
}

export function modelFieldSelectValue(state: ModelFieldState): string {
  return state.custom ? CUSTOM_MODEL_VALUE : modelSelectionId(state.model)
}

export function applyModelSelect(state: ModelFieldState, value: string, catalog?: ProviderModelCatalog): ModelFieldState {
  if (value === CUSTOM_MODEL_VALUE) {
    return { ...state, custom: true, draft: state.draft || modelSelectionId(state.model) }
  }
  if (value === AUTO_MODEL_VALUE) return { ...state, model: CLI_DEFAULT_MODEL, custom: false }
  const discovered = catalog?.status === 'ready' && catalog.entries.some((entry) => entry.modelId === value)
  return { ...state, custom: false, model: { source: discovered ? 'discovered' : 'user-entered', modelId: value } }
}

export function applyModelDraft(state: ModelFieldState, draft: string): ModelFieldState {
  return { ...state, draft }
}

// An empty manual field means the user opened the custom row and changed their mind, which resolves
// to the CLI default rather than blocking the form. A non-empty but malformed id has no safe reading.
export function modelFieldSelection(state: ModelFieldState): ModelSelection | undefined {
  if (!state.custom) {
    const parsed = SelectedModelSchema.safeParse(state.model)
    return parsed.success ? parsed.data : undefined
  }
  if (!state.draft.trim()) return CLI_DEFAULT_MODEL
  const modelId = normalizeModelId(state.draft)
  return modelId ? { source: 'user-entered', modelId } : undefined
}

export function modelFieldError(state: ModelFieldState): string {
  if (!state.custom || !state.draft.trim()) return ''
  return ModelIdSchema.safeParse(state.draft).success ? '' : MODEL_ID_HINT
}

export interface ModelFieldOption {
  value: string
  label: string
}

// The current selection is always offered, even when a degraded catalog cannot confirm it, so a late
// or failed discovery can never silently downgrade a task to the CLI default behind the user's back.
export function modelFieldOptions(state: ModelFieldState, catalog?: ProviderModelCatalog): ModelFieldOption[] {
  const options: ModelFieldOption[] = [{ value: AUTO_MODEL_VALUE, label: '自动模型（使用 CLI 默认）' }]
  const entries = catalog?.status === 'ready' ? catalog.entries : []
  for (const entry of entries) {
    options.push({ value: entry.modelId, label: entry.label === entry.modelId ? entry.label : `${entry.label} · ${entry.modelId}` })
  }
  const selected = state.custom ? '' : modelSelectionId(state.model)
  if (selected && !entries.some((entry) => entry.modelId === selected)) {
    options.push({ value: selected, label: `${selected}（已选，未在列表中）` })
  }
  options.push({ value: CUSTOM_MODEL_VALUE, label: '手动填写模型 ID…' })
  return options
}

export function modelCatalogHint(catalog: ProviderModelCatalog | undefined, loading: boolean): string {
  if (loading) return '正在读取该 CLI 的模型列表…'
  if (!catalog) return '选择具体模型，或保持自动模型使用 CLI 默认'
  return catalog.status === 'ready' ? `该 CLI 报告 ${catalog.entries.length} 个可用模型` : catalog.reasonZh
}

export interface CatalogRequest {
  generation: number
  provider: ProviderId
}

export interface CatalogState {
  generation: number
  provider: ProviderId | undefined
  active: boolean
}

// A catalog probe can outlive the dialog that asked for it. Accepting only the newest request for the
// provider that is still selected keeps a slow claude probe from landing on a qoder selection.
export function shouldAcceptCatalog(request: CatalogRequest, current: CatalogState): boolean {
  return current.active && request.generation === current.generation && request.provider === current.provider
}
