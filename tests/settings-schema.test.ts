import { describe, expect, it } from 'vitest'
import { AppSettingsSchema, defaultSettings } from '../src/shared/settings-schema'

describe('settings schema', () => {
  it('drops the removed global translation style from legacy settings', () => {
    const legacy = { ...defaultSettings('/Users/test'), styleNote: '不应再影响任务' }
    expect(AppSettingsSchema.parse(legacy)).not.toHaveProperty('styleNote')
  })

  it('defaults a missing legacy stage concurrency to 3 and keeps a stored 1/2/3', () => {
    const legacy = { ...defaultSettings('/Users/test') } as Partial<ReturnType<typeof defaultSettings>>
    delete legacy.stageConcurrency
    expect(AppSettingsSchema.parse(legacy).stageConcurrency).toBe(3)
    expect(AppSettingsSchema.parse({ ...defaultSettings('/Users/test'), stageConcurrency: 1 }).stageConcurrency).toBe(1)
    expect(AppSettingsSchema.parse({ ...defaultSettings('/Users/test'), stageConcurrency: 2 }).stageConcurrency).toBe(2)
    expect(() => AppSettingsSchema.parse({ ...defaultSettings('/Users/test'), stageConcurrency: 4 })).toThrow()
  })

  it('defaults a missing legacy global glossary to an empty object', () => {
    const legacy = { ...defaultSettings('/Users/test') } as Partial<ReturnType<typeof defaultSettings>>
    delete legacy.globalGlossary
    expect(AppSettingsSchema.parse(legacy).globalGlossary).toEqual({})
  })

  it('defaults a missing theme preference to following the system appearance', () => {
    const legacy = { ...defaultSettings('/Users/test') } as Partial<ReturnType<typeof defaultSettings>>
    delete legacy.theme
    expect(AppSettingsSchema.parse(legacy).theme).toBe('system')
  })

  it('defaults a missing per-provider default model map to an empty object', () => {
    const legacy = { ...defaultSettings('/Users/test') } as Partial<ReturnType<typeof defaultSettings>>
    delete legacy.defaultModelByProvider
    expect(AppSettingsSchema.parse(legacy).defaultModelByProvider).toEqual({})
  })

  it('keeps a per-provider default model and rejects an unknown provider key', () => {
    const base = defaultSettings('/Users/test')
    const parsed = AppSettingsSchema.parse({
      ...base,
      defaultModelByProvider: { qoder: { source: 'discovered', modelId: 'Auto' } }
    })
    expect(parsed.defaultModelByProvider.qoder).toEqual({ source: 'discovered', modelId: 'Auto' })
    expect(() => AppSettingsSchema.parse({ ...base, defaultModelByProvider: { gemini: { source: 'cli-default' } } })).toThrow()
  })

  it('keeps an explicit theme preference and rejects unknown values', () => {
    const base = defaultSettings('/Users/test')
    expect(AppSettingsSchema.parse({ ...base, theme: 'light' }).theme).toBe('light')
    expect(AppSettingsSchema.parse({ ...base, theme: 'dark' }).theme).toBe('dark')
    expect(() => AppSettingsSchema.parse({ ...base, theme: 'sepia' })).toThrow()
  })
})
