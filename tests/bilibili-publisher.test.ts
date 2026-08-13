import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  runRegistry: RunRegistry
  appRuns: AsyncRunScope
  accountStore: {
    markExpiredIfCurrent: ReturnType<typeof vi.fn>
    saveRefreshedIfCurrent: ReturnType<typeof vi.fn>
  }
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
  const accountStore = {
    account: async () => ({ status: 'connected' as const, mid: '123', name: 'Etch Test' }),
    loginInfo: async () => loginInfo,
    markExpiredIfCurrent: vi.fn(async (_expected, message) => ({ status: 'expired' as const, message })),
    saveRefreshedIfCurrent: vi.fn(async () => true)
  }
  const runRegistry = new RunRegistry(join(directory, 'run-registry.json'), 100)
  const publisher = new BilibiliPublisher({
    store,
    accountStore,
    settings: () => settings,
    sidecarPath: sidecar,
    sidecarSha256,
    temporaryRoot: join(directory, '.publish-tmp'),
    runRegistry,
    appRuns,
    publishManifest: () => undefined,
    runExternal: runExternal ?? ((spec) => runProcess(spec)),
    normalizeCover,
    sleep: async () => undefined
  })
  await publisher.initialize([directory])
  return { directory, store, publisher, runRegistry, appRuns, accountStore, finalSha256 }
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

  it('records a cover conversion failure on the publication instead of rejecting continue', async () => {
    const test = await fixture('#!/bin/sh\nexit 1\n', undefined, async () => {
      throw new Error('无法把任务缩略图转为 B站 JPEG 封面')
    })
    await writeFile(join(test.directory, 'source.webp'), Buffer.from('webp-cover'))

    await expect(test.publisher.start(test.directory, { ...draft(test.finalSha256), coverRelativePath: 'source.webp' })).resolves.toBeDefined()
    await test.appRuns.whenIdle()

    const manifest = await test.store.load(test.directory)
    expect(manifest.publication.status).toBe('failed')
    expect(manifest.publication.phaseMessage).toBe('投稿失败，可继续投稿')
    expect(manifest.publication.lastError?.message).toBe('无法把任务缩略图转为 B站 JPEG 封面')
    expect(manifest.pipeline.stages.verify.status).toBe('completed')
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
    await vi.waitFor(() => expect(release).toBeDefined())
    await test.publisher.stop(test.directory)
    release!(interruptedResult())
    await test.appRuns.whenIdle()

    const manifest = await test.store.load(test.directory)
    expect(manifest.publication.status).toBe('paused')
    expect(manifest.pipeline.stages.verify.status).toBe('completed')
  })

  it('ignores an upload marker that arrives after stop has already returned', async () => {
    let spec: ProcessSpec | undefined
    let release: ((result: ProcessResult) => void) | undefined
    const test = await fixture('#!/bin/sh\nexit 0\n', (nextSpec) => {
      spec = nextSpec
      return new Promise((resolve) => { release = resolve })
    })

    await test.publisher.start(test.directory, draft(test.finalSha256))
    await vi.waitFor(() => expect(spec).toBeDefined())
    const stopped = await test.publisher.stop(test.directory)
    spec!.onStdout?.('Upload completed: final.mp4\n')
    release!(interruptedResult())
    await test.appRuns.whenIdle()

    const final = await test.store.load(test.directory)
    expect(final.publication.status).toBe('paused')
    expect(final.revision).toBe(stopped.revision)
  })

  it('marks a stop during the submission phase as unknown to prevent duplicates', async () => {
    let release: ((result: ProcessResult) => void) | undefined
    const test = await fixture('#!/bin/sh\nexit 0\n', (spec) => {
      spec.onStdout?.('Upload completed: final.mp4\n')
      return new Promise((resolve) => { release = resolve })
    })

    await test.publisher.start(test.directory, draft(test.finalSha256))
    await vi.waitFor(async () => expect((await test.store.load(test.directory)).publication.status).toBe('submitting'))
    await test.publisher.stop(test.directory)
    release!(interruptedResult())
    await test.appRuns.whenIdle()

    const manifest = await test.store.load(test.directory)
    expect(manifest.publication.status).toBe('unknown')
    expect(manifest.publication.lastError?.code).toBe('submission-outcome-unknown')
  })

  it('keeps an observed submission unknown even when its manifest transition is still queued', async () => {
    let spec: ProcessSpec | undefined
    let release: ((result: ProcessResult) => void) | undefined
    const test = await fixture('#!/bin/sh\nexit 0\n', (nextSpec) => {
      spec = nextSpec
      return new Promise((resolve) => { release = resolve })
    })
    await test.publisher.start(test.directory, draft(test.finalSha256))
    await vi.waitFor(() => expect(spec).toBeDefined())

    spec!.onStdout?.('Upload completed: final.mp4\n')
    const stopped = await test.publisher.stop(test.directory)
    expect(stopped.publication.status).toBe('unknown')
    release!(submittedResult())
    await test.appRuns.whenIdle()

    expect((await test.store.load(test.directory)).publication.status).toBe('unknown')
    await expect(test.publisher.continue(test.directory)).rejects.toThrow('提交结果未知')
  })

  it('keeps a changed sidecar cookie untrusted when the same run reports authentication expiry', async () => {
    const refreshed = {
      ...loginInfo,
      token_info: { ...loginInfo.token_info, access_token: 'untrusted-refresh' }
    }
    const test = await fixture('#!/bin/sh\nexit 1\n', async (spec) => {
      const cookiePath = spec.args[1]!
      await writeFile(cookiePath, JSON.stringify(refreshed))
      return { ...interruptedResult(), cancelled: false, exitCode: 1, stderr: 'code: -101' }
    })

    await test.publisher.start(test.directory, draft(test.finalSha256))
    await test.appRuns.whenIdle()

    expect(test.accountStore.saveRefreshedIfCurrent).not.toHaveBeenCalled()
    expect(test.accountStore.markExpiredIfCurrent).toHaveBeenCalledWith(loginInfo, 'B站登录已失效，请重新扫码登录')
    expect((await test.store.load(test.directory)).publication.lastError?.code).toBe('auth-expired')
  })

  it('persists stop-all as unknown during submission and paused during upload', async () => {
    let submittingRelease: ((result: ProcessResult) => void) | undefined
    const submitting = await fixture('#!/bin/sh\nexit 0\n', (spec) => {
      spec.onStdout?.('Upload completed: final.mp4\n')
      return new Promise((resolve) => { submittingRelease = resolve })
    })
    await submitting.publisher.start(submitting.directory, draft(submitting.finalSha256))
    await vi.waitFor(async () => expect((await submitting.store.load(submitting.directory)).publication.status).toBe('submitting'))
    const stoppingSubmission = submitting.publisher.stopAllNow()
    submittingRelease!(interruptedResult())
    await stoppingSubmission
    await submitting.publisher.whenIdle()
    expect((await submitting.store.load(submitting.directory)).publication.status).toBe('unknown')

    let uploadingRelease: ((result: ProcessResult) => void) | undefined
    const uploading = await fixture('#!/bin/sh\nexit 0\n', () => new Promise((resolve) => { uploadingRelease = resolve }))
    await uploading.publisher.start(uploading.directory, draft(uploading.finalSha256))
    await vi.waitFor(() => expect(uploadingRelease).toBeDefined())
    await vi.waitFor(async () => expect((await uploading.store.load(uploading.directory)).publication.status).toBe('uploading'))
    const stoppingUpload = uploading.publisher.stopAllNow()
    uploadingRelease!(interruptedResult())
    await stoppingUpload
    await uploading.publisher.whenIdle()
    expect((await uploading.store.load(uploading.directory)).publication.status).toBe('paused')
  })

  it('persists a safe state even when stopping the external process fails', async () => {
    let release: ((result: ProcessResult) => void) | undefined
    const test = await fixture('#!/bin/sh\nexit 0\n', () => new Promise((resolve) => { release = resolve }))
    await test.publisher.start(test.directory, draft(test.finalSha256))
    await vi.waitFor(() => expect(release).toBeDefined())
    vi.spyOn(test.runRegistry, 'stopTask').mockRejectedValueOnce(new Error('kill failed'))

    await expect(test.publisher.stop(test.directory)).rejects.toThrow('B站投稿停止未完全收敛')
    expect((await test.store.load(test.directory)).publication.status).toBe('unknown')
    release!(submittedResult())
    await test.appRuns.whenIdle()
    expect((await test.store.load(test.directory)).publication.status).toBe('unknown')
    await expect(test.publisher.continue(test.directory)).rejects.toThrow('提交结果未知')
  })

  it('runs multiple B站 sidecars concurrently while preserving every receipt', async () => {
    let active = 0
    let maximumActive = 0
    let completed = 0
    let releaseUploads!: () => void
    const uploadGate = new Promise<void>((resolve) => { releaseUploads = resolve })
    let bothStarted!: () => void
    const bothStartedGate = new Promise<void>((resolve) => { bothStarted = resolve })
    const test = await fixture('#!/bin/sh\nexit 0\n', async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (active === 2) bothStarted()
      await uploadGate
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

    const starts = Promise.all([
      test.publisher.start(test.directory, draft(test.finalSha256)),
      test.publisher.start(secondDirectory, draft(test.finalSha256))
    ])
    await bothStartedGate
    releaseUploads()
    await starts
    await test.appRuns.whenIdle()

    expect(maximumActive).toBe(2)
    expect((await test.store.load(test.directory)).publication.status).toBe('submitted')
    expect((await test.store.load(secondDirectory)).publication.status).toBe('submitted')
  })

  it('admits only one sidecar when the same task is started concurrently', async () => {
    let runs = 0
    let releaseUpload!: () => void
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve })
    const test = await fixture('#!/bin/sh\nexit 0\n', async () => {
      runs += 1
      await uploadGate
      return submittedResult()
    })

    const attempts = await Promise.allSettled([
      test.publisher.start(test.directory, draft(test.finalSha256)),
      test.publisher.start(`${test.directory}/.`, draft(test.finalSha256))
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    expect(attempts.find((attempt) => attempt.status === 'rejected')?.reason).toMatchObject({ message: '这个任务已经在投稿队列中' })
    releaseUpload()
    await test.appRuns.whenIdle()
    expect(runs).toBe(1)
  })

  it('rejects every publication entry while task deletion owns acquisition', async () => {
    let blocked = true
    const test = await fixture('#!/bin/sh\nexit 0\n')
    const publisher = new BilibiliPublisher({
      store: test.store,
      accountStore: {
        account: async () => ({ status: 'connected' as const, mid: '123', name: 'Etch Test' }),
        loginInfo: async () => loginInfo,
        markExpiredIfCurrent: async (_expected, message) => ({ status: 'expired' as const, message }),
        saveRefreshedIfCurrent: async () => true
      },
      settings: () => defaultSettings('/Users/test'),
      sidecarPath: join(test.directory, 'fake-biliup'),
      sidecarSha256: createHash('sha256').update(await readFile(join(test.directory, 'fake-biliup'))).digest('hex'),
      temporaryRoot: join(test.directory, '.publish-blocked'),
      runRegistry: new RunRegistry(join(test.directory, 'blocked-run-registry.json'), 100),
      appRuns: new AsyncRunScope(),
      publishManifest: () => undefined,
      isTaskAcquisitionBlocked: () => blocked
    })

    await expect(publisher.start(test.directory, draft(test.finalSha256))).rejects.toThrow('任务正在删除')
    await expect(publisher.continue(test.directory)).rejects.toThrow('任务正在删除')
    await expect(publisher.considerAuto(test.directory)).rejects.toThrow('任务正在删除')
    blocked = false
    await expect(publisher.start(test.directory, draft(test.finalSha256))).resolves.toBeDefined()
    await publisher.whenIdle()
  })

  it('does not lose an immediate stop while the publication start is still loading', async () => {
    let releaseFirstLoad!: () => void
    const firstLoadGate = new Promise<void>((resolve) => { releaseFirstLoad = resolve })
    let firstLoadStarted!: () => void
    const firstLoadStartedGate = new Promise<void>((resolve) => { firstLoadStarted = resolve })
    let runs = 0
    const test = await fixture('#!/bin/sh\nexit 0\n', async () => {
      runs += 1
      return submittedResult()
    })
    const originalLoad = test.store.load.bind(test.store)
    let loadCount = 0
    test.store.load = async (taskDirectory) => {
      loadCount += 1
      if (loadCount === 1) {
        firstLoadStarted()
        await firstLoadGate
      }
      return originalLoad(taskDirectory)
    }

    const starting = test.publisher.start(test.directory, draft(test.finalSha256))
    await firstLoadStartedGate
    expect(test.publisher.hasDirectory(test.directory)).toBe(true)
    const stopping = test.publisher.stop(test.directory)
    const stopped = await stopping
    releaseFirstLoad()
    await expect(starting).rejects.toThrow('投稿已停止')
    await test.appRuns.whenIdle()

    expect(runs).toBe(0)
    const final = await test.store.load(test.directory)
    expect(final.publication.status).toBe('paused')
    expect(final.revision).toBe(stopped.revision)
    await expect(test.publisher.start(test.directory, draft(test.finalSha256))).resolves.toBeDefined()
    await test.appRuns.whenIdle()
  })

  it('keeps a stopped active publication restartable after the old run settles', async () => {
    let release: ((result: ProcessResult) => void) | undefined
    let runs = 0
    const test = await fixture('#!/bin/sh\nexit 0\n', () => {
      runs += 1
      if (runs === 1) return new Promise((resolve) => { release = resolve })
      return Promise.resolve(submittedResult())
    })

    await test.publisher.start(test.directory, draft(test.finalSha256))
    await vi.waitFor(() => expect(release).toBeDefined())
    await test.publisher.stop(test.directory)
    release!(interruptedResult())
    await test.appRuns.whenIdle()

    await expect(test.publisher.continue(test.directory)).resolves.toBeDefined()
    await test.appRuns.whenIdle()
    expect(runs).toBe(2)
    expect((await test.store.load(test.directory)).publication.status).toBe('submitted')
  })

  it('does not start a sidecar after stop-all catches a publication still in preflight', async () => {
    let releaseCover!: () => void
    const coverGate = new Promise<void>((resolve) => { releaseCover = resolve })
    let coverStarted!: () => void
    const coverStartedGate = new Promise<void>((resolve) => { coverStarted = resolve })
    let runs = 0
    const test = await fixture('#!/bin/sh\nexit 0\n', async () => {
      runs += 1
      return submittedResult()
    }, async (_sourcePath, taskDirectory) => {
      coverStarted()
      await coverGate
      await mkdir(join(taskDirectory, 'publication'))
      await writeFile(join(taskDirectory, 'publication/cover.jpg'), Buffer.from('jpeg-cover'))
      return 'publication/cover.jpg'
    })
    await writeFile(join(test.directory, 'source.webp'), Buffer.from('webp-cover'))

    await test.publisher.start(test.directory, { ...draft(test.finalSha256), coverRelativePath: 'source.webp' })
    await coverStartedGate
    const stopping = test.publisher.stopAllNow()
    releaseCover()
    await stopping
    await test.appRuns.whenIdle()

    expect(runs).toBe(0)
    expect(test.publisher.activeTaskCount).toBe(0)
  })
})
