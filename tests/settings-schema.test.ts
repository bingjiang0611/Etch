import { describe, expect, it } from 'vitest'
import { AppSettingsSchema, defaultSettings } from '../src/shared/settings-schema'

describe('settings schema', () => {
  it('drops the removed global translation style from legacy settings', () => {
    const legacy = { ...defaultSettings('/Users/test'), styleNote: '不应再影响任务' }
    expect(AppSettingsSchema.parse(legacy)).not.toHaveProperty('styleNote')
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

  it('keeps an explicit theme preference and rejects unknown values', () => {
    const base = defaultSettings('/Users/test')
    expect(AppSettingsSchema.parse({ ...base, theme: 'light' }).theme).toBe('light')
    expect(AppSettingsSchema.parse({ ...base, theme: 'dark' }).theme).toBe('dark')
    expect(() => AppSettingsSchema.parse({ ...base, theme: 'sepia' })).toThrow()
  })
})
