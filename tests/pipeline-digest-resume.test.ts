import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../src/main/runtime/process-runner', () => ({ runProcess: runProcessMock }))
vi.mock('../src/main/runtime/shell-env', () => ({
  loginShellEnvironment: async () => ({ PATH: '/mock' }),
  operationalEnvironment: (env: NodeJS.ProcessEnv) => env,
  providerEnvironment: (_provider: string, env: NodeJS.ProcessEnv) => env,
  logChildEnvironmentKeys: () => undefined
}))
vi.mock('../src/main/runtime/tool-detector', () => ({
  detectTool: async (tool: string) => ({ tool, status: 'ready', executable: `/mock/${tool}`, summaryZh: `${tool} 可用` }),
  identityStillMatches: async () => true,
  toolCacheKey: (tool: string, override?: string) => `${tool}:${override ?? ''}`
}))
vi.mock('../src/main/providers/codex-capability', () => ({
  attestCodexTextOnlyExecutableSnapshot: async () => ({ version: 'codex-cli 1.2.3', sha256: 'a'.repeat(64) }),
  codexTextOnlyExecutableIsSupported: () => true,
  createCodexTextOnlyExecutableSnapshot: async () => ({ directory: '/mock/codex-snapshot-dir', executable: '/mock/codex-snapshot' }),
  removeCodexTextOnlyExecutableSnapshot: async () => undefined
}))

import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { TaskStore } from '../src/main/storage/task-store'
import { sha256File } from '../src/main/core/fingerprint'
import { defaultSettings } from '../src/shared/settings-schema'
import { STAGE_IDS, createTaskManifest } from '../src/shared/task-schema'

const directories: string[] = []

afterEach(async () => {
  generatedSession = 0
  runProcessMock.mockReset()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5 })))
})

function result(text: string, sessionId: string) {
  return {
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], mcp_servers: [] }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: text })
    ].join('\n'),
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false
  }
}

function segmentFindings(marker: string): string {
  return JSON.stringify({
    claims: [`${marker} 的核心论点`],
    numbers: ['139%'],
    entities: ['Anthropic'],
    quotes: [{ text: 'compute is the cost of intelligence', speaker: '嘉宾', note: '成本判断' }],
    stories: [`${marker} 里的一个故事`],
    tensions: ['增长与毛利冲突'],
    unverified: ['季度年化数字'],
    asrSuspects: ['Anthropik']
  })
}

const REDUCE = JSON.stringify({
  throughlines: ['算力成本正在改写利润表'],
  entityGlossary: [{ surface: 'Anthropik', corrected: 'Anthropic', kind: 'company' }]
})

// 每条 cue 都超过分段目标字数，partitionTranscript 会切成两段，才能验证「只重跑没完成的段」。
function longSrt(): string {
  const filler = (word: string): string => `${word} `.repeat(2600).trim()
  return [
    '1',
    '00:00:01,000 --> 00:00:20,000',
    filler('compute'),
    '',
    '2',
    '00:00:21,000 --> 00:00:40,000',
    filler('margin'),
    ''
  ].join('\n')
}

async function createDigestTask(store: TaskStore): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-digest-resume-'))
  directories.push(directory)
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '对谈', 'qoder', '', 'standard', false, 'summary')
  for (const stage of STAGE_IDS) {
    if (stage === 'digest') manifest.pipeline.stages[stage].status = 'ready'
    else if (stage === 'research' || stage === 'summary' || stage === 'illustrate') manifest.pipeline.stages[stage].status = 'pending'
    else if (manifest.pipeline.stages[stage].status !== 'skipped') manifest.pipeline.stages[stage].status = 'completed'
  }
  const srt = longSrt()
  await writeFile(join(directory, 'english.clean.srt'), srt)
  manifest.artifacts.englishClean = {
    relativePath: 'english.clean.srt',
    sha256: await sha256File(join(directory, 'english.clean.srt')),
    size: Buffer.byteLength(srt),
    valid: true,
    producer: 'test',
    inputFingerprint: 'a'.repeat(64)
  }
  const generationId = 'd1c2d3e4-0000-4000-8000-000000000000'
  manifest.translation.activeGenerationId = generationId
  manifest.translation.sessionGenerations = [{
    id: generationId,
    provider: 'qoder',
    model: { source: 'cli-default' },
    stateRoot: directory,
    status: 'active',
    reason: 'initial',
    createdAt: '2026-08-09T10:00:00.000Z'
  }]
  await store.create(directory, manifest)
  return directory
}

function pipelineFor(store: TaskStore): TaskPipeline {
  return new TaskPipeline(store, defaultSettings('/Users/test'), new HistoricalGlossaryService(store, () => []), () => undefined)
}

interface ProcessSpec {
  stdin: string
  args: string[]
}

function argumentAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

let generatedSession = 0

function codexSessionFromArgs(args: readonly string[]): string {
  const resume = args.indexOf('resume')
  if (resume >= 0) {
    const session = args.slice(resume + 1).find((arg) => /^[0-9a-f-]{36}$/u.test(arg))
    if (session) return session
  }
  generatedSession += 1
  return `019f7e34-385f-7de3-9fac-${String(generatedSession).padStart(12, '0')}`
}

function respond(calls: ProcessSpec[], reduce: string) {
  return async (spec: ProcessSpec) => {
    calls.push(spec)
    const sessionId = argumentAfter(spec.args, '-r') ?? argumentAfter(spec.args, '--session-id') ?? codexSessionFromArgs(spec.args)
    if (spec.stdin.includes('请合并成唯一的素材分析包收口')) return result(reduce, sessionId)
    return result(segmentFindings(spec.stdin.includes('第 1 / 2 段') ? '第一段' : '第二段'), sessionId)
  }
}

function segmentPrompts(calls: readonly ProcessSpec[]): string[] {
  return calls.map((call) => call.stdin).filter((prompt) => /第 \d+ \/ \d+ 段/u.test(prompt))
}

describe('素材分析分段续跑', () => {
  it('收口失败时保住已完成分段，重跑只补收口并复用分段产物', async () => {
    const store = new TaskStore()
    const directory = await createDigestTask(store)

    // 第一次：两段都成功，收口输出空主线过不了本地校验。
    const firstCalls: ProcessSpec[] = []
    runProcessMock.mockImplementation(respond(firstCalls, JSON.stringify({ throughlines: [], entityGlossary: [] })))
    await expect(pipelineFor(store).start(directory)).rejects.toThrow('digest-reduce')

    const failed = await store.load(directory)
    expect(failed.pipeline.stages.digest.status).toBe('failed')
    expect(segmentPrompts(firstCalls)).toHaveLength(2)
    expect(failed.summary.digestFindings.map((finding) => finding.segmentId)).toEqual(['segment-001', 'segment-002'])
    expect(failed.summary.digestFindings.every((finding) => finding.status === 'verified')).toBe(true)
    expect(failed.summary.digestFindings.every((finding) => finding.artifact?.valid)).toBe(true)
    expect(failed.summary.digestFindings.map((finding) => finding.attempt)).toEqual([1, 1])
    expect(failed.artifacts.summaryDigest).toBeUndefined()
    for (const finding of failed.summary.digestFindings) {
      const saved = JSON.parse(await readFile(join(directory, finding.artifact!.relativePath), 'utf8')) as { claims: string[] }
      expect(saved.claims[0]).toContain('的核心论点')
    }

    // 第二次：收口正常，两段一次 provider 调用都不该再发。
    const secondCalls: ProcessSpec[] = []
    runProcessMock.mockImplementation(respond(secondCalls, REDUCE))
    await pipelineFor(store).start(directory)

    const completed = await store.load(directory)
    expect(segmentPrompts(secondCalls)).toHaveLength(0)
    expect(secondCalls.filter((call) => call.stdin.includes('请合并成唯一的素材分析包收口'))).toHaveLength(1)
    expect(completed.pipeline.stages.digest.status).toBe('completed')
    expect(completed.summary.digestSegments).toBe(2)
    // attempt 没涨，证明两段都是读盘复用而不是重新生成。
    expect(completed.summary.digestFindings.map((finding) => finding.attempt)).toEqual([1, 1])

    const digest = JSON.parse(await readFile(join(directory, completed.artifacts.summaryDigest.relativePath), 'utf8')) as {
      segments: { segmentId: string; claims: string[] }[]
      throughlines: string[]
    }
    expect(digest.segments.map((segment) => segment.segmentId)).toEqual(['segment-001', 'segment-002'])
    expect(digest.segments[0].claims[0]).toContain('第一段')
    expect(digest.segments[1].claims[0]).toContain('第二段')
    expect(digest.throughlines).toEqual(['算力成本正在改写利润表'])
  }, 30_000)

  it('已完成分段产物损坏时标记 stale 并只重跑该段', async () => {
    const store = new TaskStore()
    const directory = await createDigestTask(store)
    const firstCalls: ProcessSpec[] = []
    runProcessMock.mockImplementation(respond(firstCalls, JSON.stringify({ throughlines: [], entityGlossary: [] })))
    await expect(pipelineFor(store).start(directory)).rejects.toThrow('digest-reduce')

    const failed = await store.load(directory)
    const corrupted = failed.summary.digestFindings[0].artifact!.relativePath
    await writeFile(join(directory, corrupted), '{"claims":[]}')

    const secondCalls: ProcessSpec[] = []
    runProcessMock.mockImplementation(respond(secondCalls, REDUCE))
    await pipelineFor(store).start(directory)

    const completed = await store.load(directory)
    expect(segmentPrompts(secondCalls)).toEqual([expect.stringContaining('第 1 / 2 段')])
    expect(completed.pipeline.stages.digest.status).toBe('completed')
    expect(completed.summary.digestFindings.every((finding) => finding.status === 'verified')).toBe(true)
    // 只有被改坏的那段重跑了一次。
    expect(completed.summary.digestFindings.map((finding) => finding.attempt)).toEqual([2, 1])
  }, 30_000)
})
