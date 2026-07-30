import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ codex: '' }))

vi.mock('../src/main/runtime/shell-env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/runtime/shell-env')>()
  return {
    ...actual,
    loginShellEnvironment: async () => process.env,
    logChildEnvironmentKeys: () => undefined
  }
})
vi.mock('../src/main/runtime/tool-detector', () => ({
  detectTool: async (tool: string) => ({
    tool,
    status: 'ready',
    executable: fixture.codex,
    version: 'codex-cli registry-integration',
    summaryZh: `${tool} 可用`
  }),
  identityStillMatches: async () => true,
  toolCacheKey: (tool: string, override?: string) => `${tool}:${override ?? ''}`
}))
vi.mock('../src/main/providers/codex-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/providers/codex-capability')>()
  return { ...actual, codexTextOnlyExecutableIsSupported: () => true }
})

import { sha256File } from '../src/main/core/fingerprint'
import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { RunRegistry } from '../src/main/runtime/run-registry'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, type TaskManifest } from '../src/shared/task-schema'

const directories: string[] = []

afterEach(async () => {
  fixture.codex = ''
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function artifact(directory: string, relativePath: string): Promise<TaskManifest['artifacts'][string]> {
  const info = await stat(join(directory, relativePath))
  return {
    relativePath,
    sha256: await sha256File(join(directory, relativePath)),
    size: info.size,
    valid: true,
    producer: 'fixture',
    inputFingerprint: '1'.repeat(64)
  }
}

describe('TaskPipeline Provider durable process sequence', () => {
  it('finishes pre-attest and Provider records before registering the next task-scoped process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-provider-registry-sequence-'))
    directories.push(directory)
    fixture.codex = join(directory, 'fake-codex')
    const sessionId = randomUUID()
    const providerEvents = [
      { type: 'thread.started', thread_id: sessionId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: JSON.stringify({ patches: [] }) } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
    ].map((event) => JSON.stringify(event)).join('\n')
    vi.stubEnv('OPENAI_API_KEY', 'codex-provider-canary')
    vi.stubEnv('GH_TOKEN', 'unrelated-secret-canary')
    await writeFile(fixture.codex, [
      '#!/usr/bin/env node',
      "if (process.env.OPENAI_API_KEY !== 'codex-provider-canary' || process.env.GH_TOKEN) process.exit(31)",
      "if (process.argv.includes('--version')) process.stdout.write('codex-cli registry-integration\\n')",
      "else if (process.argv[2] === 'login' && process.argv[3] === 'status') process.stdout.write('Logged in using test fixture\\n')",
      `else process.stdout.write(${JSON.stringify(`${providerEvents}\n`)})`
    ].join('\n'), 'utf8')
    await chmod(fixture.codex, 0o755)

    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/provider-registry' }, 'Provider registry', 'codex')
    for (const stage of ['source', 'inspect', 'english'] as const) manifest.pipeline.stages[stage].status = 'completed'
    manifest.pipeline.stages.cues.status = 'ready'
    for (const stage of ['translate', 'audit', 'review', 'srt', 'burn', 'verify'] as const) manifest.pipeline.stages[stage].status = 'skipped'
    manifest.runtime.subtitleKind = 'automatic'
    await writeFile(join(directory, 'english.srt'), [
      '1', '00:00:00,000 --> 00:00:01,000', 'redis server', '',
      '2', '00:00:02,000 --> 00:00:03,000', 'second cue', '',
      '3', '00:00:04,000 --> 00:00:05,000', 'third cue', ''
    ].join('\n'), 'utf8')
    await writeFile(join(directory, 'source.info.json'), JSON.stringify({ title: 'Provider registry' }), 'utf8')
    manifest.artifacts.english = await artifact(directory, 'english.srt')
    manifest.artifacts.metadata = await artifact(directory, 'source.info.json')
    await store.create(directory, manifest)

    const runs = new RunRegistry(join(directory, 'run-registry.json'), 100)
    const register = vi.spyOn(runs, 'register')
    const finish = vi.spyOn(runs, 'finish')
    const pipeline = new TaskPipeline(store, defaultSettings(directory), new HistoricalGlossaryService(store, () => []), () => undefined, runs)

    await pipeline.start(directory)

    expect((await store.load(directory)).pipeline.stages.cues.status).toBe('completed')
    expect(await runs.load()).toEqual([])
    expect(register).toHaveBeenCalledTimes(3)
    expect(finish).toHaveBeenCalledTimes(3)
    for (let index = 0; index < 3; index += 1) {
      expect(register.mock.invocationCallOrder[index]).toBeLessThan(finish.mock.invocationCallOrder[index])
      if (index < 2) expect(finish.mock.invocationCallOrder[index]).toBeLessThan(register.mock.invocationCallOrder[index + 1])
    }
  }, 30_000)
})
