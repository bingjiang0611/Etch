import { describe, expect, it } from 'vitest'
import {
  MODEL_CATALOG_PROBE_TIMEOUT_MS,
  ModelCatalogCache,
  probeModelCatalog,
  providerSupportsModelListing
} from '../src/main/runtime/model-catalog'
import type { ProcessResult, ProcessSpec } from '../src/main/runtime/process-runner'
import type { ProviderModelCatalog } from '../src/shared/model-catalog'

function result(stdout: string, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    ...overrides
  }
}

// Captured from `qodercli --list-models` on a real install.
const QODER_OUTPUT = [
  'MODEL',
  'Auto',
  'Ultimate',
  'Qwen3.8-Max',
  'Peach-07-17-DogFooding (qwen3.8-v116-dogfood-crit)'
].join('\n')

// Captured from `opencode models` on a real install.
const OPENCODE_OUTPUT = [
  'opencode/big-pickle',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-sonnet-4-5-20250929'
].join('\n')

describe('provider model catalog discovery', () => {
  it('parses the qoder listing and prefers the parenthesised model id', async () => {
    const catalog = await probeModelCatalog('qoder', '/bin/qodercli', {}, async () => result(QODER_OUTPUT))
    expect(catalog.status).toBe('ready')
    expect(catalog.entries.map((entry) => entry.modelId)).toEqual([
      'Auto',
      'Ultimate',
      'Qwen3.8-Max',
      'qwen3.8-v116-dogfood-crit'
    ])
    expect(catalog.entries.at(-1)?.label).toBe('Peach-07-17-DogFooding')
  })

  it('parses the opencode listing as provider/model pairs', async () => {
    const catalog = await probeModelCatalog('opencode', '/bin/opencode', {}, async () => result(OPENCODE_OUTPUT))
    expect(catalog.status).toBe('ready')
    expect(catalog.entries.map((entry) => entry.modelId)).toEqual([
      'opencode/big-pickle',
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-sonnet-4-5-20250929'
    ])
  })

  it('ignores banner and warning lines that are not model ids', async () => {
    const noisy = `▀▀▀▀ █▀▀▀\nwarning: models cache is stale\nanthropic/claude-opus-4-5\n`
    const catalog = await probeModelCatalog('opencode', '/bin/opencode', {}, async () => result(noisy))
    expect(catalog.entries.map((entry) => entry.modelId)).toEqual(['anthropic/claude-opus-4-5'])
  })

  it('runs the listing as an argument array with a timeout and an output ceiling', async () => {
    const specs: ProcessSpec[] = []
    await probeModelCatalog('qoder', '/bin/qodercli', { PATH: '/usr/bin' }, async (spec) => {
      specs.push(spec)
      return result(QODER_OUTPUT)
    })
    expect(specs).toHaveLength(1)
    expect(specs[0].command).toBe('/bin/qodercli')
    expect(specs[0].args).toEqual(['--list-models'])
    expect(specs[0].timeoutMs).toBe(MODEL_CATALOG_PROBE_TIMEOUT_MS)
    expect(specs[0].captureLimitBytes).toBeGreaterThan(0)
    expect(specs[0].env).toEqual({ PATH: '/usr/bin' })
  })

  it.each(['claude', 'codex'] as const)('degrades %s explicitly instead of inventing a catalog', async (provider) => {
    expect(providerSupportsModelListing(provider)).toBe(false)
    const catalog = await probeModelCatalog(provider, '/bin/cli', {}, async () => {
      throw new Error('模型列表探测不应该运行')
    })
    expect(catalog.status).toBe('unsupported')
    expect(catalog.entries).toEqual([])
    expect(catalog.reasonZh).toContain(provider)
  })

  it.each([
    ['a non-zero exit', { exitCode: 1 }],
    ['a timeout', { timedOut: true }],
    ['a cancelled probe', { cancelled: true }],
    ['truncated output', { stdoutTruncated: true }]
  ] as const)('reports %s as failed without entries', async (_label, overrides) => {
    const catalog = await probeModelCatalog('qoder', '/bin/qodercli', {}, async () => result(QODER_OUTPUT, overrides))
    expect(catalog.status).toBe('failed')
    expect(catalog.entries).toEqual([])
    expect(catalog.reasonZh).not.toBe('')
  })

  it('reports unparseable output as failed rather than an empty ready catalog', async () => {
    const catalog = await probeModelCatalog('qoder', '/bin/qodercli', {}, async () => result('MODEL\n'))
    expect(catalog.status).toBe('failed')
    expect(catalog.entries).toEqual([])
  })

  it('reports a missing executable as failed without spawning', async () => {
    const catalog = await probeModelCatalog('opencode', undefined, {}, async () => {
      throw new Error('不应该在没有可执行文件时 spawn')
    })
    expect(catalog.status).toBe('failed')
    expect(catalog.entries).toEqual([])
  })

  it('never emits a model id that a CLI would read as a flag', async () => {
    const catalog = await probeModelCatalog('qoder', '/bin/qodercli', {}, async () => result('MODEL\n--dangerously-skip-permissions\nAuto\n'))
    expect(catalog.entries.map((entry) => entry.modelId)).toEqual(['Auto'])
  })
})

describe('model catalog cache', () => {
  function catalogFor(provider: 'qoder' | 'opencode', label: string): ProviderModelCatalog {
    return {
      provider,
      status: 'ready',
      entries: [{ modelId: label, label }],
      reasonZh: '',
      checkedAt: '2026-01-01T00:00:00.000Z'
    }
  }

  it('serves a provider from cache until the TTL expires', async () => {
    let now = 0
    const cache = new ModelCatalogCache({ ttlMs: 1_000, now: () => now })
    let calls = 0
    const load = async (): Promise<ProviderModelCatalog> => {
      calls += 1
      return catalogFor('qoder', `call-${calls}`)
    }
    expect((await cache.read('qoder', '', load)).entries[0].modelId).toBe('call-1')
    now = 999
    expect((await cache.read('qoder', '', load)).entries[0].modelId).toBe('call-1')
    now = 1_001
    expect((await cache.read('qoder', '', load)).entries[0].modelId).toBe('call-2')
    expect(calls).toBe(2)
  })

  it('keeps providers independent', async () => {
    const cache = new ModelCatalogCache({ ttlMs: 1_000, now: () => 0 })
    expect((await cache.read('qoder', '', async () => catalogFor('qoder', 'Auto'))).entries[0].modelId).toBe('Auto')
    const opencode = await cache.read('opencode', '', async () => catalogFor('opencode', 'anthropic/claude-opus-4-5'))
    expect(opencode.entries[0].modelId).toBe('anthropic/claude-opus-4-5')
    expect(opencode.provider).toBe('opencode')
  })

  it('re-probes when the tool path override changes', async () => {
    const cache = new ModelCatalogCache({ ttlMs: 60_000, now: () => 0 })
    let calls = 0
    const load = async (): Promise<ProviderModelCatalog> => {
      calls += 1
      return catalogFor('qoder', `call-${calls}`)
    }
    await cache.read('qoder', '/a/qodercli', load)
    await cache.read('qoder', '/b/qodercli', load)
    expect(calls).toBe(2)
  })

  it('collapses concurrent reads of the same provider into one probe', async () => {
    const cache = new ModelCatalogCache({ ttlMs: 60_000, now: () => 0 })
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const load = async (): Promise<ProviderModelCatalog> => {
      calls += 1
      await gate
      return catalogFor('qoder', 'Auto')
    }
    const first = cache.read('qoder', '', load)
    const second = cache.read('qoder', '', load)
    release!()
    expect((await first).entries[0].modelId).toBe('Auto')
    expect((await second).entries[0].modelId).toBe('Auto')
    expect(calls).toBe(1)
  })
})
