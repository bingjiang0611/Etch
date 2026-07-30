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
})
