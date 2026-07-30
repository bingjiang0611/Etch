import { describe, expect, it } from 'vitest'
import { CreateUrlsSchema } from '../src/shared/ipc'

describe('task creation provider boundary', () => {
  it.each(['claude', 'codex', 'qoder', 'opencode'] as const)('accepts the supported %s provider', (provider) => {
    const base = { urls: ['https://example.com/video'], styleNote: '' }
    expect(CreateUrlsSchema.parse({ ...base, provider }).provider).toBe(provider)
  })

  it('rejects provider values outside the four-provider contract', () => {
    const base = { urls: ['https://example.com/video'], styleNote: '' }
    expect(() => CreateUrlsSchema.parse({ ...base, provider: 'unknown' })).toThrow()
  })
})
