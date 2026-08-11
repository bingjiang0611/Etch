import { describe, expect, it } from 'vitest'
import { CreateCompanionSchema, CreateUrlsSchema } from '../src/shared/ipc'
import { createTaskManifest } from '../src/shared/task-schema'
import { buildProviderInvocation } from '../src/main/providers/adapters'
import type { ModelSelection, ProviderId } from '../src/shared/task-schema'

const PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'qoder', 'opencode']
const baseUrls = { urls: ['https://example.com/video'], provider: 'qoder' as const }
const baseCompanion = { taskId: '11111111-2222-4333-8444-555555555555', provider: 'qoder' as const }

function modelFlagValue(provider: ProviderId, model: ModelSelection): string | undefined {
  const { args } = buildProviderInvocation({ provider, model, prompt: 'hi' }, '/bin/cli')
  const index = args.indexOf('--model')
  return index === -1 ? undefined : args[index + 1]
}

describe('model selection over the create IPC boundary', () => {
  it('defaults to the CLI default so an older renderer bundle still creates tasks', () => {
    expect(CreateUrlsSchema.parse(baseUrls).model).toEqual({ source: 'cli-default' })
    expect(CreateCompanionSchema.parse(baseCompanion).model).toEqual({ source: 'cli-default' })
  })

  it('accepts a discovered and a user-entered model', () => {
    expect(CreateUrlsSchema.parse({ ...baseUrls, model: { source: 'discovered', modelId: 'Auto' } }).model)
      .toEqual({ source: 'discovered', modelId: 'Auto' })
    expect(CreateCompanionSchema.parse({ ...baseCompanion, model: { source: 'user-entered', modelId: 'anthropic/claude-opus-4-5' } }).model)
      .toEqual({ source: 'user-entered', modelId: 'anthropic/claude-opus-4-5' })
    expect(CreateUrlsSchema.parse({ ...baseUrls, model: { source: 'user-entered', modelId: 'claude-opus-4-8[1m]' } }).model)
      .toEqual({ source: 'user-entered', modelId: 'claude-opus-4-8[1m]' })
  })

  it.each([
    ['a flag-shaped id', '--dangerously-skip-permissions'],
    ['a shell metacharacter', 'sonnet; rm -rf /'],
    ['whitespace', 'gpt 5'],
    ['an empty id', '']
  ])('rejects %s at the boundary', (_label, modelId) => {
    expect(() => CreateUrlsSchema.parse({ ...baseUrls, model: { source: 'user-entered', modelId } })).toThrow()
    expect(() => CreateCompanionSchema.parse({ ...baseCompanion, model: { source: 'discovered', modelId } })).toThrow()
  })

  it('rejects a model id beyond the length bound', () => {
    expect(() => CreateUrlsSchema.parse({ ...baseUrls, model: { source: 'user-entered', modelId: 'a'.repeat(201) } })).toThrow()
  })
})

describe('model selection persisted into task.json', () => {
  it('writes the chosen model onto the manifest', () => {
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://example.com/video' },
      '', 'qoder', '', 'standard', false, 'subtitle', '',
      'auto', 'normal', 'general', 'storytelling',
      { source: 'discovered', modelId: 'Auto' }
    )
    expect(manifest.translation.selectedModel).toEqual({ source: 'discovered', modelId: 'Auto' })
  })

  it('still defaults to the CLI default when no model is supplied', () => {
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'qoder')
    expect(manifest.translation.selectedModel).toEqual({ source: 'cli-default' })
  })

  it('keeps a provider-less conversion on the CLI default', () => {
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://example.com/post' },
      '', undefined, '', 'standard', false, 'document', '',
      'convert', 'normal', 'general', 'storytelling',
      { source: 'user-entered', modelId: 'sonnet' }
    )
    expect(manifest.translation.selectedModel).toEqual({ source: 'cli-default' })
  })
})

describe('model selection reaching the CLI', () => {
  it.each(PROVIDERS)('omits --model for %s on the CLI default', (provider) => {
    expect(modelFlagValue(provider, { source: 'cli-default' })).toBeUndefined()
  })

  it.each(PROVIDERS)('passes the exact model id for %s on an explicit choice', (provider) => {
    expect(modelFlagValue(provider, { source: 'discovered', modelId: 'model-x' })).toBe('model-x')
    expect(modelFlagValue(provider, { source: 'user-entered', modelId: 'model-y' })).toBe('model-y')
  })

  it('keeps passing the model when resuming an existing session', () => {
    const { args } = buildProviderInvocation(
      { provider: 'qoder', model: { source: 'discovered', modelId: 'Auto' }, prompt: 'hi', externalSessionId: 'session-1' },
      '/bin/qodercli'
    )
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('Auto')
  })
})
