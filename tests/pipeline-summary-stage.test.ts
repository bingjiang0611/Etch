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

import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { TaskStore } from '../src/main/storage/task-store'
import { sha256File } from '../src/main/core/fingerprint'
import { defaultSettings } from '../src/shared/settings-schema'
import { STAGE_IDS, createTaskManifest } from '../src/shared/task-schema'

const directories: string[] = []

afterEach(async () => {
  runProcessMock.mockReset()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5 })))
})

function stdout(text: string, sessionId: string): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
    JSON.stringify({ type: 'result', subtype: 'success', result: text })
  ].join('\n')
}

function result(text: string, sessionId: string) {
  return {
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: stdout(text, sessionId),
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false
  }
}

const IMAGES = ['00-cover.png', '01-overview.png', '02-alpha.png', '03-beta.png', '04-gamma.png', '05-delta.png', '06-epsilon.png', '07-zeta.png']

function article(options: { images?: boolean; digestRefs?: boolean } = {}): string {
  const includeImages = options.images ?? true
  const includeDigestRefs = options.digestRefs ?? true
  const body = '这是一段足够长的正文内容，用来通过长度门禁。'.repeat(40)
  return [
    '# 算力账单如何改写利润表',
    '',
    ...(includeImages ? [`![封面](images/${IMAGES[0]})`, ''] : []),
    body,
    '',
    '## 要点速览',
    '',
    '1. **利润被算力吃掉**：节目称成本结构已经变形。',
    '2. **模型优势正在缩短**：产品差异越来越依赖分发。',
    '3. **资本开支先于收入**：投入与回报存在明显时差。',
    '4. **组织速度成为瓶颈**：工具升级没有自动带来协作升级。',
    '5. **验证比预测重要**：真正可信的是后续可追踪信号。',
    '',
    ...(includeImages ? [`![要点](images/${IMAGES[1]})`, ''] : []),
    ...IMAGES.slice(2).flatMap((filename, index) => [
      `## 【${index + 1}】第 ${index + 1} 个判断`,
      '',
      body,
      '',
      ...(includeDigestRefs ? ['<!-- digest-refs: segment-001 -->', ''] : []),
      ...(includeImages ? [`![章节图](images/${filename})`, ''] : [])
    ]),
    '## 代表性短摘与中文转述',
    '',
    '“Compute is becoming the cost of intelligence.” 中文转述：算力正在成为智能产品最直接的成本。',
    '',
    '## 注',
    '',
    '文中数字均按节目原始口径保留，并结合外部核验证据账本标注。',
    '',
    '## 最后',
    '',
    '这里是作者视角的批判性评论，指出矛盾与可追踪信号。',
    ''
  ].join('\n')
}

function candidateArticle(): string {
  return article({ images: false, digestRefs: true })
}

const DIGEST_SEGMENT = JSON.stringify({
  claims: ['算力成本改写利润表'],
  numbers: ['139%'],
  entities: ['Anthropic'],
  quotes: [{ text: 'sales does not matter', speaker: '嘉宾', note: '强调增长来自产品' }],
  stories: ['一次内部复盘'],
  tensions: ['增长与毛利冲突'],
  unverified: ['季度年化数字'],
  asrSuspects: ['Anthropik']
})

const DIGEST_REDUCE = JSON.stringify({
  throughlines: ['算力成本正在改写利润表'],
  entityGlossary: [{ surface: 'Anthropik', corrected: 'Anthropic', kind: 'company' }]
})

const DIGEST = JSON.stringify({
  schemaVersion: 1,
  metadata: {
    title: '对谈',
    channel: '示例频道',
    uploadDate: '2026-08-01',
    subtitleKind: 'manual',
    sourceUrl: 'https://example.com/video',
    chapters: []
  },
  segments: [{
    segmentId: 'segment-001',
    range: '00:00 → 00:05',
    ...JSON.parse(DIGEST_SEGMENT)
  }],
  ...JSON.parse(DIGEST_REDUCE)
})

const RESEARCH = JSON.stringify({
  schemaVersion: 1,
  mode: 'external',
  generatedAt: '2026-08-09T10:00:00.000Z',
  claims: [{
    id: 'R01',
    digestId: 'segment-001:claim:001',
    claim: '算力成本改写利润表',
    verdict: 'verified',
    sources: [{
      url: 'https://example.com/report',
      title: '官方报告',
      evidence: '报告披露算力成本对利润率的影响。',
      retrievedAt: '2026-08-09T10:00:00.000Z'
    }],
    note: '已由外部来源验证。'
  }]
})

const SCORING = JSON.stringify({
  scores: {
    A: { factuality: 9, completeness: 8, structure: 8, readability: 9, conversation: 8, finalComment: 7 },
    B: { factuality: 8, completeness: 9, structure: 7, readability: 8, conversation: 6, finalComment: 7 },
    C: { factuality: 8, completeness: 7, structure: 8, readability: 8, conversation: 7, finalComment: 9 }
  },
  baseDraft: 'A',
  baseReason: '叙事主线最完整',
  contributions: { A: ['主线连贯', '现场感强'], B: ['补季度数字', '补时间线'], C: ['指出回避', '给出追踪信号'] },
  omissions: ['B 稿的季度年化数字'],
  omissionEvidence: [{ digestId: 'segment-001', status: 'omitted', note: '底稿缺少季度数字，终稿需要吸收。' }],
  omissionNote: ''
})

const FINALIZE = JSON.stringify({
  selfCheck: '逐项核对 transcript，无编造，「最后」评论区保留',
  images: IMAGES.map((filename, index) => ({
    filename,
    alt: `配图 ${index}`,
    anchor: `章节 ${index}`,
    prompt: `hand drawn editorial card ${index} on warm ivory paper with a red underline and Chinese labels`
  }))
})

async function createSummaryTask(store: TaskStore): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-summary-stage-'))
  directories.push(directory)
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '对谈', 'qoder', '重点写数字', 'standard', false, 'summary')
  for (const stage of STAGE_IDS) {
    if (stage === 'digest' || stage === 'research') manifest.pipeline.stages[stage].status = 'completed'
    else if (stage === 'summary') manifest.pipeline.stages[stage].status = 'ready'
    else if (stage === 'illustrate') manifest.pipeline.stages[stage].status = 'pending'
    else if (manifest.pipeline.stages[stage].status !== 'skipped') manifest.pipeline.stages[stage].status = 'completed'
  }
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:04,000',
    'Compute cost is rewriting the income statement.',
    '',
    '2',
    '00:00:05,000 --> 00:00:09,000',
    'Sales does not really matter here.',
    ''
  ].join('\n')
  await writeFile(join(directory, 'english.clean.srt'), srt)
  manifest.artifacts.englishClean = {
    relativePath: 'english.clean.srt',
    sha256: await sha256File(join(directory, 'english.clean.srt')),
    size: Buffer.byteLength(srt),
    valid: true,
    producer: 'test',
    inputFingerprint: 'a'.repeat(64)
  }
  await writeFile(join(directory, 'digest.json'), DIGEST)
  manifest.artifacts.summaryDigest = {
    relativePath: 'digest.json',
    sha256: await sha256File(join(directory, 'digest.json')),
    size: Buffer.byteLength(DIGEST),
    valid: true,
    producer: 'test-digest',
    inputFingerprint: 'b'.repeat(64)
  }
  await writeFile(join(directory, 'research.json'), RESEARCH)
  manifest.artifacts.summaryResearch = {
    relativePath: 'research.json',
    sha256: await sha256File(join(directory, 'research.json')),
    size: Buffer.byteLength(RESEARCH),
    valid: true,
    producer: 'test-research',
    inputFingerprint: 'c'.repeat(64)
  }
  manifest.summary.digestSegments = 1
  manifest.summary.research = {
    status: 'completed',
    claims: JSON.parse(RESEARCH).claims,
    queryCount: 1,
    limitations: [],
    completedAt: '2026-08-09T10:00:00.000Z'
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

function respond(calls: ProcessSpec[], mergeArticle = article(), draftArticle = candidateArticle()) {
  return async (spec: ProcessSpec) => {
    calls.push(spec)
    const sessionId = argumentAfter(spec.args, '-r') ?? argumentAfter(spec.args, '--session-id')!
    if (spec.stdin.includes('请评分、择优并列出遗漏')) return result(SCORING, sessionId)
    if (spec.stdin.includes('终稿自检，以及为终稿里已有的每个配图占位')) return result(FINALIZE, sessionId)
    if (spec.stdin.includes('为底稿产出终稿')) return result(mergeArticle, sessionId)
    return result(draftArticle, sessionId)
  }
}

describe('素材分析与三稿融合阶段', () => {
  it('消费素材包与核验证据，用独立三稿会话完成融合并留下 v2 执行记录', async () => {
    const store = new TaskStore()
    const directory = await createSummaryTask(store)
    const calls: ProcessSpec[] = []
    runProcessMock.mockImplementation(respond(calls))

    await pipelineFor(store).start(directory)
    const manifest = await store.load(directory)

    expect(manifest.pipeline.stages.digest.status).toBe('completed')
    expect(manifest.pipeline.stages.summary.status).toBe('completed')
    // 配图阶段必须停下来等用户选 agent，不能自己开始出图。
    expect(manifest.pipeline.stages.illustrate.checkpointId).toBe('illustration-agent')

    // digest 与 research 已完成；summary 只运行 3 稿 + 评分 + 融合 + 自检。
    const prompts = calls.map((call) => call.stdin)
    expect(prompts).toHaveLength(6)
    expect(prompts.filter((prompt) => prompt.includes('编号 A') || prompt.includes('编号 B') || prompt.includes('编号 C'))).toHaveLength(3)
    expect(prompts.some((prompt) => prompt.includes('重点写数字'))).toBe(true)
    expect(prompts.every((prompt) => prompt.includes('BEGIN_UNTRUSTED_JSON_SECTION "summary-research"'))).toBe(true)

    const draftCalls = calls.filter((call) => /候选稿（编号 [ABC]）/u.test(call.stdin))
    const draftSessionIds = draftCalls.map((call) => argumentAfter(call.args, '--session-id'))
    expect(draftCalls.every((call) => !call.args.includes('-r'))).toBe(true)
    expect(new Set(draftSessionIds).size).toBe(3)
    const scoringCall = calls.find((call) => call.stdin.includes('请评分、择优并列出遗漏'))!
    const synthesisSessionId = argumentAfter(scoringCall.args, '--session-id')
    const synthesisFollowups = calls.filter((call) => call.stdin.includes('为底稿产出终稿') || call.stdin.includes('终稿自检'))
    expect(synthesisFollowups.map((call) => argumentAfter(call.args, '-r'))).toEqual([
      synthesisSessionId,
      synthesisSessionId
    ])

    const record = manifest.summary.draftRecord!
    expect(record.contractVersion).toBe(2)
    expect(record.drafts.map((draft) => draft.id)).toEqual(['A', 'B', 'C'])
    expect(record.baseDraft).toBe('A')
    expect(record.scoreTotals).toEqual({ A: 49, B: 45, C: 47 })
    expect(record.omissions).toEqual(['B 稿的季度年化数字'])
    expect(record.omissionEvidence).toEqual([{ digestId: 'segment-001', status: 'omitted', note: '底稿缺少季度数字，终稿需要吸收。' }])
    expect(record.selfCheck).toContain('无编造')
    expect(manifest.summary.digestSegments).toBe(1)
    expect(manifest.artifacts.summaryResearch.valid).toBe(true)
    expect(manifest.summary.illustration.planned.map((image) => image.filename)).toEqual(IMAGES)

    const drafts = await readFile(join(directory, manifest.artifacts.summaryDrafts.relativePath), 'utf8')
    expect(drafts).toContain('## 评分表')
    expect(drafts).toContain('## 遗漏清单')
    const saved = await readFile(join(directory, manifest.artifacts.summaryArticle.relativePath), 'utf8')
    expect(saved).toContain('## 最后')
    expect(saved).toContain(`![封面](images/${IMAGES[0]})`)
  })

  it('终稿缺少「最后」评论区或配图占位时不提交产物', async () => {
    const store = new TaskStore()
    const directory = await createSummaryTask(store)
    const broken = article().replace(/## 最后[\s\S]*$/u, '')
    runProcessMock.mockImplementation(respond([], broken))

    await expect(pipelineFor(store).start(directory)).rejects.toThrow(/最后/u)
    const manifest = await store.load(directory)
    expect(manifest.pipeline.stages.summary.status).toBe('failed')
    expect(manifest.artifacts.summaryArticle).toBeUndefined()
    expect(manifest.summary.draftRecord).toBeUndefined()
  })

  it('候选稿伪造 segment-999 时两次修复后仍失败，不进入评分', async () => {
    const store = new TaskStore()
    const directory = await createSummaryTask(store)
    const calls: ProcessSpec[] = []
    const forged = candidateArticle().replaceAll('segment-001', 'segment-999')
    runProcessMock.mockImplementation(respond(calls, article(), forged))

    await expect(pipelineFor(store).start(directory)).rejects.toThrow('不存在的 digest ID：segment-999')

    const manifest = await store.load(directory)
    expect(manifest.pipeline.stages.summary.status).toBe('failed')
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.stdin.includes('编号 A'))).toBe(true)
    expect(manifest.summary.draftRecord).toBeUndefined()
  })
})
