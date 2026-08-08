import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
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
import { defaultSettings } from '../src/shared/settings-schema'
import { STAGE_IDS, createTaskManifest, summaryImageArtifactKey, type SummaryImagePlanEntry } from '../src/shared/task-schema'

const directories: string[] = []

afterEach(async () => {
  runProcessMock.mockReset()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5 })))
})

function png(): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1792, 0)
  ihdr.writeUInt32BE(1024, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length, 0)
    return Buffer.concat([length, Buffer.from(type, 'ascii'), body, Buffer.alloc(4)])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(randomBytes(20_000))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const PLAN: SummaryImagePlanEntry[] = ['00-cover.png', '01-overview.png', '02-alpha.png'].map((filename, index) => ({
  filename,
  alt: `配图 ${index}`,
  anchor: `章节 ${index}`,
  prompt: `hand drawn card ${index} on warm ivory paper with a red underline and Chinese labels`
}))

function pipelineFor(store: TaskStore): TaskPipeline {
  return new TaskPipeline(
    store,
    defaultSettings('/Users/test'),
    new HistoricalGlossaryService(store, () => []),
    () => undefined
  )
}

async function createIllustrateTask(store: TaskStore): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-illustrate-'))
  directories.push(directory)
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'qoder', '', 'standard', false, 'summary')
  for (const stage of STAGE_IDS) {
    if (stage === 'illustrate') manifest.pipeline.stages[stage].status = 'ready'
    else if (manifest.pipeline.stages[stage].status !== 'skipped') manifest.pipeline.stages[stage].status = 'completed'
  }
  manifest.summary.illustration = { phase: 'agent-pending', planned: PLAN, generated: [], pending: [] }
  await store.create(directory, manifest)
  return directory
}

function imageRun(cwd: string, stdin: string) {
  const base = /name 必须是 "([^"]+)"/u.exec(stdin)?.[1] ?? 'unknown'
  return { base, path: join(cwd, 'vibe_images', `${base}_1786177295.png`) }
}

function providerStdout(): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a2f0b0a4-0000-4000-8000-000000000000' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ImageGen' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })
  ].join('\n')
}

function result(stdout = '', stderr = '', exitCode = 0) {
  return { pid: 1, exitCode, signal: null, stdout, stderr, stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false }
}

describe('配图 checkpoint 状态机', () => {
  it('先停在选 agent 的 checkpoint，一次 CLI 都不调用', async () => {
    const store = new TaskStore()
    const directory = await createIllustrateTask(store)
    await pipelineFor(store).start(directory)

    const manifest = await store.load(directory)
    expect(manifest.pipeline.stages.illustrate.status).toBe('checkpoint')
    expect(manifest.pipeline.stages.illustrate.checkpointId).toBe('illustration-agent')
    expect(manifest.summary.illustration.phase).toBe('agent-pending')
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('拒绝没有配图能力的 agent，并用 CAS 拒绝陈旧决议', async () => {
    const store = new TaskStore()
    const directory = await createIllustrateTask(store)
    const pipeline = pipelineFor(store)
    await pipeline.start(directory)
    const revision = (await store.load(directory)).revision

    await expect(pipeline.resolveIllustrationAgent(directory, revision, {
      mode: 'generate',
      provider: 'opencode',
      model: { source: 'cli-default' }
    })).rejects.toThrow('不具备配图能力')

    await expect(pipeline.resolveIllustrationAgent(directory, revision - 1, {
      mode: 'generate',
      provider: 'qoder',
      model: { source: 'cli-default' }
    })).rejects.toThrow('任务已被更新')
  })

  it('选定 agent 后只生成封面并再次停下等验收', async () => {
    const store = new TaskStore()
    const directory = await createIllustrateTask(store)
    const pipeline = pipelineFor(store)
    await pipeline.start(directory)
    runProcessMock.mockImplementation(async (spec: { cwd: string; stdin: string }) => {
      const { path } = imageRun(spec.cwd, spec.stdin)
      await mkdir(join(spec.cwd, 'vibe_images'), { recursive: true })
      await writeFile(path, png())
      return result(providerStdout())
    })

    const chosen = await pipeline.resolveIllustrationAgent(directory, (await store.load(directory)).revision, {
      mode: 'generate',
      provider: 'qoder',
      model: { source: 'cli-default' }
    })
    expect(chosen.summary.illustration.phase).toBe('cover-review')
    await pipeline.start(directory)

    const manifest = await store.load(directory)
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(manifest.pipeline.stages.illustrate.checkpointId).toBe('illustration-cover')
    expect(manifest.summary.illustration.generated).toEqual(['00-cover.png'])
    const cover = manifest.artifacts[summaryImageArtifactKey('00-cover.png')]
    expect(cover?.valid).toBe(true)
    expect(cover?.relativePath).toMatch(/^\.etch-artifacts\/illustrate\/[^/]+\/00-cover\.png$/u)
    // 生成器的临时目录必须被清掉，只留下 Etch 改名后的产物。
    expect(await readdir(join(directory, cover!.relativePath, '..'))).toEqual(['00-cover.png'])
  })

  it('封面验收通过后生成其余配图并收口，换 agent 会丢弃已生成封面', async () => {
    const store = new TaskStore()
    const directory = await createIllustrateTask(store)
    const pipeline = pipelineFor(store)
    runProcessMock.mockImplementation(async (spec: { cwd: string; stdin: string }) => {
      const { path } = imageRun(spec.cwd, spec.stdin)
      await mkdir(join(spec.cwd, 'vibe_images'), { recursive: true })
      await writeFile(path, png())
      return result(providerStdout())
    })
    await pipeline.start(directory)
    await pipeline.resolveIllustrationAgent(directory, (await store.load(directory)).revision, {
      mode: 'generate',
      provider: 'qoder',
      model: { source: 'cli-default' }
    })
    await pipeline.start(directory)

    const retried = await pipeline.resolveIllustrationCover(directory, (await store.load(directory)).revision, 'retry-with-agent')
    expect(retried.summary.illustration.phase).toBe('agent-pending')
    expect(retried.summary.illustration.generated).toEqual([])
    expect(retried.summary.illustration.provider).toBeUndefined()

    await pipeline.resolveIllustrationAgent(directory, retried.revision, {
      mode: 'generate',
      provider: 'qoder',
      model: { source: 'cli-default' }
    })
    await pipeline.start(directory)
    await pipeline.resolveIllustrationCover(directory, (await store.load(directory)).revision, 'accept')
    await pipeline.start(directory)

    const manifest = await store.load(directory)
    expect(manifest.pipeline.stages.illustrate.status).toBe('completed')
    expect(manifest.summary.illustration.phase).toBe('done')
    expect(manifest.summary.illustration.generated).toEqual(PLAN.map((image) => image.filename))
    expect(manifest.summary.illustration.pending).toEqual([])
    expect(manifest.runtime.currentMessage).toBe('处理完成')
    expect(manifest.runtime.completedAt).toBeDefined()
  })

  it('跳过配图时不调用 CLI，正文带缺图交付', async () => {
    const store = new TaskStore()
    const directory = await createIllustrateTask(store)
    const pipeline = pipelineFor(store)
    await pipeline.start(directory)
    await pipeline.resolveIllustrationAgent(directory, (await store.load(directory)).revision, { mode: 'skip' })
    await pipeline.start(directory)

    const manifest = await store.load(directory)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(manifest.pipeline.stages.illustrate.status).toBe('completed')
    expect(manifest.summary.illustration.phase).toBe('skipped')
    expect(manifest.summary.illustration.pending.map((item) => item.filename)).toEqual(PLAN.map((image) => image.filename))
    expect(manifest.summary.illustration.pending[0].reason).toBe('用户选择跳过配图')
  })

  it('单张配图连续失败时记为待补，封面失败则整个阶段失败', async () => {
    const store = new TaskStore()
    const directory = await createIllustrateTask(store)
    const pipeline = pipelineFor(store)
    await pipeline.start(directory)
    runProcessMock.mockImplementation(async (spec: { cwd: string; stdin: string }) => {
      const { base, path } = imageRun(spec.cwd, spec.stdin)
      if (base === '02-alpha') return result(providerStdout())
      await mkdir(join(spec.cwd, 'vibe_images'), { recursive: true })
      await writeFile(path, png())
      return result(providerStdout())
    })
    await pipeline.resolveIllustrationAgent(directory, (await store.load(directory)).revision, {
      mode: 'generate',
      provider: 'qoder',
      model: { source: 'cli-default' }
    })
    await pipeline.start(directory)
    await pipeline.resolveIllustrationCover(directory, (await store.load(directory)).revision, 'accept')
    await pipeline.start(directory)

    const manifest = await store.load(directory)
    expect(manifest.pipeline.stages.illustrate.status).toBe('completed')
    expect(manifest.summary.illustration.generated).toEqual(['00-cover.png', '01-overview.png'])
    expect(manifest.summary.illustration.pending).toHaveLength(1)
    expect(manifest.summary.illustration.pending[0]).toMatchObject({ filename: '02-alpha.png' })
    expect(manifest.summary.illustration.pending[0].reason).toContain('未找到生成的 PNG 文件')
  })
})
