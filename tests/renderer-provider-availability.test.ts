import { describe, expect, it } from 'vitest'
import type { ToolHealthSnapshot } from '../src/shared/ipc'
import {
  DEFAULT_PROVIDER,
  PROVIDER_IDS,
  providerAvailability,
  providerOrDefault
} from '../src/renderer/provider-availability'

describe('provider selection and availability', () => {
  it('preserves every supported provider and defaults only an absent selection to Codex', () => {
    expect(DEFAULT_PROVIDER).toBe('codex')
    expect(PROVIDER_IDS).toEqual(['claude', 'codex', 'qoder', 'opencode'])
    for (const provider of PROVIDER_IDS) expect(providerOrDefault(provider)).toBe(provider)
    expect(providerOrDefault()).toBe('codex')
  })

  it('fails closed before tool detection has completed', () => {
    expect(providerAvailability('claude', [])).toEqual({ available: false, checked: false, summary: '环境尚未检测' })
  })

  it.each([
    ['ready', true],
    ['missing', false],
    ['invalid', false],
    ['timeout', false]
  ] as const)('derives availability from a detected %s tool-health status', (status, available) => {
    const snapshots: ToolHealthSnapshot[] = [{
      tool: 'qoder',
      status,
      summaryZh: `qoder ${status}`
    }]
    expect(providerAvailability('qoder', snapshots)).toEqual({
      available,
      checked: true,
      summary: `qoder ${status}`
    })
  })
})
