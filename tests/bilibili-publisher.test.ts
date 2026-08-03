import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BilibiliPublisher, classifyBiliupFailure, parseBiliupReceipt, sanitizeBiliupDiagnostic } from '../src/main/bilibili-publisher'
import { AsyncRunScope } from '../src/main/runtime/async-run-scope'
import { runProcess, type ProcessResult, type ProcessSpec } from '../src/main/runtime/process-runner'
import { RunRegistry } from '../src/main/runtime/run-registry'
import type { BiliupLoginInfo } from '../src/main/storage/bilibili-account-store'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest } from '../src/shared/task-schema'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

const loginInfo: BiliupLoginInfo = {
  cookie_info: { cookies: [{ name: 'SESSDATA', value: 'session' }, { name: 'bili_jct', value: 'csrf' }] },
  sso: [],
  token_info: { access_token: 'access', expires_in: 3600, mid: 123, refresh_token: 'refresh' },
  platform: 'BiliTV'
}

async function fixture(sidecarSource: string, runExternal?: (spec: ProcessSpec) => Promise<ProcessResult>, normalizeCover?: (sourcePath: string, taskDirectory: string) => Promise<string>): Promise<{
  directory: string
  store: TaskStore
  publisher: BilibiliPublisher
  appRuns: AsyncRunScope
  finalSha256: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-bili-publisher-'))
  directories.push(directory)
  const finalBytes = Buffer.from('completed-video')
  const finalSha256 = createHash('sha256').update(finalBytes).digest('hex')
  await writeFile(join(directory, 'final.mp4'), finalBytes)
  const sidecar = join(directory, 'fake-biliup')
  await writeFile(sidecar, sidecarSource, { encoding: 'utf8', mode: 0o755 })
  await chmod(sidecar, 0o755)
  const sidecarSha256 = createHash('sha256').update(await readFile(sidecar)).digest('hex')
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/source' }, 'Finished video')
  for (const stage of Object.values(manifest.pipeline.stages)) stage.status = 'completed'
  manifest.runtime.finalRelativePath = 'final.mp4'
  manifest.runtime.completedAt = new Date().toISOString()
  manifest.artifacts.final = {
    relativePath: 'final.mp4',
    sha256: finalSha256,
    size: finalBytes.length,
    valid: true,
    producer: 'test',
    inputFingerprint: finalSha256
  }
  const store = new TaskStore()
  await store.create(directory, manifest)
  const appRuns = new AsyncRunScope()
  const settings = defaultSettings('/Users/test')
  const publisher = new BilibiliPublisher({
    store,
    accountStore: {
      account: async () => ({ status: 'connected', mid: '123', name: 'Etch Test' }),
      loginInfo: async () => loginInfo,
      markExpired: async (message) => ({ status: 'expired', message }),
      save: async () => undefined
    },
    settings: () => settings,
    sidecarPath: sidecar,
    sidecarSha256,
    temporaryRoot: join(directory, '.publish-tmp'),
    runRegistry: new RunRegistry(join(directory, 'run-registry.json'), 100),
    appRuns,
    publishManifest: () => undefined,
    runExternal: runExternal ?? ((spec) => runProcess(spec)),
    normalizeCover,
    sleep: async () => undefined
  })
  await publisher.initialize([directory])
  return { directory, store, publisher, appRuns, finalSha256 }
}

function draft(finalSha256: string) {
  return {
    title: 'Finished video',
    tid: 21,
    partitionName: '生活 · 日常',
    tags: ['字幕'],
    description: '双语视频',
    copyright: 'repost' as const,
    source: 'https://example.com/source',
    finalSha256
  }
}

function interruptedResult(): ProcessResult {
  return {
    pid: 123,
    exitCode: null,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: true
  }
}

function submittedResult(aid = '123'): ProcessResult {
  return {
    pid: 123,
    exitCode: 0,
    signal: null,
    stdout: `ResponseData { code: 0, data: Some(Object {"aid": Number(${aid}), "bvid": String("BV1TEST")}) }\nWeb 接口投稿成功`,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false
  }
}

describe('BilibiliPublisher', () => {
  it('requires both the success marker and a durable receipt', () => {
    expect(parseBiliupReceipt('Web 接口投稿成功')).toBeUndefined()
    expect(parseBiliupReceipt('ResponseData { code: 0, data: Some(Object {"aid": Number(123), "bvid": String("BV1TEST")}) }\nWeb 接口投稿成功'))
      .toEqual({ aid: '123', bvid: 'BV1TEST', resourceId: undefined })
  })

  it('separates authentication and validation failures from retryable network failures', () => {
    expect(classifyBiliupFailure('open cookies file: token expired')).toMatchObject({ code: 'auth-expired', retryable: false })
    expect(classifyBiliupFailure('connection reset by peer')).toMatchObject({ code: 'transient-network', retryable: true })
  })

  it('keeps an actionable sidecar diagnostic while removing credentials', () => {
    const output = 'upload failed: SESSDATA=secret access_token:token123 cover image decode error'
    expect(sanitizeBiliupDiagnostic(output)).toBe('upload failed: SESSDATA=[已隐藏] access_token:[已隐藏] cover image decode error')
    expect(classifyBiliupFailure(output).message).not.toContain('secret')
    expect(classifyBiliupFailure('cover image decode error')).toMatchObject({
      code: 'sidecar-failed',
      message: 'biliup 投稿失败：cover image decode error'
    })
  })

  it('normalizes a task thumbnail to a JPEG cover before invoking biliup', async () => {
    let sidecarArgs: readonly string[] = []
    const test = await fixture('#!/bin/sh\nexit 1\n', async (spec) => {
      sidecarArgs = spec.args
      return { ...interruptedResult(), cancelled: false, exitCode: 1 }
    }, async (sourcePath, taskDirectory) => {
      expect(sourcePath).toBe(join(taskDirectory, 'source.webp'))
      await mkdir(join(taskDirectory, 'publication'))
      await writeFile(join(taskDirectory, 'publication/cover.jpg'), Buffer.from('jpeg-cover'))
      return 'publication/cover.jpg'
    })
    await writeFile(join(test.directory, 'source.webp'), Buffer.from('webp-cover'))

    await test.publisher.start(test.directory, { ...draft(test.finalSha256), coverRelativePath: 'source.webp' })
    await test.appRuns.whenIdle()

    expect(sidecarArgs).toContain('--cover')
    expect(sidecarArgs).toContain(join(test.directory, 'publication/cover.jpg'))
    expect((await test.store.load(test.directory)).publication.draft?.coverRelativePath).toBe('publication/cover.jpg')
  })

  it('retries transient upload failures three times and commits only a verified receipt', async () => {
    const test = await fixture(`#!/bin/sh
counter="$PWD/.biliup-attempt"
attempt=0
if [ -f "$counter" ]; then attempt=$(cat "$counter"); fi
attempt=$((attempt + 1))
echo "$attempt" > "$counter"
if [ "$attempt" -lt 3 ]; then echo "connection reset by peer" >&2; /bin/sleep 0.1; exit 1; fi
/usr/bin/printf '%s\n' "$@" > "$PWD/.biliup-args"
/usr/bin/stat -f '%Lp' "$2" > "$PWD/.cookie-mode"
echo "Upload completed: final.mp4"
echo 'ResponseData { code: 0, data: Some(Object {"aid": Number(123), "bvid": String("BV1TEST")}), message: "0" }' >&2
echo 'Web 接口投稿成功' >&2
/bin/sleep 0.1
`)

    await test.publisher.start(test.directory, draft(test.finalSha256))
    await test.appRuns.whenIdle()
    const manifest = await test.store.load(test.directory)

    expect(manifest.publication.status, JSON.stringify(manifest.publication)).toBe('submitted')
    expect(manifest.publication.attempt).toBe(3)
    expect(manifest.publication.receipt).toEqual({ aid: '123', bvid: 'BV1TEST' })
    expect(manifest.pipeline.stages.verify.status).toBe('completed')
    const args = await readFile(join(test.directory, '.biliup-args'), 'utf8')
    expect(args).toContain('--submit\nweb\n')
    expect(args).toContain('--copyright\n2\n')
    expect(args).toContain('--source\nhttps://example.com/source\n')
    expect(args).toContain('--tid\n21\n')
    expect(args).toContain('--tag\n字幕\n')
    expect(await readFile(join(test.directory, '.cookie-mode'), 'utf8')).toBe('600\n')
    expect(await readdir(join(test.directory, '.publish-tmp'))).toEqual([])
    const persisted = await readFile(join(test.directory, 'task.json'), 'utf8')
    expect(persisted).not.toContain('SESSDATA')
    expect(persisted).not.toContain('access_token')
    expect(persisted).not.toContain('refresh_token')
  })

  it('marks an exit-zero submission without a receipt as unknown instead of retrying', async () => {
    const test = await fixture(`#!/bin/sh
echo "Upload completed: final.mp4"
echo 'Web 接口投稿成功' >&2
/bin/sleep 0.1
`)

    await test.publisher.start(test.directory, draft(test.finalSha256))
    await test.appRuns.whenIdle()
    const manifest = await test.store.load(test.directory)

    expect(manifest.publication.status, JSON.stringify(manifest.publication)).toBe('unknown')
    expect(manifest.publication.attempt).toBe(1)
    expect(manifest.publication.lastError?.code).toBe('submission-outcome-unknown')
    expect(manifest.pipeline.stages.verify.status).toBe('completed')
  })

  it('recovers interrupted publication state as paused and removes stale credential directories', async () => {
    const test = await fixture('#!/bin/sh\nexit 0\n')
    const staleDirectory = join(test.directory, '.publish-tmp', 'biliup-stale')
    await mkdir(staleDirectory, { recursive: true })
    await writeFile(join(staleDirectory, 'cookies.json'), JSON.stringify(loginInfo), { mode: 0o600 })
    await test.store.mutate(test.directory, (manifest) => {
      manifest.publication.status = 'uploading'
      manifest.publication.draft = draft(test.finalSha256)
    })

    await test.publisher.initialize([test.directory])

    expect((await test.store.load(test.directory)).publication.status).toBe('paused')
    expect(await readdir(join(test.directory, '.publish-tmp'))).toEqual([])
  })

  it('pauses a stopped upload without changing the completed Etch pipeline', async () => {
    let release: ((result: ProcessResult) => void) | undefined
    const test = await fixture('#!/bin/sh\nexit 0\n', () => new Promise((resolve) => { release = resolve }))

    await test.publisher.start(test.directory, draft(test.finalSha256))
    for (let attempt = 0; attempt < 20 && !release; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(release).toBeDefined()
    await test.publisher.stop(test.directory)
    release!(interruptedResult())
    await test.appRuns.whenIdle()

    const manifest = await test.store.load(test.directory)
    expect(manifest.publication.status).toBe('paused')
    expect(manifest.pipeline.stages.verify.status).toBe('completed')
  })

  it('marks a stop during the submission phase as unknown to prevent duplicates', async () => {
    let release: ((result: ProcessResult) => void) | undefined
    const test = await fixture('#!/bin/sh\nexit 0\n', (spec) => {
      spec.onStdout?.('Upload completed: final.mp4\n')
      return new Promise((resolve) => { release = resolve })
    })

    await test.publisher.start(test.directory, draft(test.finalSha256))
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await test.store.load(test.directory)).publication.status === 'submitting') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect((await test.store.load(test.directory)).publication.status).toBe('submitting')
    await test.publisher.stop(test.directory)
    release!(interruptedResult())
    await test.appRuns.whenIdle()

    const manifest = await test.store.load(test.directory)
    expect(manifest.publication.status).toBe('unknown')
    expect(manifest.publication.lastError?.code).toBe('submission-outcome-unknown')
  })

  it('runs only one B站 sidecar globally while preserving both receipts', async () => {
    let active = 0
    let maximumActive = 0
    let completed = 0
    const test = await fixture('#!/bin/sh\nexit 0\n', async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      completed += 1
      return submittedResult(String(100 + completed))
    })
    const secondDirectory = join(test.directory, 'second-task')
    await mkdir(secondDirectory)
    await writeFile(join(secondDirectory, 'final.mp4'), Buffer.from('completed-video'))
    const secondManifest = structuredClone(await test.store.load(test.directory))
    secondManifest.taskId = randomUUID()
    secondManifest.title = 'Second finished video'
    secondManifest.revision = 0
    secondManifest.publication = { autoPublish: false, status: 'idle', attempt: 0 }
    await test.store.create(secondDirectory, secondManifest)

    await Promise.all([
      test.publisher.start(test.directory, draft(test.finalSha256)),
      test.publisher.start(secondDirectory, draft(test.finalSha256))
    ])
    await test.appRuns.whenIdle()

    expect(maximumActive).toBe(1)
    expect((await test.store.load(test.directory)).publication.status).toBe('submitted')
    expect((await test.store.load(secondDirectory)).publication.status).toBe('submitted')
  })
})
