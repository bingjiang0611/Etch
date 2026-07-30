import { describe, expect, it } from 'vitest'
import { canonicalJson, fingerprint } from '../src/main/core/fingerprint'

describe('fingerprint', () => {
  it('sorts object keys without reordering arrays', () => {
    expect(canonicalJson({ b: 2, a: [2, 1] })).toBe('{"a":[2,1],"b":2}')
    expect(fingerprint('cues', 1, { b: 2, a: 1 })).toBe(fingerprint('cues', 1, { a: 1, b: 2 }))
  })

  it('includes producer version and rejects ambiguous values', () => {
    expect(fingerprint('cues', 1, { a: 1 })).not.toBe(fingerprint('cues', 2, { a: 1 }))
    expect(() => canonicalJson({ value: undefined })).toThrow('undefined')
    expect(() => canonicalJson({ value: Number.NaN })).toThrow('非有限')
  })
})
