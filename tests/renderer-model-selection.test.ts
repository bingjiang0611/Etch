import { describe, expect, it } from 'vitest'
import {
  AUTO_MODEL_VALUE,
  CUSTOM_MODEL_VALUE,
  NEW_TASK_MODEL_STORAGE_KEY,
  applyModelDraft,
  applyModelSelect,
  loadLastNewTaskModels,
  modelCatalogHint,
  modelFieldError,
  modelFieldOptions,
  modelFieldSelectValue,
  modelFieldSelection,
  modelFieldStateFor,
  resolveNewTaskModel,
  saveLastNewTaskModel,
  shouldAcceptCatalog
} from '../src/renderer/model-selection'
import { CLI_DEFAULT_MODEL, type ProviderModelCatalog } from '../src/shared/model-catalog'

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
    map
  }
}

const readyCatalog: ProviderModelCatalog = {
  provider: 'qoder',
  status: 'ready',
  entries: [
    { modelId: 'Auto', label: 'Auto' },
    { modelId: 'qwen3.8-v116-dogfood-crit', label: 'Peach-07-17-DogFooding' }
  ],
  reasonZh: '',
  checkedAt: '2026-01-01T00:00:00.000Z'
}

const degradedCatalog: ProviderModelCatalog = {
  provider: 'codex',
  status: 'unsupported',
  entries: [],
  reasonZh: 'codex CLI 没有列出模型的命令，请填写模型名（如 gpt-5-codex）',
  checkedAt: '2026-01-01T00:00:00.000Z'
}

describe('remembered model per provider', () => {
  it('round-trips a per-provider choice without touching other providers', () => {
    const store = storage()
    saveLastNewTaskModel(store, 'qoder', { source: 'discovered', modelId: 'Auto' })
    saveLastNewTaskModel(store, 'claude', { source: 'user-entered', modelId: 'claude-sonnet-4-5' })
    expect(loadLastNewTaskModels(store)).toEqual({
      qoder: { source: 'discovered', modelId: 'Auto' },
      claude: { source: 'user-entered', modelId: 'claude-sonnet-4-5' }
    })
  })

  it('clears malformed storage instead of throwing', () => {
    const store = storage({ [NEW_TASK_MODEL_STORAGE_KEY]: 'not json' })
    expect(loadLastNewTaskModels(store)).toEqual({})
  })

  it('drops entries that are no longer valid model selections', () => {
    const store = storage({
      [NEW_TASK_MODEL_STORAGE_KEY]: JSON.stringify({
        qoder: { source: 'discovered', modelId: '--dangerously-skip-permissions' },
        opencode: { source: 'discovered', modelId: 'anthropic/claude-opus-4-5' }
      })
    })
    expect(loadLastNewTaskModels(store)).toEqual({ opencode: { source: 'discovered', modelId: 'anthropic/claude-opus-4-5' } })
  })

  it('refuses to persist a model id a CLI would read as a flag', () => {
    const store = storage()
    saveLastNewTaskModel(store, 'qoder', { source: 'user-entered', modelId: '--model' })
    expect(store.map.size).toBe(0)
  })

  it('prefers the remembered choice, then the configured default, then the CLI default', () => {
    const remembered = { qoder: { source: 'discovered', modelId: 'Auto' } } as const
    const defaults = { qoder: { source: 'discovered', modelId: 'Ultimate' }, claude: { source: 'user-entered', modelId: 'sonnet' } } as const
    expect(resolveNewTaskModel(remembered, defaults, 'qoder')).toEqual({ source: 'discovered', modelId: 'Auto' })
    expect(resolveNewTaskModel({}, defaults, 'claude')).toEqual({ source: 'user-entered', modelId: 'sonnet' })
    expect(resolveNewTaskModel({}, defaults, 'opencode')).toEqual(CLI_DEFAULT_MODEL)
  })

  it('ignores an unsafe legacy configured default instead of forwarding it to task creation', () => {
    expect(resolveNewTaskModel({}, {
      qoder: { source: 'discovered', modelId: '--dangerously-skip-permissions' }
    }, 'qoder')).toEqual(CLI_DEFAULT_MODEL)
    expect(modelFieldSelection(modelFieldStateFor({
      source: 'discovered',
      modelId: '--dangerously-skip-permissions'
    }))).toBeUndefined()
  })
})

describe('model field state', () => {
  it('starts on the CLI default with the auto option selected', () => {
    const state = modelFieldStateFor(CLI_DEFAULT_MODEL)
    expect(modelFieldSelectValue(state)).toBe(AUTO_MODEL_VALUE)
    expect(modelFieldSelection(state)).toEqual(CLI_DEFAULT_MODEL)
    expect(modelFieldOptions(state, readyCatalog)[0].value).toBe(AUTO_MODEL_VALUE)
  })

  it('marks a catalog hit as discovered and an unknown id as user-entered', () => {
    const base = modelFieldStateFor(CLI_DEFAULT_MODEL)
    expect(modelFieldSelection(applyModelSelect(base, 'Auto', readyCatalog))).toEqual({ source: 'discovered', modelId: 'Auto' })
    expect(modelFieldSelection(applyModelSelect(base, 'Ultimate', readyCatalog))).toEqual({ source: 'user-entered', modelId: 'Ultimate' })
    expect(modelFieldSelection(applyModelSelect(base, 'Auto', degradedCatalog))).toEqual({ source: 'user-entered', modelId: 'Auto' })
  })

  it('returns to the CLI default when auto is picked again', () => {
    const chosen = applyModelSelect(modelFieldStateFor(CLI_DEFAULT_MODEL), 'Auto', readyCatalog)
    expect(modelFieldSelection(applyModelSelect(chosen, AUTO_MODEL_VALUE, readyCatalog))).toEqual(CLI_DEFAULT_MODEL)
  })

  it('accepts a validated manual id and blocks a malformed one', () => {
    const custom = applyModelSelect(modelFieldStateFor(CLI_DEFAULT_MODEL), CUSTOM_MODEL_VALUE, degradedCatalog)
    expect(modelFieldSelection(applyModelDraft(custom, 'gpt-5-codex'))).toEqual({ source: 'user-entered', modelId: 'gpt-5-codex' })
    expect(modelFieldSelection(applyModelDraft(custom, 'claude-opus-4-8[1m]'))).toEqual({ source: 'user-entered', modelId: 'claude-opus-4-8[1m]' })
    expect(modelFieldSelection(applyModelDraft(custom, '--model x'))).toBeUndefined()
    expect(modelFieldError(applyModelDraft(custom, '--model x'))).not.toBe('')
  })

  it('treats an empty manual id as the CLI default so discovery failure never blocks creation', () => {
    const custom = applyModelSelect(modelFieldStateFor(CLI_DEFAULT_MODEL), CUSTOM_MODEL_VALUE, degradedCatalog)
    expect(modelFieldSelection(applyModelDraft(custom, '   '))).toEqual(CLI_DEFAULT_MODEL)
    expect(modelFieldError(applyModelDraft(custom, '   '))).toBe('')
  })

  it('always offers a manual entry option, including when the catalog is degraded', () => {
    const state = modelFieldStateFor(CLI_DEFAULT_MODEL)
    expect(modelFieldOptions(state, degradedCatalog).map((option) => option.value)).toEqual([AUTO_MODEL_VALUE, CUSTOM_MODEL_VALUE])
    expect(modelFieldOptions(state, undefined).map((option) => option.value)).toEqual([AUTO_MODEL_VALUE, CUSTOM_MODEL_VALUE])
  })

  it('keeps a remembered id selectable when the catalog cannot confirm it', () => {
    const state = modelFieldStateFor({ source: 'discovered', modelId: 'Ultimate' })
    const options = modelFieldOptions(state, readyCatalog)
    expect(options.map((option) => option.value)).toContain('Ultimate')
    expect(modelFieldSelectValue(state)).toBe('Ultimate')
  })

  it('prefills the manual field from a remembered user-entered model', () => {
    const state = modelFieldStateFor({ source: 'user-entered', modelId: 'sonnet' })
    expect(modelFieldSelectValue(state)).toBe(CUSTOM_MODEL_VALUE)
    expect(state.draft).toBe('sonnet')
  })

  it('surfaces the degradation reason rather than a fake model count', () => {
    expect(modelCatalogHint(degradedCatalog, false)).toBe(degradedCatalog.reasonZh)
    expect(modelCatalogHint(readyCatalog, false)).toContain('2')
    expect(modelCatalogHint(undefined, true)).toContain('正在读取')
  })
})

describe('late catalog responses', () => {
  it('accepts only the newest response for the provider that is still selected', () => {
    expect(shouldAcceptCatalog({ generation: 3, provider: 'qoder' }, { generation: 3, provider: 'qoder', active: true })).toBe(true)
  })

  it('drops a response for a provider the user has since switched away from', () => {
    expect(shouldAcceptCatalog({ generation: 2, provider: 'claude' }, { generation: 3, provider: 'qoder', active: true })).toBe(false)
    expect(shouldAcceptCatalog({ generation: 3, provider: 'claude' }, { generation: 3, provider: 'qoder', active: true })).toBe(false)
  })

  it('drops a response that lands after the dialog closed', () => {
    expect(shouldAcceptCatalog({ generation: 3, provider: 'qoder' }, { generation: 3, provider: 'qoder', active: false })).toBe(false)
  })
})
