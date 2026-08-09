import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { fingerprint, sha256File } from '../src/main/core/fingerprint'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import {
  PROVIDER_SESSION_CONTAMINATED_PREFIX,
  PROVIDER_SESSION_UNAVAILABLE_PREFIX
} from '../src/main/providers/session-errors'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, type TaskManifest } from '../src/shared/task-schema'

vi.mock('../src/main/runtime/shell-env', () => ({
  loginShellEnvironment: async () => process.env,
  operationalEnvironment: (env: NodeJS.ProcessEnv) => env,
  providerEnvironment: (_provider: string, env: NodeJS.ProcessEnv) => env,
  logChildEnvironmentKeys: () => undefined
}))
vi.mock('../src/main/providers/codex-capability', () => ({
  createCodexTextOnlyExecutableSnapshot: async (executable: string) => ({ directory: '', executable }),
  attestCodexTextOnlyExecutableSnapshot: async () => ({ version: 'fake-codex 1.0', sha256: 'test' }),
  codexTextOnlyExecutableIsSupported: () => true,
  removeCodexTextOnlyExecutableSnapshot: async () => undefined
}))

const directories: string[] = []

function codexSessionId(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function codexLifecycleScript(sessionExpression: string, textExpression: string, extras = ''): string {
  return `
console.log(JSON.stringify({ type: 'thread.started', thread_id: ${sessionExpression} }))
console.log(JSON.stringify({ type: 'turn.started' }))
${extras}
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: ${textExpression} } }))
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }))
`
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function artifact(directory: string, relativePath: string, producer: string): Promise<TaskManifest['artifacts'][string]> {
  const path = join(directory, relativePath)
  const info = await stat(path)
  return {
    relativePath,
    sha256: await sha256File(path),
    size: info.size,
    valid: true,
    producer,
    inputFingerprint: '1'.repeat(64)
  }
}

async function checkpointTask(): Promise<{
  directory: string
  store: TaskStore
  pipeline: TaskPipeline
  manifest: TaskManifest
}> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-pipeline-glossary-'))
  directories.push(directory)
  const store = new TaskStore()
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
  for (const stage of ['source', 'inspect', 'english', 'cues', 'translate'] as const) {
    manifest.pipeline.stages[stage].status = 'completed'
  }
  manifest.pipeline.stages.audit.status = 'checkpoint'
  manifest.translation.auditCheckpoint = {
    ambiguities: [{ cueId: 1, en: 'An agent runs.', before: '一个智能体在运行。', recommended: '一个代理在运行。', reason: '待用户确认' }]
  }
  await writeFile(join(directory, 'english.clean.srt'), '1\n00:00:00,000 --> 00:00:02,000\nAn agent runs.\n', 'utf8')
  await writeFile(join(directory, 'zh_cues.tsv'), '1\t一个智能体在运行。\n', 'utf8')
  await writeFile(join(directory, 'translation-glossary.json'), `${JSON.stringify({
    schemaVersion: 1,
    currentTaskId: manifest.taskId,
    mode: 'resolved',
    stats: { candidateTasks: 1, validArtifacts: 1, skippedArtifacts: 0, historicalEntries: 1, settingsEntries: 0 },
    entries: [{
      source: 'agent',
      target: '智能体',
      authority: 'historical',
      contextSamples: ['An agent handles the task.'],
      sourceTaskId: crypto.randomUUID(),
      sourceAuditSha256: '2'.repeat(64),
      sourceProducer: 'user-glossary-edit'
    }]
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(directory, 'audit.json'), `${JSON.stringify({
    glossary: [{ source: 'agent', target: '智能体', cueIds: [1] }],
    patches: [{ cueId: 1, before: '一个智能体在运行。', after: '一个代理在运行。', reason: '歧义', confidence: 'ambiguous' }],
    historicalClassifications: [{ source: 'agent', cueId: 1, target: '智能体', reason: '与历史语义相同' }]
  }, null, 2)}\n`, 'utf8')
  manifest.artifacts.translationGlossary = await artifact(directory, 'translation-glossary.json', 'historical-glossary-resolver')
  manifest.artifacts.chineseCues = await artifact(directory, 'zh_cues.tsv', 'global-audit')
  manifest.artifacts.audit = await artifact(directory, 'audit.json', 'global-audit')
  await store.create(directory, manifest)
  const historical = new HistoricalGlossaryService(store, () => [])
  return { directory, store, manifest, pipeline: new TaskPipeline(store, defaultSettings('/Users/test'), historical, () => undefined) }
}

async function manualReviewTask(reviewStatus: 'ready' | 'checkpoint' = 'checkpoint'): Promise<{
  directory: string
  store: TaskStore
  pipeline: TaskPipeline
}> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-manual-review-'))
  directories.push(directory)
  const store = new TaskStore()
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/manual-review' }, '', 'codex')
  for (const stage of Object.values(manifest.pipeline.stages)) stage.status = 'completed'
  manifest.pipeline.stages.review.status = reviewStatus
  if (reviewStatus === 'checkpoint') manifest.pipeline.stages.review.checkpointId = 'manual-review'
  for (const stage of ['srt', 'burn', 'verify'] as const) manifest.pipeline.stages[stage].status = 'pending'
  const english = 'World Cup.'
  await writeFile(join(directory, 'english.clean.srt'), `1\n00:00:00,000 --> 00:00:02,000\n${english}\n`, 'utf8')
  await writeFile(join(directory, 'zh_cues.tsv'), '1\t世界杯。\n', 'utf8')
  await writeFile(join(directory, 'audit.json'), `${JSON.stringify({
    glossary: [{ source: 'World Cup', target: '世界杯', cueIds: [1] }],
    patches: []
  }, null, 2)}\n`, 'utf8')
  manifest.artifacts.englishClean = await artifact(directory, 'english.clean.srt', 'etch-srt')
  manifest.artifacts.chineseCues = await artifact(directory, 'zh_cues.tsv', 'global-audit')
  manifest.artifacts.audit = await artifact(directory, 'audit.json', 'global-audit')
  manifest.translation.manualEdits = [{
    cueId: 1,
    translation: '世界杯。',
    englishCueHash: fingerprint('etch:manual-cue', 1, { cueId: 1, english }),
    updatedAt: new Date().toISOString()
  }]
  await store.create(directory, manifest)
  const historical = new HistoricalGlossaryService(store, () => [])
  return { directory, store, pipeline: new TaskPipeline(store, defaultSettings('/Users/test'), historical, () => undefined) }
}

async function historicalAuditTask(root: string, chinese = '1\t预热缓存。\n2\tKVCache 可降低流量。\n3\t这些缓存是共享的。\n'): Promise<{
  directory: string
  store: TaskStore
  manifest: TaskManifest
}> {
  const directory = join(root, 'task')
  await mkdir(directory)
  const store = new TaskStore()
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/historical-audit' }, 'Historical audit', 'codex')
  for (const stage of ['source', 'inspect', 'english', 'cues', 'translate'] as const) manifest.pipeline.stages[stage].status = 'completed'
  manifest.pipeline.stages.audit.status = 'ready'
  for (const stage of ['review', 'srt', 'burn', 'verify'] as const) manifest.pipeline.stages[stage].status = 'skipped'
  const generationId = crypto.randomUUID()
  manifest.translation.activeGenerationId = generationId
  manifest.translation.sessionGenerations = [{
    id: generationId,
    provider: 'codex',
    model: { source: 'cli-default' },
    externalSessionId: codexSessionId('audit-repair-session'),
    stateRoot: join(directory, 'provider-state'),
    status: 'active',
    reason: 'initial',
    createdAt: new Date().toISOString()
  }]
  await writeFile(join(directory, 'english.clean.srt'), [
    '1', '00:00:00,000 --> 00:00:02,000', 'Warm the cache.', '',
    '2', '00:00:02,000 --> 00:00:04,000', 'KVCache reduces traffic.', '',
    '3', '00:00:04,000 --> 00:00:06,000', 'These caches are shared.', ''
  ].join('\n'), 'utf8')
  await writeFile(join(directory, 'zh_cues.tsv'), chinese, 'utf8')
  await writeFile(join(directory, 'translation-glossary.json'), `${JSON.stringify({
    schemaVersion: 1,
    currentTaskId: manifest.taskId,
    mode: 'resolved',
    stats: { candidateTasks: 1, validArtifacts: 1, skippedArtifacts: 0, historicalEntries: 1, settingsEntries: 0 },
    entries: [{
      source: 'cache',
      target: '缓存',
      authority: 'historical',
      contextSamples: ['Warm the cache.'],
      sourceTaskId: crypto.randomUUID(),
      sourceAuditSha256: '2'.repeat(64),
      sourceProducer: 'user-glossary-edit'
    }]
  }, null, 2)}\n`, 'utf8')
  manifest.artifacts.chineseCues = await artifact(directory, 'zh_cues.tsv', 'codex')
  manifest.artifacts.translationGlossary = await artifact(directory, 'translation-glossary.json', 'historical-glossary-resolver')
  await store.create(directory, manifest)
  return { directory, store, manifest }
}

async function auditProvider(root: string, responses: readonly unknown[]): Promise<{
  executable: string
  argsLog: string
  promptLog: string
  artifactProbeLog: string
}> {
  const executable = join(root, 'fake-codex')
  const argsLog = join(root, 'audit-args.log')
  const promptLog = join(root, 'audit-prompts.log')
  const artifactProbeLog = join(root, 'audit-artifact-probes.log')
  const countFile = join(root, 'audit-count')
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log('fake-codex 1.0')
  process.exit(0)
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using test fixture')
  process.exit(0)
}
const prompt = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(' ') + '\\n')
fs.appendFileSync(${JSON.stringify(promptLog)}, prompt + '\\n---PROMPT---\\n')
fs.appendFileSync(${JSON.stringify(artifactProbeLog)}, JSON.stringify({
  auditExists: fs.existsSync('audit.json'),
  chinese: fs.readFileSync('zh_cues.tsv', 'utf8')
}) + '\\n')
const countPath = ${JSON.stringify(countFile)}
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0
fs.writeFileSync(countPath, String(count + 1))
const responses = ${JSON.stringify(responses)}
const response = responses[Math.min(count, responses.length - 1)]
${codexLifecycleScript(
  JSON.stringify(codexSessionId('audit-repair-session')),
  "typeof response === 'string' ? response : JSON.stringify(response)"
)}
`, 'utf8')
  await chmod(executable, 0o755)
  return { executable, argsLog, promptLog, artifactProbeLog }
}

describe('TaskPipeline historical glossary guard', { timeout: 30_000 }, () => {
  it('discards a global-audit session after any tool call and retries in a fresh generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-tool-contamination-'))
    directories.push(root)
    const { directory, store } = await historicalAuditTask(root)
    const executable = join(root, 'fake-codex')
    const countFile = join(root, 'count')
    const argsLog = join(root, 'args.log')
    const result = {
      glossary: [],
      patches: [],
      historicalClassifications: [
        { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
        { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
      ]
    }
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log('fake-codex 1.0')
  process.exit(0)
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using test fixture')
  process.exit(0)
}
fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(' ') + '\\n')
const count = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) : 0
fs.writeFileSync(${JSON.stringify(countFile)}, String(count + 1))
${codexLifecycleScript(
  `count === 0 ? ${JSON.stringify(codexSessionId('audit-repair-session'))} : ${JSON.stringify(codexSessionId('audit-clean-session'))}`,
  JSON.stringify(JSON.stringify(result)),
  "if (count === 0) console.log(JSON.stringify({ type: 'item.started', item: { type: 'web_search', query: 'untrusted audit text' } }))"
)}
`, 'utf8')
    await chmod(executable, 0o755)
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await expect(pipeline.start(directory)).rejects.toThrow('尝试调用工具：web_search')

    const failed = await store.load(directory)
    expect(failed.pipeline.stages.audit).toMatchObject({
      status: 'failed',
      errorCode: expect.stringContaining(PROVIDER_SESSION_CONTAMINATED_PREFIX)
    })
    expect(failed.artifacts.audit).toBeUndefined()
    expect(failed.translation.sessionGenerations).toHaveLength(1)

    await pipeline.start(directory)

    const completed = await store.load(directory)
    expect(completed.pipeline.stages.audit.status).toBe('completed')
    expect(completed.translation.sessionGenerations).toHaveLength(2)
    expect(completed.translation.sessionGenerations[0]).toMatchObject({
      status: 'lost',
      externalSessionId: codexSessionId('audit-repair-session')
    })
    expect(completed.translation.sessionGenerations[1]).toMatchObject({
      status: 'active',
      reason: 'resume-replacement',
      externalSessionId: codexSessionId('audit-clean-session')
    })
    const args = (await readFile(argsLog, 'utf8')).trim().split('\n')
    expect(args[0]).toContain(`resume --json --skip-git-repo-check ${codexSessionId('audit-repair-session')} -`)
    expect(args[1]).not.toContain(' resume ')
  })

  it('starts audit in a fresh replacement session after the previous resume was terminally lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-replacement-'))
    directories.push(root)
    const { directory, store } = await historicalAuditTask(root)
    await store.mutate(directory, (manifest) => {
      manifest.translation.sessionGenerations[0].externalSessionId = codexSessionId('lost-audit-session')
      manifest.pipeline.stages.audit.status = 'failed'
      manifest.pipeline.stages.audit.errorCode = `${PROVIDER_SESSION_UNAVAILABLE_PREFIX}thread not found`
    })
    const provider = await auditProvider(root, [{
      glossary: [],
      patches: [],
      historicalClassifications: [
        { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
        { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
      ]
    }])
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = provider.executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(directory)

    const completed = await store.load(directory)
    expect(completed.pipeline.stages.audit.status).toBe('completed')
    expect(completed.translation.sessionGenerations).toHaveLength(2)
    expect(completed.translation.sessionGenerations[0]).toMatchObject({
      status: 'lost',
      reason: 'initial',
      externalSessionId: codexSessionId('lost-audit-session')
    })
    expect(completed.translation.sessionGenerations[1]).toMatchObject({
      status: 'active',
      reason: 'resume-replacement',
      externalSessionId: codexSessionId('audit-repair-session')
    })
    const args = (await readFile(provider.argsLog, 'utf8')).trim()
    expect(args).not.toContain(' resume ')
    expect(args).toContain('--ignore-user-config')
  })

  it('does not reacquire or mutate an audit checkpoint when start is called again', async () => {
    const { directory, store, pipeline } = await checkpointTask()
    const before = await store.load(directory)
    await pipeline.start(directory)
    const after = await store.load(directory)
    expect(after).toEqual(before)
    expect(after.pipeline.stages.audit).toMatchObject({ status: 'checkpoint', attempt: 0 })
  })

  it('does not reacquire or mutate a manual-review checkpoint when start is called again', async () => {
    const { directory, store, pipeline } = await manualReviewTask()
    const before = await store.load(directory)
    await pipeline.start(directory)
    const after = await store.load(directory)
    expect(after).toEqual(before)
    expect(after.pipeline.stages.review).toMatchObject({ status: 'checkpoint', attempt: 0 })
  })

  it('does not execute an earlier non-terminal stage while a later checkpoint is unresolved', async () => {
    const { directory, store, pipeline } = await manualReviewTask()
    const current = await store.load(directory)
    const inconsistent = await store.mutate(directory, (manifest) => {
      manifest.pipeline.stages.source.status = 'ready'
    }, current.revision)
    await pipeline.start(directory)
    const after = await store.load(directory)
    expect(after).toEqual(inconsistent)
    expect(after.pipeline.stages.source).toMatchObject({ status: 'ready', attempt: 0 })
    expect(after.pipeline.stages.review).toMatchObject({ status: 'checkpoint', attempt: 0 })
  })

  it('always pauses at manual review and advances only after an expected-revision confirmation', async () => {
    const { directory, store, pipeline } = await manualReviewTask('ready')
    await pipeline.start(directory)
    const checkpoint = await store.load(directory)
    expect(checkpoint.pipeline.stages.review).toMatchObject({
      status: 'checkpoint',
      checkpointId: 'manual-review',
      errorCode: '等待人工校对字幕与术语'
    })
    expect(checkpoint.pipeline.stages.srt.status).toBe('pending')
    await expect(pipeline.completeReview(directory, checkpoint.revision - 1)).rejects.toThrow('请刷新后重试')

    const completed = await pipeline.completeReview(directory, checkpoint.revision)
    expect(completed.pipeline.stages.review.status).toBe('completed')
    expect(completed.pipeline.stages.review.checkpointId).toBeUndefined()
    expect(completed.pipeline.stages.srt.status).toBe('ready')
  })

  it('keeps the manual-review checkpoint when a manual edit no longer matches the English cue', async () => {
    const { directory, store, pipeline } = await manualReviewTask()
    const before = await store.load(directory)
    const damaged = await store.mutate(directory, (manifest) => {
      manifest.translation.manualEdits[0].englishCueHash = '0'.repeat(64)
    }, before.revision)

    await expect(pipeline.completeReview(directory, damaged.revision)).rejects.toThrow('cue 1 的上游英文字幕已变化')
    expect((await store.load(directory)).pipeline.stages.review).toMatchObject({
      status: 'checkpoint',
      checkpointId: 'manual-review'
    })
  })

  it('keeps the manual-review checkpoint when the selected English artifact changes on disk', async () => {
    const { directory, store, pipeline } = await manualReviewTask()
    const before = await store.load(directory)
    await writeFile(join(directory, 'english.clean.srt'), '1\n00:00:00,000 --> 00:00:02,000\nWorld Cub.\n', 'utf8')

    await expect(pipeline.completeReview(directory, before.revision)).rejects.toThrow('英文清理字幕产物 SHA-256 不匹配')
    expect((await store.load(directory)).pipeline.stages.review).toMatchObject({
      status: 'checkpoint',
      checkpointId: 'manual-review'
    })
  })

  it('keeps the manual-review checkpoint when the selected Chinese artifact changes on disk at the same revision', async () => {
    const { directory, store, pipeline } = await manualReviewTask()
    const before = await store.load(directory)
    await writeFile(join(directory, 'zh_cues.tsv'), '1\t世界盃。\n', 'utf8')

    await expect(pipeline.completeReview(directory, before.revision)).rejects.toThrow('中文字幕产物 SHA-256 不匹配')
    expect((await store.load(directory)).pipeline.stages.review).toMatchObject({
      status: 'checkpoint',
      checkpointId: 'manual-review'
    })
  })

  it('keeps the manual-review checkpoint when the selected Chinese cue IDs no longer align with English', async () => {
    const { directory, store, pipeline } = await manualReviewTask()
    await writeFile(join(directory, 'zh_cues.tsv'), '1\t世界杯。\n2\t额外字幕。\n', 'utf8')
    const invalidChinese = await artifact(directory, 'zh_cues.tsv', 'global-audit')
    const before = await store.load(directory)
    const selected = await store.mutate(directory, (manifest) => {
      manifest.artifacts.chineseCues = invalidChinese
    }, before.revision)

    await expect(pipeline.completeReview(directory, selected.revision)).rejects.toThrow('中英文 cue 数不一致：2/1')
    expect((await store.load(directory)).pipeline.stages.review).toMatchObject({
      status: 'checkpoint',
      checkpointId: 'manual-review'
    })
  })

  it('keeps the manual-review checkpoint when the selected audit artifact changes on disk at the same revision', async () => {
    const { directory, store, pipeline } = await manualReviewTask()
    const before = await store.load(directory)
    const tampered = (await readFile(join(directory, 'audit.json'), 'utf8')).replace('世界杯', '世界盃')
    await writeFile(join(directory, 'audit.json'), tampered, 'utf8')

    await expect(pipeline.completeReview(directory, before.revision)).rejects.toThrow('审计产物 SHA-256 不匹配')
    expect((await store.load(directory)).pipeline.stages.review).toMatchObject({
      status: 'checkpoint',
      checkpointId: 'manual-review'
    })
  })

  it('keeps the manual-review checkpoint when the selected audit artifact has an invalid schema', async () => {
    const { directory, store, pipeline } = await manualReviewTask()
    await writeFile(join(directory, 'audit.json'), '{"glossary":"invalid","patches":[]}\n', 'utf8')
    const invalidAudit = await artifact(directory, 'audit.json', 'global-audit')
    const before = await store.load(directory)
    const selected = await store.mutate(directory, (manifest) => {
      manifest.artifacts.audit = invalidAudit
    }, before.revision)

    await expect(pipeline.completeReview(directory, selected.revision)).rejects.toThrow()
    expect((await store.load(directory)).pipeline.stages.review).toMatchObject({
      status: 'checkpoint',
      checkpointId: 'manual-review'
    })
  })

  it('keeps the manual-review checkpoint when audit data references a cue outside the current subtitles', async () => {
    const { directory, store, pipeline } = await manualReviewTask()
    await writeFile(join(directory, 'audit.json'), `${JSON.stringify({
      glossary: [{ source: 'World Cup', target: '世界杯', cueIds: [999] }],
      patches: [],
      historicalClassifications: []
    })}\n`, 'utf8')
    const invalidAudit = await artifact(directory, 'audit.json', 'global-audit')
    const before = await store.load(directory)
    const selected = await store.mutate(directory, (manifest) => {
      manifest.artifacts.audit = invalidAudit
    }, before.revision)

    await expect(pipeline.completeReview(directory, selected.revision)).rejects.toThrow('审计产物引用了不存在的 cue：999')
    expect((await store.load(directory)).pipeline.stages.review).toMatchObject({
      status: 'checkpoint',
      checkpointId: 'manual-review'
    })
  })

  it('does not let an audit checkpoint decision bypass the frozen historical glossary', async () => {
    const { directory, store, pipeline } = await checkpointTask()

    await expect(pipeline.resolveAudit(directory, [{ cueId: 1, translation: '一个代理在运行。' }]))
      .rejects.toThrow('历史术语终检未通过')
    expect(await readFile(join(directory, 'zh_cues.tsv'), 'utf8').then((value) => value.trim())).toBe('1\t一个智能体在运行。')
    expect((await store.load(directory)).pipeline.stages.audit.status).toBe('checkpoint')
  })

  it('commits audit decisions through unique artifacts without overwriting the previous version', async () => {
    const { directory, store, pipeline } = await checkpointTask()
    const previousChinese = await readFile(join(directory, 'zh_cues.tsv'), 'utf8')
    const previousAudit = await readFile(join(directory, 'audit.json'), 'utf8')

    const updated = await pipeline.resolveAudit(directory, [{ cueId: 1, translation: '一个智能体正在运行。' }])

    expect(updated.pipeline.stages.audit.status).toBe('completed')
    expect(updated.artifacts.chineseCues.relativePath).toMatch(/^zh_cues\.audit-[0-9a-f-]+\.tsv$/u)
    expect(updated.artifacts.audit.relativePath).toMatch(/^audit\.resolved-[0-9a-f-]+\.json$/u)
    expect(await readFile(join(directory, 'zh_cues.tsv'), 'utf8')).toBe(previousChinese)
    expect(await readFile(join(directory, 'audit.json'), 'utf8')).toBe(previousAudit)
    expect(await readFile(join(directory, updated.artifacts.chineseCues.relativePath), 'utf8')).toBe('1\t一个智能体正在运行。\n')
    expect(JSON.parse(await readFile(join(directory, updated.artifacts.audit.relativePath), 'utf8')).resolutions)
      .toEqual([{ cueId: 1, translation: '一个智能体正在运行。' }])
    expect((await store.load(directory)).artifacts.audit.relativePath).toBe(updated.artifacts.audit.relativePath)
  })

  it('removes uncommitted candidates when a concurrent revision wins the CAS', async () => {
    const { directory, store, pipeline } = await checkpointTask()
    const before = await store.load(directory)
    const mutate = store.mutate.bind(store)
    let injected = false
    vi.spyOn(store, 'mutate').mockImplementation(async (taskDirectory, change, expectedRevision) => {
      if (!injected) {
        injected = true
        await mutate(taskDirectory, (manifest) => { manifest.title = '并发更新' })
      }
      return mutate(taskDirectory, change, expectedRevision)
    })

    await expect(pipeline.resolveAudit(directory, [{ cueId: 1, translation: '一个智能体正在运行。' }]))
      .rejects.toThrow('请刷新后重试')

    const after = await store.load(directory)
    expect(after.artifacts.chineseCues.relativePath).toBe(before.artifacts.chineseCues.relativePath)
    expect(after.artifacts.audit.relativePath).toBe(before.artifacts.audit.relativePath)
    expect(await readFile(join(directory, 'zh_cues.tsv'), 'utf8')).toBe('1\t一个智能体在运行。\n')
    expect((await readdir(directory)).filter((name) =>
      /^zh_cues\.audit-|^audit\.resolved-/u.test(name)
    )).toEqual([])
  })

  it('freezes historical glossary context and enforces it through translate and audit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-pipeline-history-e2e-'))
    directories.push(root)
    const historyDirectory = join(root, 'history')
    const currentDirectory = join(root, 'current')
    await Promise.all([mkdir(historyDirectory), mkdir(currentDirectory)])
    const store = new TaskStore()

    const history = createTaskManifest({ kind: 'url', url: 'https://example.com/history' }, 'Historical Agent Video', 'codex')
    for (const stage of Object.values(history.pipeline.stages)) stage.status = 'completed'
    await writeFile(join(historyDirectory, 'english.clean.srt'), '1\n00:00:00,000 --> 00:00:02,000\nAn agent handles the task.\n', 'utf8')
    await writeFile(join(historyDirectory, 'audit.json'), `${JSON.stringify({
      glossary: [{ source: 'agent', target: '智能体', cueIds: [1] }],
      patches: []
    })}\n`, 'utf8')
    history.artifacts.englishClean = await artifact(historyDirectory, 'english.clean.srt', 'etch-srt')
    history.artifacts.audit = await artifact(historyDirectory, 'audit.json', 'user-glossary-edit')
    await store.create(historyDirectory, history)

    const current = createTaskManifest({ kind: 'url', url: 'https://example.com/current' }, 'Current Agent Video', 'codex')
    for (const stage of ['source', 'inspect', 'english', 'cues'] as const) current.pipeline.stages[stage].status = 'completed'
    for (const stage of ['review', 'srt', 'burn', 'verify'] as const) current.pipeline.stages[stage].status = 'skipped'
    await writeFile(join(currentDirectory, 'english.clean.srt'), '1\n00:00:00,000 --> 00:00:02,000\nAn agent runs.\n', 'utf8')
    await store.create(currentDirectory, current)

    const fakeCodex = join(root, 'fake-codex')
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log('fake-codex 1.0')
  process.exit(0)
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using test fixture')
  process.exit(0)
}
const prompt = fs.readFileSync(0, 'utf8')
let providerText
if (prompt.includes('historicalClassifications')) {
  providerText = ${JSON.stringify(JSON.stringify({
    glossary: [{ source: 'agent', target: '智能体', cueIds: [1] }],
    patches: [],
    historicalClassifications: [{ source: 'agent', cueId: 1, target: '智能体', reason: '历史语义相同' }]
  }))}
} else if (prompt.includes('历史视频审计术语（必须遵守）')) {
  providerText = '1\\t一个智能体在运行。'
} else {
  console.error('missing historical glossary prompt')
  process.exit(9)
}
${codexLifecycleScript(JSON.stringify(codexSessionId('history-session')), 'providerText')}
`, 'utf8')
    await chmod(fakeCodex, 0o755)
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = fakeCodex
    const historical = new HistoricalGlossaryService(store, () => [{
      taskId: history.taskId,
      location: historyDirectory,
      title: history.title,
      kind: history.kind,
      category: history.category,
      revision: history.revision,
      status: 'completed',
      updatedAt: history.updatedAt
    }])
    const pipeline = new TaskPipeline(store, settings, historical, () => undefined)

    await pipeline.start(currentDirectory)

    const completed = await store.load(currentDirectory)
    expect(completed.pipeline.stages.translate.status).toBe('completed')
    expect(completed.pipeline.stages.audit.status).toBe('completed')
    const snapshot = JSON.parse(await readFile(
      join(currentDirectory, completed.artifacts.translationGlossary.relativePath),
      'utf8'
    ))
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ source: 'agent', target: '智能体', authority: 'historical' })
    ])
    expect(await readFile(join(currentDirectory, completed.artifacts.chineseCues.relativePath), 'utf8'))
      .toBe('1\t一个智能体在运行。\n')
    expect(JSON.parse(await readFile(join(currentDirectory, completed.artifacts.audit.relativePath), 'utf8')).glossary)
      .toEqual([{ source: 'agent', target: '智能体', cueIds: [1] }])
  })

  it.each([
    {
      label: 'missing plural match',
      first: [{ source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' }],
      failure: '历史术语 cache 未完整分类 cue：3'
    },
    {
      label: 'extra embedded match',
      first: [
        { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
        { source: 'cache', cueId: 2, target: null, reason: 'KVCache 是另一术语' },
        { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
      ],
      failure: '历史术语 cache 分类引用了不匹配的 cue：2'
    }
  ])('repairs $label audit classifications in the same provider session', async ({ first, failure }) => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-repair-'))
    directories.push(root)
    const { directory, store } = await historicalAuditTask(root)
    const correct = [
      { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
      { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
    ]
    const provider = await auditProvider(root, [
      { glossary: [], patches: [], historicalClassifications: first },
      { glossary: [], patches: [], historicalClassifications: correct }
    ])
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = provider.executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(directory)

    const completed = await store.load(directory)
    expect(completed.pipeline.stages.audit).toMatchObject({ status: 'completed', attempt: 1 })
    expect(JSON.parse(await readFile(join(directory, completed.artifacts.audit.relativePath), 'utf8')).glossary)
      .toEqual([{ source: 'cache', target: '缓存', cueIds: [1, 3] }])
    const args = (await readFile(provider.argsLog, 'utf8')).trim().split('\n')
    expect(args).toHaveLength(2)
    expect(args.every((line) =>
      line.includes('--ignore-user-config')
      && line.includes('--disable hooks')
      && line.includes(`resume --json --skip-git-repo-check ${codexSessionId('audit-repair-session')} -`)
    )).toBe(true)
    const prompts = await readFile(provider.promptLog, 'utf8')
    expect(prompts).toContain('"section":"historical-cue-matches","data":[{"source":"cache","cueIds":[1,3]}]')
    expect(prompts).toContain(`"section":"audit-validation-failure","data":${JSON.stringify(failure)}`)
    const providerLogs = (await readdir(directory)).filter((file) => file.startsWith('provider-'))
    expect(providerLogs).toHaveLength(2)
    expect(providerLogs.some((file) => file.startsWith('provider-audit-attempt-01-'))).toBe(true)
    expect(providerLogs.some((file) => file.startsWith('provider-audit-attempt-02-'))).toBe(true)
  })

  it('merges a patch-only historical-term repair without accepting its incomplete audit fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-targeted-repair-'))
    directories.push(root)
    const original = '1\t预热缓冲。\n2\tKVCache 可降低流量。\n3\t这些缓存是共享的。\n'
    const { directory, store } = await historicalAuditTask(root, original)
    const classifications = [
      { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
      { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
    ]
    const repairPatch = {
      cueId: 1,
      before: '预热缓冲。',
      after: '预热缓存。',
      reason: '历史术语 cache 必须统一为缓存',
      confidence: 'high'
    }
    const provider = await auditProvider(root, [
      { glossary: [], patches: [], historicalClassifications: classifications },
      {
        glossary: [{ source: 'cache', target: '缓存', cueIds: [1] }],
        patches: [repairPatch],
        historicalClassifications: [{ source: 'cache', target: '缓存', cueIds: [1], classification: 'historical-required' }]
      }
    ])
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = provider.executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(directory)

    const completed = await store.load(directory)
    expect(completed.pipeline.stages.audit).toMatchObject({ status: 'completed', attempt: 1 })
    expect(await readFile(join(directory, completed.artifacts.chineseCues.relativePath), 'utf8'))
      .toBe('1\t预热缓存。\n2\tKVCache 可降低流量。\n3\t这些缓存是共享的。\n')
    expect(JSON.parse(await readFile(join(directory, completed.artifacts.audit.relativePath), 'utf8'))).toMatchObject({
      patches: [repairPatch],
      historicalClassifications: classifications
    })
    const prompts = (await readFile(provider.promptLog, 'utf8')).split('\n---PROMPT---\n')
    expect(prompts).toHaveLength(3)
    expect(prompts[1]).toContain('只返回这个 JSON 对象：{"patches":')
    expect(prompts[1]).toContain('"cueId":1')
    expect(prompts[1]).toContain('"before":"预热缓冲。"')
    expect((await readFile(provider.argsLog, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it.each([
    { label: 'malformed JSON', first: 'not-json', failure: '审计输出中没有合法 JSON 对象' },
    {
      label: 'invalid schema',
      first: { glossary: 'invalid', patches: [], historicalClassifications: [] },
      failure: '"section":"audit-validation-failure"'
    }
  ])('repairs $label in the same lease and provider session', async ({ first, failure }) => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-structure-repair-'))
    directories.push(root)
    const { directory, store } = await historicalAuditTask(root)
    const correct = [
      { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
      { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
    ]
    const provider = await auditProvider(root, [
      first,
      { glossary: [], patches: [], historicalClassifications: correct }
    ])
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = provider.executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(directory)

    const completed = await store.load(directory)
    expect(completed.pipeline.stages.audit).toMatchObject({ status: 'completed', attempt: 1 })
    expect((await readFile(provider.argsLog, 'utf8')).trim().split('\n')).toHaveLength(2)
    expect(await readFile(provider.promptLog, 'utf8')).toContain(failure)
  })

  it('repairs an unknown historical source without publishing the invalid first response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-unknown-source-'))
    directories.push(root)
    const original = '1\t预热缓存。\n2\tKVCache 可降低流量。\n3\t这些缓存是共享的。\n'
    const { directory, store } = await historicalAuditTask(root, original)
    const correct = [
      { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
      { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
    ]
    const provider = await auditProvider(root, [
      {
        glossary: [{ source: 'invented', target: '杜撰', cueIds: [999] }],
        patches: [{ cueId: 998, before: '不存在', after: '仍不存在', reason: '越界歧义', confidence: 'ambiguous' }],
        historicalClassifications: [
          ...correct,
          { source: 'KVCache', cueId: 999, target: null, reason: '模型自行添加的未知 source' }
        ]
      },
      { glossary: [], patches: [], historicalClassifications: correct }
    ])
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = provider.executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(directory)

    expect((await store.load(directory)).pipeline.stages.audit.status).toBe('completed')
    const prompts = await readFile(provider.promptLog, 'utf8')
    expect(prompts).toContain('"section":"audit-validation-failure","data":"历史术语分类引用了未知 source：KVCache"')
    const probes = (await readFile(provider.artifactProbeLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      auditExists: boolean
      chinese: string
    })
    expect(probes).toEqual([
      { auditExists: false, chinese: original },
      { auditExists: false, chinese: original }
    ])
  })

  it('repairs out-of-range glossary and ambiguous patch cue references before publishing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-invalid-cue-reference-'))
    directories.push(root)
    const { directory, store } = await historicalAuditTask(root)
    const correct = [
      { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
      { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
    ]
    const provider = await auditProvider(root, [
      {
        glossary: [{ source: 'invented', target: '杜撰', cueIds: [999] }],
        patches: [{ cueId: 998, before: '不存在', after: '仍不存在', reason: '越界歧义', confidence: 'ambiguous' }],
        historicalClassifications: correct
      },
      { glossary: [], patches: [], historicalClassifications: correct }
    ])
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = provider.executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(directory)

    expect((await store.load(directory)).pipeline.stages.audit.status).toBe('completed')
    expect(await readFile(provider.promptLog, 'utf8')).toContain(
      '"section":"audit-validation-failure","data":"审计响应引用了不存在的 cue：glossary 999；patch 998"'
    )
    const probes = (await readFile(provider.artifactProbeLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { auditExists: boolean })
    expect(probes.every((probe) => !probe.auditExists)).toBe(true)
  })

  it('restarts each audit repair from the original Chinese cue map', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-clean-map-'))
    directories.push(root)
    const original = '1\t预热缓冲。\n2\tKVCache 可降低流量。\n3\t这些缓存是共享的。\n'
    const { directory, store } = await historicalAuditTask(root, original)
    const classifications = [
      { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
      { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
    ]
    const validPatch = { cueId: 1, before: '预热缓冲。', after: '预热缓存。', reason: '采用历史术语', confidence: 'high' }
    const provider = await auditProvider(root, [
      {
        glossary: [],
        patches: [validPatch, { cueId: 3, before: '错误 before', after: '这些缓存是共享的。', reason: '错误', confidence: 'high' }],
        historicalClassifications: classifications
      },
      { glossary: [], patches: [validPatch], historicalClassifications: classifications }
    ])
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = provider.executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(directory)

    const completed = await store.load(directory)
    expect(completed.pipeline.stages.audit.status).toBe('completed')
    expect(await readFile(join(directory, completed.artifacts.chineseCues.relativePath), 'utf8'))
      .toBe('1\t预热缓存。\n2\tKVCache 可降低流量。\n3\t这些缓存是共享的。\n')
    expect((await readFile(provider.promptLog, 'utf8'))).toContain('审计 patch 3 的 before 与当前译文不一致')
  })

  it('fails audit after three invalid responses without mutating Chinese cues or publishing audit artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-repair-limit-'))
    directories.push(root)
    const original = '1\t预热缓存。\n2\tKVCache 可降低流量。\n3\t这些缓存是共享的。\n'
    const { directory, store } = await historicalAuditTask(root, original)
    const provider = await auditProvider(root, [{
      glossary: [],
      patches: [],
      historicalClassifications: [{ source: 'cache', cueId: 1, target: '缓存', reason: '漏掉复数 cue' }]
    }])
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = provider.executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await expect(pipeline.start(directory)).rejects.toThrow('审计连续 3 次未返回可校验的完整结果')

    const failed = await store.load(directory)
    expect(failed.pipeline.stages.audit.status).toBe('failed')
    expect(failed.artifacts.audit).toBeUndefined()
    expect(await readFile(join(directory, 'zh_cues.tsv'), 'utf8')).toBe(original)
    expect((await readFile(provider.argsLog, 'utf8')).trim().split('\n')).toHaveLength(3)
    expect((await readdir(directory)).filter((file) => file.startsWith('provider-audit-attempt-'))).toHaveLength(3)
  })

  it('fails closed without retrying unapproved Provider stderr during audit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-provider-failure-'))
    directories.push(root)
    const { directory, store } = await historicalAuditTask(root)
    const executable = join(root, 'fake-codex')
    const argsLog = join(root, 'provider-failure-args.log')
    const countFile = join(root, 'provider-failure-count')
    const replacement = {
      glossary: [],
      patches: [],
      historicalClassifications: [
        { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
        { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
      ]
    }
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log('fake-codex 1.0')
  process.exit(0)
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using test fixture')
  process.exit(0)
}
fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(' ') + '\\n')
const count = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) : 0
fs.writeFileSync(${JSON.stringify(countFile)}, String(count + 1))
${codexLifecycleScript(
  `count === 0 ? ${JSON.stringify(codexSessionId('audit-repair-session'))} : ${JSON.stringify(codexSessionId('audit-stderr-replacement-session'))}`,
  `count === 0 ? 'ignored' : ${JSON.stringify(JSON.stringify(replacement))}`
)}
if (count === 0) {
  console.error('provider transport failed')
  process.exit(9)
}
`, 'utf8')
    await chmod(executable, 0o755)
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await expect(pipeline.start(directory)).rejects.toThrow('Codex stderr line 1: unapproved stderr diagnostic')

    expect((await readFile(argsLog, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect((await readdir(directory)).filter((file) => file.startsWith('provider-audit-attempt-'))).toHaveLength(1)
    const failed = await store.load(directory)
    expect(failed.pipeline.stages.audit.errorCode).toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)
    expect(failed.translation.sessionGenerations).toHaveLength(1)
    expect(failed.translation.sessionGenerations[0]).toMatchObject({
      status: 'active',
      externalSessionId: codexSessionId('audit-repair-session')
    })

    await pipeline.start(directory)

    const completed = await store.load(directory)
    expect(completed.pipeline.stages.audit.status).toBe('completed')
    expect(completed.translation.sessionGenerations).toHaveLength(2)
    expect(completed.translation.sessionGenerations[0]).toMatchObject({
      status: 'lost',
      externalSessionId: codexSessionId('audit-repair-session')
    })
    expect(completed.translation.sessionGenerations[1]).toMatchObject({
      status: 'active',
      reason: 'resume-replacement',
      externalSessionId: codexSessionId('audit-stderr-replacement-session')
    })
    const args = (await readFile(argsLog, 'utf8')).trim().split('\n')
    expect(args).toHaveLength(2)
    expect(args[0]).toContain(`resume --json --skip-git-repo-check ${codexSessionId('audit-repair-session')} -`)
    expect(args[1]).not.toContain(' resume ')
  })

  it('does not retry an audit provider session-id drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-audit-session-drift-'))
    directories.push(root)
    const { directory, store } = await historicalAuditTask(root)
    const executable = join(root, 'fake-codex')
    const argsLog = join(root, 'session-drift-args.log')
    const result = {
      glossary: [],
      patches: [],
      historicalClassifications: [
        { source: 'cache', cueId: 1, target: '缓存', reason: '语义相同' },
        { source: 'cache', cueId: 3, target: '缓存', reason: '复数词面，语义相同' }
      ]
    }
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log('fake-codex 1.0')
  process.exit(0)
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using test fixture')
  process.exit(0)
}
fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(' ') + '\\n')
${codexLifecycleScript(
  JSON.stringify(codexSessionId('drifted-session')),
  JSON.stringify(JSON.stringify(result))
)}
`, 'utf8')
    await chmod(executable, 0o755)
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = executable
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await expect(pipeline.start(directory)).rejects.toThrow('Provider 没有复用指定 session')

    expect((await store.load(directory)).pipeline.stages.audit).toMatchObject({ status: 'failed', attempt: 1 })
    expect((await readFile(argsLog, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect((await readdir(directory)).filter((file) => file.startsWith('provider-audit-attempt-'))).toHaveLength(1)
  })

  it('repairs an incomplete translation batch in the same provider session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-pipeline-repair-'))
    directories.push(root)
    const taskDirectory = join(root, 'task')
    await mkdir(taskDirectory)
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/repair' }, 'Repair', 'codex')
    for (const stage of ['source', 'inspect', 'english', 'cues'] as const) manifest.pipeline.stages[stage].status = 'completed'
    for (const stage of ['review', 'srt', 'burn', 'verify'] as const) manifest.pipeline.stages[stage].status = 'skipped'
    await writeFile(join(taskDirectory, 'english.clean.srt'), [
      '1', '00:00:00,000 --> 00:00:02,000', 'with', '',
      '2', '00:00:02,000 --> 00:00:04,000', 'the LLM.', ''
    ].join('\n'), 'utf8')
    await store.create(taskDirectory, manifest)

    const argsLog = join(root, 'args.log')
    const promptLog = join(root, 'prompts.log')
    const fakeCodex = join(root, 'fake-codex')
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log('fake-codex 1.0')
  process.exit(0)
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using test fixture')
  process.exit(0)
}
const prompt = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(' ') + '\\n')
fs.appendFileSync(${JSON.stringify(promptLog)}, prompt + '\\n---PROMPT---\\n')
const providerText = prompt.includes('historicalClassifications')
  ? ${JSON.stringify(JSON.stringify({ glossary: [], patches: [], historicalClassifications: [] }))}
  : prompt.includes('上一条回复未通过批次校验')
    ? '1\\t与\\n2\\t大模型。'
    : '1\\t与大模型。\\n2\\t'
${codexLifecycleScript(JSON.stringify(codexSessionId('repair-session')), 'providerText')}
`, 'utf8')
    await chmod(fakeCodex, 0o755)
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = fakeCodex
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(taskDirectory)

    const completed = await store.load(taskDirectory)
    expect(completed.pipeline.stages.translate).toMatchObject({ status: 'completed', attempt: 1 })
    expect(completed.pipeline.stages.audit.status).toBe('completed')
    expect(completed.translation.sessionGenerations[0].externalSessionId).toBe(codexSessionId('repair-session'))
    expect(completed.translation.batches).toEqual([
      expect.objectContaining({ id: 'batch-001', startCue: 1, endCue: 2, status: 'verified' })
    ])
    const translationRuns = await readdir(join(taskDirectory, '.etch-artifacts', 'translate'))
    expect(translationRuns).toHaveLength(1)
    expect(await readFile(join(taskDirectory, '.etch-artifacts', 'translate', translationRuns[0], 'batch-001.tsv'), 'utf8'))
      .toBe('1\t与\n2\t大模型。\n')
    expect(await readFile(join(taskDirectory, 'zh_cues.tsv'), 'utf8')).toBe('1\t与\n2\t大模型。\n')
    const args = (await readFile(argsLog, 'utf8')).trim().split('\n')
    expect(args).toHaveLength(3)
    expect(args[0]).not.toContain(' resume ')
    expect(args[1]).toContain('--ignore-user-config')
    expect(args[1]).toContain(`resume --json --skip-git-repo-check ${codexSessionId('repair-session')} -`)
    expect(args[2]).toContain('--ignore-user-config')
    expect(args[2]).toContain(`resume --json --skip-git-repo-check ${codexSessionId('repair-session')} -`)
    const prompts = await readFile(promptLog, 'utf8')
    expect(prompts).toContain('上一条回复未通过批次校验')
    expect(prompts).toContain('必须恰好包含这些 cue ID：1, 2')
    expect(prompts).toContain('"cueId":1,"text":"with"')
    expect(prompts).toContain('"cueId":2,"text":"the LLM."')
    const providerLogs = (await readdir(taskDirectory)).filter((file) => file.startsWith('provider-'))
    expect(providerLogs).toHaveLength(3)
    expect(providerLogs.some((file) => file.startsWith('provider-batch-001-attempt-01-'))).toBe(true)
    expect(providerLogs.some((file) => file.startsWith('provider-batch-001-attempt-02-'))).toBe(true)
  })

  it('keeps one provider session after repairing the first of several translation batches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-pipeline-multi-batch-repair-'))
    directories.push(root)
    const taskDirectory = join(root, 'task')
    await mkdir(taskDirectory)
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/multi-batch-repair' }, 'Multi batch repair', 'codex')
    for (const stage of ['source', 'inspect', 'english', 'cues'] as const) manifest.pipeline.stages[stage].status = 'completed'
    for (const stage of ['review', 'srt', 'burn', 'verify'] as const) manifest.pipeline.stages[stage].status = 'skipped'
    const english = Array.from({ length: 151 }, (_, index) => {
      const id = index + 1
      return `${id}\n00:00:00,000 --> 00:00:01,000\nterm ${id}\n`
    }).join('\n')
    await writeFile(join(taskDirectory, 'english.clean.srt'), english, 'utf8')
    await store.create(taskDirectory, manifest)

    const argsLog = join(root, 'args.log')
    const countFile = join(root, 'translate-count')
    const fakeCodex = join(root, 'fake-codex')
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log('fake-codex 1.0')
  process.exit(0)
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using test fixture')
  process.exit(0)
}
const prompt = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(' ') + '\\n')
let providerText
if (prompt.includes('historicalClassifications')) {
  providerText = JSON.stringify({ glossary: [], patches: [], historicalClassifications: [] })
} else {
  const countPath = ${JSON.stringify(countFile)}
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0
  fs.writeFileSync(countPath, String(count + 1))
  const cueEnvelope = prompt.split(/\\r?\\n/u).find((line) => line.startsWith('{"section":"translation-cues"'))
  const cues = JSON.parse(cueEnvelope).data
  const result = cues.map((cue) => {
    const id = String(cue.cueId)
    return id + '\\t译文 ' + id
  })
  if (count === 0) result[result.length - 1] = result.at(-1).split('\\t')[0] + '\\t'
  providerText = result.join('\\n')
}
${codexLifecycleScript(JSON.stringify(codexSessionId('multi-batch-session')), 'providerText')}
`, 'utf8')
    await chmod(fakeCodex, 0o755)
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = fakeCodex
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(taskDirectory)

    const completed = await store.load(taskDirectory)
    expect(completed.pipeline.stages.translate).toMatchObject({ status: 'completed', attempt: 1 })
    expect(completed.translation.batches).toHaveLength(4)
    expect(completed.translation.sessionGenerations[0].externalSessionId).toBe(codexSessionId('multi-batch-session'))
    const output = await readFile(join(taskDirectory, 'zh_cues.tsv'), 'utf8')
    expect(output.trim().split('\n')).toHaveLength(151)
    expect(output).toContain('1\t译文 1\n')
    expect(output).toContain('151\t译文 151\n')
    const args = (await readFile(argsLog, 'utf8')).trim().split('\n')
    expect(args).toHaveLength(6)
    expect(args[0]).not.toContain(' resume ')
    expect(args.slice(1).every((line) =>
      line.includes('--ignore-user-config')
      && line.includes(`resume --json --skip-git-repo-check ${codexSessionId('multi-batch-session')} -`)
    )).toBe(true)
    const providerLogs = (await readdir(taskDirectory)).filter((file) => file.startsWith('provider-'))
    expect(providerLogs).toHaveLength(6)
    expect(providerLogs.some((file) => file.startsWith('provider-batch-004-attempt-01-'))).toBe(true)
  })

  it('fails a translation stage after three invalid batch responses without committing output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-pipeline-repair-limit-'))
    directories.push(root)
    const taskDirectory = join(root, 'task')
    await mkdir(taskDirectory)
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/repair-limit' }, 'Repair limit', 'codex')
    for (const stage of ['source', 'inspect', 'english', 'cues'] as const) manifest.pipeline.stages[stage].status = 'completed'
    for (const stage of ['review', 'srt', 'burn', 'verify'] as const) manifest.pipeline.stages[stage].status = 'skipped'
    await writeFile(join(taskDirectory, 'english.clean.srt'), '1\n00:00:00,000 --> 00:00:02,000\nwith\n\n2\n00:00:02,000 --> 00:00:04,000\nthe LLM.\n', 'utf8')
    await store.create(taskDirectory, manifest)

    const argsLog = join(root, 'args.log')
    const fakeCodex = join(root, 'fake-codex')
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log('fake-codex 1.0')
  process.exit(0)
}
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using test fixture')
  process.exit(0)
}
fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join(' ') + '\\n')
${codexLifecycleScript(JSON.stringify(codexSessionId('repair-limit-session')), "'1\\t与大模型。\\n2\\t'")}
`, 'utf8')
    await chmod(fakeCodex, 0o755)
    const settings = defaultSettings('/Users/test')
    settings.toolOverrides.codex = fakeCodex
    const pipeline = new TaskPipeline(store, settings, new HistoricalGlossaryService(store, () => []), () => undefined)

    await expect(pipeline.start(taskDirectory)).rejects.toThrow('连续 3 次未返回完整非空 cue')

    const failed = await store.load(taskDirectory)
    expect(failed.pipeline.stages.translate).toMatchObject({ status: 'failed', attempt: 1 })
    expect(failed.pipeline.stages.audit.status).toBe('pending')
    expect(failed.translation.batches).toEqual([
      expect.objectContaining({ id: 'batch-001', status: 'failed', attempt: 3 })
    ])
    expect(failed.artifacts.chineseCues).toBeUndefined()
    await expect(readFile(join(taskDirectory, 'zh_cues.tsv'), 'utf8')).rejects.toThrow()
    expect((await readFile(argsLog, 'utf8')).trim().split('\n')).toHaveLength(3)
    expect((await readdir(taskDirectory)).filter((file) => file.startsWith('provider-'))).toHaveLength(3)
  })
})
