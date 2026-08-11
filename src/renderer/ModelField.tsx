import { useEffect, useRef, useState } from 'react'
import type { ProviderModelCatalog } from '../shared/model-catalog'
import type { ProviderId } from '../shared/task-schema'
import {
  applyModelDraft,
  applyModelSelect,
  modelCatalogHint,
  modelFieldError,
  modelFieldOptions,
  modelFieldSelectValue,
  shouldAcceptCatalog,
  type ModelFieldState
} from './model-selection'

export interface ModelCatalogState {
  catalog?: ProviderModelCatalog
  loading: boolean
}

// Reads the provider's own model list through the narrow IPC surface. Discovery is advisory: a failed
// probe leaves `catalog` degraded and the form still submits with the CLI default or a manual id.
export function useModelCatalog(provider: ProviderId | undefined, active: boolean): ModelCatalogState {
  const [state, setState] = useState<ModelCatalogState>({ loading: false })
  const generationRef = useRef(0)
  const currentRef = useRef<{ generation: number; provider: ProviderId | undefined; active: boolean }>({
    generation: 0,
    provider: undefined,
    active: false
  })

  useEffect(() => {
    const generation = ++generationRef.current
    currentRef.current = { generation, provider, active }
    if (!active || !provider) {
      setState({ loading: false })
      return
    }
    setState({ loading: true })
    void window.etch.modelCatalog(provider).then((catalog) => {
      if (!shouldAcceptCatalog({ generation, provider }, currentRef.current)) return
      setState({ catalog, loading: false })
    }).catch(() => {
      if (!shouldAcceptCatalog({ generation, provider }, currentRef.current)) return
      setState({ loading: false })
    })
  }, [provider, active])

  return state
}

interface ModelFieldProps {
  idPrefix: string
  label: string
  state: ModelFieldState
  catalog?: ProviderModelCatalog
  loading: boolean
  disabled: boolean
  inactive?: boolean
  onChange: (next: ModelFieldState) => void
}

export function ModelField({
  idPrefix,
  label,
  state,
  catalog,
  loading,
  disabled,
  inactive,
  onChange
}: ModelFieldProps): React.JSX.Element {
  const selectId = `${idPrefix}-model`
  const draftId = `${idPrefix}-model-id`
  const error = modelFieldError(state)
  return (
    <>
      <label className="new-task-field new-task-agent-field" data-inactive={inactive ? 'true' : undefined} htmlFor={selectId}>
        <span>{label} <small aria-live="polite">{modelCatalogHint(catalog, loading)}</small></span>
        <select
          className="field-select"
          id={selectId}
          value={modelFieldSelectValue(state)}
          disabled={disabled || inactive}
          onChange={(event) => onChange(applyModelSelect(state, event.target.value, catalog))}
        >
          {modelFieldOptions(state, catalog).map((option) => (
            <option value={option.value} key={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      {state.custom && !inactive && (
        <label className="new-task-field" htmlFor={draftId}>
          <span>模型 ID <small>留空则使用 CLI 默认模型</small></span>
          <input
            className="field-input"
            id={draftId}
            value={state.draft}
            maxLength={200}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-errormessage={error ? `${draftId}-error` : undefined}
            disabled={disabled}
            onChange={(event) => onChange(applyModelDraft(state, event.target.value))}
          />
          {error && <small className="form-error" id={`${draftId}-error`} role="alert">{error}</small>}
        </label>
      )}
    </>
  )
}
