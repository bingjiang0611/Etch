import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  BilibiliPublicationDraftSchema,
  publicationTemplateReady,
  renderBilibiliDescription,
  truncateBilibiliTitle,
  type BilibiliPublicationDraft
} from '../shared/bilibili'
import type { AppSettings } from '../shared/settings-schema'
import type { TaskManifest } from '../shared/task-schema'
import { sha256ContainedFile } from './storage/safe-artifact'
import type { TaskStore } from './storage/task-store'
import { BiliupLoginInfoSchema, type BiliupLoginInfo, type BilibiliAccountStore } from './storage/bilibili-account-store'
import type { AsyncRunScope } from './runtime/async-run-scope'
import { runProcess, type ProcessResult, type ProcessSpec } from './runtime/process-runner'
import type { RunRegistry } from './runtime/run-registry'

export const BILIUP_VERSION = '1.2.2'
export const BILIUP_BINARY_SHA256 = 'ca2980a7419e2905a8e456cdfcea227f5377faaf3dca7b537d4d22870d315b3e'
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'gu')

interface PublicationJob {
  taskDirectory: string
  taskId: string
  draft: BilibiliPublicationDraft
  stopped: boolean
  submissionObserved: boolean
  completion?: Promise<void>
}

interface SidecarResult {
  result: ProcessResult
  loginInfo: BiliupLoginInfo
  refreshedLoginInfo?: BiliupLoginInfo
}

class PublicationCommitCancelled extends Error {}

interface PublisherOptions {
  store: TaskStore
  accountStore: Pick<BilibiliAccountStore, 'account' | 'loginInfo' | 'markExpiredIfCurrent' | 'saveRefreshedIfCurrent'>
  settings: () => AppSettings
  sidecarPath: string
  sidecarSha256?: string
  temporaryRoot: string
  runRegistry: RunRegistry
  appRuns: AsyncRunScope
  publishManifest(taskDirectory: string, manifest: TaskManifest): void
  runExternal?(spec: ProcessSpec): Promise<ProcessResult>
  normalizeCover?(sourcePath: string, taskDirectory: string): Promise<string>
  onActiveChange?(active: boolean): void
  sleep?(milliseconds: number): Promise<void>
  isTaskAcquisitionBlocked?(taskDirectory: string): boolean
}

export interface BilibiliReceipt {
  aid?: string
  bvid?: string
  resourceId?: string
}

export function parseBiliupReceipt(output: string): BilibiliReceipt | undefined {
  if (!/Web\s*接口投稿成功/u.test(output) || !/ResponseData\s*\{\s*code:\s*0/u.test(output)) return undefined
  const aid = output.match(/"aid"\s*:\s*(?:Number\()?"?(\d+)"?\)?/u)?.[1]
  const bvid = output.match(/"bvid"\s*:\s*(?:String\()?"(BV[0-9A-Za-z]+)"\)?/u)?.[1]
  const resourceId = output.match(/"resource_id"\s*:\s*(?:String\()?"([^"\s]+)"\)?/u)?.[1]
  return aid || bvid || resourceId ? { aid, bvid, resourceId } : undefined
}

export function classifyBiliupFailure(output: string): { code: string; message: string; retryable: boolean } {
  const compact = sanitizeBiliupDiagnostic(output)
  if (/SESSDATA|cookie|登录|oauth2\/info|access[_ ]?token|refresh[_ ]?token|Unauthorized|code:\s*-101/iu.test(compact)) {
    return { code: 'auth-expired', message: 'B站登录已失效，请重新扫码登录', retryable: false }
  }
  if (/captcha|验证码|风控|账号异常|敏感|分区|标题|标签|转载来源|copyright|code:\s*(?:-?210|211|220|601)/iu.test(compact)) {
    const platformCode = compact.match(/code:\s*(-?\d+)/iu)?.[1]
    return { code: 'platform-rejected', message: `B站拒绝了投稿参数${platformCode ? `（code ${platformCode}）` : ''}`, retryable: false }
  }
  const retryable = /timeout|timed out|connection|network|reset|broken pipe|temporar|502|503|504|dns|resolve|限流|稍后重试/iu.test(compact)
  return {
    code: retryable ? 'transient-network' : 'sidecar-failed',
    message: retryable ? 'B站上传网络异常，请稍后重试' : compact ? `biliup 投稿失败：${compact}` : 'biliup 投稿失败，但没有返回错误详情',
    retryable
  }
}

export function sanitizeBiliupDiagnostic(output: string): string {
  return output
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/("name"\s*:\s*"(?:SESSDATA|bili_jct)"\s*,\s*"value"\s*:\s*")[^"]*(")/giu, '$1[已隐藏]$2')
    .replace(/((?:SESSDATA|bili_jct|access_token|refresh_token)\s*["']?\s*[:=]\s*["']?)[^"',;\s}\]]+/giu, '$1[已隐藏]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/giu, '$1[已隐藏]')
    .replace(/\S*biliup-[^/\s]+\/cookies\.json/gu, '[临时凭证文件]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(-420)
}

export class BilibiliPublisher {
  readonly #active = new Map<string, PublicationJob>()
  readonly #startingDirectories = new Map<string, string | undefined>()
  readonly #startingTaskIds = new Set<string>()
  readonly #stopRequestedTaskIds = new Set<string>()
  readonly #stoppingDirectories = new Set<string>()
  readonly #stopOperationCounts = new Map<string, number>()
  readonly #sleep: (milliseconds: number) => Promise<void>
  #accepting = true
  #sidecarVerified = false

  constructor(private readonly options: PublisherOptions) {
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async initialize(taskDirectories: string[]): Promise<void> {
    await rm(this.options.temporaryRoot, { recursive: true, force: true })
    await mkdir(this.options.temporaryRoot, { recursive: true })
    for (const taskDirectory of taskDirectories) {
      const manifest = await this.options.store.load(taskDirectory)
      if (!['queued', 'uploading', 'submitting'].includes(manifest.publication.status)) continue
      await this.#markPausedAfterStop(taskDirectory, '上次投稿被应用退出中断，可继续投稿')
    }
  }

  hasTask(taskId: string): boolean {
    return this.#startingTaskIds.has(taskId) || this.#active.has(taskId)
  }

  hasDirectory(taskDirectory: string): boolean {
    const directoryKey = resolve(taskDirectory)
    return this.#startingDirectories.has(directoryKey) || [...this.#active.values()].some((job) => resolve(job.taskDirectory) === directoryKey)
  }

  get activeTaskCount(): number {
    return new Set([
      ...this.#startingDirectories.keys(),
      ...[...this.#active.values()].map((job) => resolve(job.taskDirectory)),
      ...this.#stopOperationCounts.keys()
    ])
      .size
  }

  freezeAcquisition(): void {
    this.#accepting = false
  }

  thawAcquisition(): void {
    this.#accepting = true
  }

  async stopAllNow(): Promise<void> {
    this.freezeAcquisition()
    const jobs = [...this.#active.values()]
    const taskDirectories = new Set([
      ...this.#startingDirectories.keys(),
      ...jobs.map((job) => resolve(job.taskDirectory))
    ])
    const taskIds = new Set([...this.#startingTaskIds, ...this.#active.keys()])
    for (const taskDirectory of taskDirectories) this.#beginDirectoryStop(taskDirectory)
    try {
      for (const taskId of taskIds) this.#stopRequestedTaskIds.add(taskId)
      for (const job of jobs) job.stopped = true
      const stoppedTaskIds = [...taskIds]
      const stopResults = await Promise.allSettled(stoppedTaskIds.map((taskId) => this.options.runRegistry.stopTask(taskId)))
      const failedStops = new Set(stopResults.flatMap((result, index) => result.status === 'rejected' ? [stoppedTaskIds[index]!] : []))
      const stateResults = await Promise.allSettled([...taskDirectories].map((taskDirectory) => {
        const active = jobs.find((job) => resolve(job.taskDirectory) === taskDirectory)
        return this.#markPausedAfterStop(
          taskDirectory,
          '已停止，可继续投稿',
          Boolean(active && (active.submissionObserved || failedStops.has(active.taskId)))
        )
      }))
      await Promise.allSettled(jobs.flatMap((job) => job.completion ? [job.completion] : []))
      const failures = [...stopResults, ...stateResults].flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'B站投稿停止未完全收敛')
    } finally {
      for (const taskDirectory of taskDirectories) this.#endDirectoryStop(taskDirectory)
    }
  }

  async whenIdle(): Promise<void> {
    while (this.activeTaskCount) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  async start(taskDirectory: string, draftInput: BilibiliPublicationDraft): Promise<TaskManifest> {
    const draft = BilibiliPublicationDraftSchema.parse(draftInput)
    const directoryKey = this.#reserveStartingDirectory(taskDirectory)
    return this.#startReserved(taskDirectory, directoryKey, draft)
  }

  async continue(taskDirectory: string): Promise<TaskManifest> {
    const directoryKey = this.#reserveStartingDirectory(taskDirectory)
    return this.#startReserved(taskDirectory, directoryKey)
  }

  async #startReserved(
    taskDirectory: string,
    directoryKey: string,
    draftInput?: BilibiliPublicationDraft
  ): Promise<TaskManifest> {
    let reservedTaskId: string | undefined
    let started = false
    try {
      const manifest = await this.options.store.load(taskDirectory)
      this.#startingDirectories.set(directoryKey, manifest.taskId)
      if (!this.#accepting) throw new Error('Etch 正在退出，拒绝启动新的投稿')
      if (this.hasTask(manifest.taskId)) throw new Error('这个任务已经在投稿队列中')
      this.#startingTaskIds.add(manifest.taskId)
      reservedTaskId = manifest.taskId
      this.#assertNotStopped(manifest.taskId, directoryKey)
      const draft = draftInput ?? manifest.publication.draft
      if (!draft) throw new Error('没有可继续的投稿草稿，请重新打开投稿弹窗')
      if (manifest.publication.status === 'submitted') throw new Error('这个任务已经确认投稿成功，不能重复投稿')
      if (manifest.publication.status === 'unknown') throw new Error('提交结果未知，请先在 B站创作中心确认，避免重复投稿')
      if ((await this.options.accountStore.account()).status !== 'connected') throw new Error('请先重新扫码连接 B站账号')
      await this.#preflight(taskDirectory, manifest, draft)
      this.#assertNotStopped(manifest.taskId, directoryKey)
      const queued = await this.options.store.mutate(taskDirectory, (next) => {
        this.#assertNotStopped(manifest.taskId, directoryKey)
        next.publication.draft = draft
        next.publication.status = 'queued'
        next.publication.phaseMessage = '正在启动投稿'
        next.publication.updatedAt = new Date().toISOString()
        delete next.publication.lastError
      })
      this.#assertNotStopped(manifest.taskId, directoryKey)
      this.options.publishManifest(taskDirectory, queued)
      const job: PublicationJob = { taskDirectory, taskId: manifest.taskId, draft, stopped: false, submissionObserved: false }
      this.#active.set(job.taskId, job)
      this.options.onActiveChange?.(true)
      const run = this.#runJob(job)
        .catch((error) => console.error('B站投稿任务失败', { taskId: job.taskId, error }))
        .finally(() => {
          if (this.#active.get(job.taskId) === job) {
            this.#active.delete(job.taskId)
            this.#maybeReleaseDirectoryStop(resolve(job.taskDirectory), job.taskId)
            this.options.onActiveChange?.(this.#active.size > 0)
          }
        })
      job.completion = run
      this.options.appRuns.track(run)
      started = true
      return queued
    } finally {
      if (reservedTaskId) {
        this.#startingTaskIds.delete(reservedTaskId)
        if (!started && !this.#active.has(reservedTaskId)) this.#stopRequestedTaskIds.delete(reservedTaskId)
      }
      this.#startingDirectories.delete(directoryKey)
      this.#maybeReleaseDirectoryStop(directoryKey, reservedTaskId)
    }
  }

  async stop(taskDirectory: string): Promise<TaskManifest> {
    const directoryKey = resolve(taskDirectory)
    this.#beginDirectoryStop(directoryKey)
    let stoppedTaskId: string | undefined
    try {
      const manifest = await this.options.store.load(taskDirectory)
      stoppedTaskId = manifest.taskId
      this.#stopRequestedTaskIds.add(manifest.taskId)
      const active = this.#active.get(manifest.taskId)
      if (active) active.stopped = true
      const [stopResult] = await Promise.allSettled([
        active ? this.options.runRegistry.stopTask(manifest.taskId) : Promise.resolve()
      ])
      const [stateResult] = await Promise.allSettled([this.#markPausedAfterStop(
        taskDirectory,
        '已停止，可继续投稿',
        Boolean(active && (active.submissionObserved || stopResult.status === 'rejected'))
      )])
      const failures = [stopResult, stateResult].flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'B站投稿停止未完全收敛')
      if (stateResult.status === 'rejected') throw stateResult.reason
      return stateResult.value
    } finally {
      this.#endDirectoryStop(directoryKey, stoppedTaskId)
    }
  }

  #reserveStartingDirectory(taskDirectory: string): string {
    if (!this.#accepting) throw new Error('Etch 正在退出，拒绝启动新的投稿')
    const directoryKey = resolve(taskDirectory)
    if (this.options.isTaskAcquisitionBlocked?.(directoryKey)) throw new Error('任务正在删除')
    if (this.#stoppingDirectories.has(directoryKey)) throw new Error('投稿已停止')
    if (this.#startingDirectories.has(directoryKey)) throw new Error('这个任务已经在投稿队列中')
    this.#startingDirectories.set(directoryKey, undefined)
    return directoryKey
  }

  async #markPausedAfterStop(
    taskDirectory: string,
    pausedMessage = '已停止，可继续投稿',
    outcomeUnknown = false
  ): Promise<TaskManifest> {
    const paused = await this.options.store.mutate(taskDirectory, (draft) => {
      if (draft.publication.status === 'submitted' || draft.publication.status === 'unknown') return
      if (draft.publication.status === 'submitting' || outcomeUnknown) {
        draft.publication.status = 'unknown'
        draft.publication.phaseMessage = '提交阶段已停止，请先到 B站创作中心确认'
        draft.publication.lastError = {
          code: 'submission-outcome-unknown',
          message: outcomeUnknown
            ? '无法确认投稿进程是否已经终止，请先到 B站创作中心确认'
            : '投稿在提交阶段被停止，无法确认 B站是否已经受理',
          retryable: false
        }
      } else {
        draft.publication.status = 'paused'
        draft.publication.phaseMessage = pausedMessage
      }
      draft.publication.updatedAt = new Date().toISOString()
    })
    this.options.publishManifest(taskDirectory, paused)
    return paused
  }

  async considerAuto(taskDirectory: string): Promise<void> {
    const directoryKey = this.#reserveStartingDirectory(taskDirectory)
    return this.#considerAutoReserved(taskDirectory, directoryKey)
  }

  async #considerAutoReserved(taskDirectory: string, directoryKey: string): Promise<void> {
    let handedOff = false
    let observedTaskId: string | undefined
    let completedNormally = false
    try {
      const manifest = await this.options.store.load(taskDirectory)
      observedTaskId = manifest.taskId
      this.#assertNotStopped(manifest.taskId, directoryKey)
      if (manifest.kind !== 'subtitle') return
      if (!manifest.publication.autoPublish || manifest.pipeline.stages.verify?.status !== 'completed') return
      if (!['idle', 'waiting_config'].includes(manifest.publication.status) || this.hasTask(manifest.taskId)) return
      const template = this.options.settings().bilibiliPublishTemplate
      const account = await this.options.accountStore.account()
      this.#assertNotStopped(manifest.taskId, directoryKey)
      if (account.status !== 'connected' || !publicationTemplateReady(template)) {
        if (manifest.publication.status === 'waiting_config') return
        const waiting = await this.options.store.mutate(taskDirectory, (draft) => {
          this.#assertNotStopped(manifest.taskId, directoryKey)
          draft.publication.status = 'waiting_config'
          draft.publication.phaseMessage = account.status !== 'connected' ? '等待连接 B站账号' : '等待补全自动投稿模板'
          draft.publication.updatedAt = new Date().toISOString()
        })
        this.options.publishManifest(taskDirectory, waiting)
        return
      }
      const final = manifest.artifacts.final
      if (!final?.valid) return
      this.#assertNotStopped(manifest.taskId, directoryKey)
      const sourceUrl = manifest.input.kind === 'url' ? manifest.input.url : ''
      const draft = BilibiliPublicationDraftSchema.parse({
        title: truncateBilibiliTitle(manifest.title),
        tid: template.tid,
        partitionName: template.partitionName,
        tags: template.tags,
        description: renderBilibiliDescription(template.descriptionTemplate, manifest.title, sourceUrl),
        copyright: manifest.input.kind === 'url' ? 'repost' : 'original',
        source: sourceUrl,
        coverRelativePath: manifest.artifacts.thumbnail?.valid ? manifest.artifacts.thumbnail.relativePath : undefined,
        finalSha256: final.sha256
      })
      handedOff = true
      await this.#startReserved(taskDirectory, directoryKey, draft)
      completedNormally = true
    } finally {
      if (!handedOff) {
        try {
          this.#startingDirectories.delete(directoryKey)
        } finally {
          this.#maybeReleaseDirectoryStop(directoryKey, observedTaskId)
        }
      } else if (!completedNormally) {
        this.#maybeReleaseDirectoryStop(directoryKey, observedTaskId)
      }
    }
  }

  async #runJob(job: PublicationJob): Promise<void> {
    let submitting = false
    try {
      await this.#verifySidecar()
      if (job.draft.coverRelativePath && this.options.normalizeCover) {
        if (!await this.#mutateActiveJob(job, (draft) => {
          draft.publication.phaseMessage = '正在准备投稿封面'
          draft.publication.updatedAt = new Date().toISOString()
        })) return
        const sourcePath = this.#containedPath(job.taskDirectory, job.draft.coverRelativePath, '封面')
        job.draft = BilibiliPublicationDraftSchema.parse({
          ...job.draft,
          coverRelativePath: await this.options.normalizeCover(sourcePath, job.taskDirectory)
        })
        if (!await this.#mutateActiveJob(job, (draft) => {
          draft.publication.draft = job.draft
          draft.publication.updatedAt = new Date().toISOString()
        })) return
      }
      const current = await this.options.store.load(job.taskDirectory)
      await this.#preflight(job.taskDirectory, current, job.draft)
      for (let retry = 0; retry < 3; retry += 1) {
        if (this.#jobStopped(job)) return
        if (!await this.#mutateActiveJob(job, (draft) => {
          draft.publication.status = 'uploading'
          draft.publication.attempt += 1
          draft.publication.phaseMessage = retry ? `网络异常，正在进行第 ${retry + 1} 次尝试` : '正在上传成片'
          draft.publication.updatedAt = new Date().toISOString()
          delete draft.publication.lastError
        })) return
        submitting = false
        const sidecar = await this.#runSidecar(job, async () => {
          if (submitting || this.#jobStopped(job)) return
          submitting = true
          await this.#mutateActiveJob(job, (draft) => {
            draft.publication.status = 'submitting'
            draft.publication.phaseMessage = '成片已上传，正在提交稿件'
            draft.publication.updatedAt = new Date().toISOString()
          })
        })
        const result = sidecar.result
        if (this.#jobStopped(job)) return
        const output = `${result.stdout}\n${result.stderr}`
        const receipt = parseBiliupReceipt(output)
        if (receipt) {
          await this.#saveRefreshedLogin(sidecar)
          if (!await this.#mutateActiveJob(job, (draft) => {
            draft.publication.status = 'submitted'
            draft.publication.receipt = receipt
            draft.publication.phaseMessage = '已提交，审核状态请在 B站创作中心查看'
            draft.publication.submittedAt = new Date().toISOString()
            draft.publication.updatedAt = draft.publication.submittedAt
            delete draft.publication.lastError
          })) return
          return
        }
        if (submitting || (result.exitCode === 0 && !result.cancelled && !result.timedOut)) {
          await this.#saveRefreshedLogin(sidecar)
          await this.#markUnknown(job, 'biliup 已进入提交阶段，但 Etch 没有取得可验证回执')
          return
        }
        if (result.cancelled) {
          await this.#mutateActiveJob(job, (draft) => {
            draft.publication.status = 'paused'
            draft.publication.phaseMessage = '投稿进程已停止，可继续投稿'
            draft.publication.updatedAt = new Date().toISOString()
          })
          return
        }
        const failure = result.timedOut
          ? { code: 'transient-timeout', message: '上传连接超时', retryable: true }
          : classifyBiliupFailure(output)
        if (failure.code === 'auth-expired') await this.options.accountStore.markExpiredIfCurrent(sidecar.loginInfo, failure.message)
        else await this.#saveRefreshedLogin(sidecar)
        if (!failure.retryable || retry === 2) {
          await this.#markFailed(job, failure)
          return
        }
        await this.#sleep(1_000 * (2 ** retry))
      }
    } catch (error) {
      if (this.#jobStopped(job)) return
      if (submitting) {
        await this.#markUnknown(job, error instanceof Error ? error.message : '提交阶段异常中断')
        return
      }
      await this.#markFailed(job, {
        code: 'preflight-or-run-failed',
        message: error instanceof Error ? error.message : '投稿启动失败',
        retryable: false
      })
    }
  }

  async #runSidecar(job: PublicationJob, onUploaded: () => Promise<void>): Promise<SidecarResult> {
    const runDirectory = await mkdtemp(join(this.options.temporaryRoot, 'biliup-'))
    const cookiePath = join(runDirectory, 'cookies.json')
    const loginInfo = await this.options.accountStore.loginInfo()
    await writeFile(cookiePath, `${JSON.stringify(loginInfo, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const manifest = await this.options.store.load(job.taskDirectory)
    const finalPath = this.#containedPath(job.taskDirectory, manifest.runtime.finalRelativePath!, '成片')
    const coverPath = job.draft.coverRelativePath ? this.#containedPath(job.taskDirectory, job.draft.coverRelativePath, '封面') : undefined
    const args = [
      '--user-cookie', cookiePath,
      '--rust-log', 'info',
      'upload',
      '--submit', 'web',
      '--copyright', job.draft.copyright === 'original' ? '1' : '2',
      '--source', job.draft.copyright === 'repost' ? job.draft.source : '',
      '--tid', String(job.draft.tid),
      '--title', job.draft.title,
      '--desc', job.draft.description,
      '--tag', job.draft.tags.join(','),
      '--no-reprint', '0'
    ]
    if (coverPath) args.push('--cover', coverPath)
    args.push(finalPath)
    let observedUpload = false
    let phaseTransition = Promise.resolve()
    const observe = (chunk: string): void => {
      if (observedUpload || !/Upload completed:/u.test(chunk)) return
      observedUpload = true
      job.submissionObserved = true
      phaseTransition = onUploaded()
    }
    const runId = randomUUID()
    const appInstanceToken = this.options.runRegistry.appInstanceToken
    try {
      const spec: ProcessSpec = {
        command: this.options.sidecarPath,
        args,
        cwd: job.taskDirectory,
        env: sidecarEnvironment(process.env),
        timeoutMs: 24 * 60 * 60_000,
        inactivityTimeoutMs: 10 * 60_000,
        captureLimitBytes: 2 * 1024 * 1024,
        onStdout: observe,
        onStderr: observe
      }
      this.#assertNotStopped(job.taskId, resolve(job.taskDirectory))
      const result = this.options.runExternal
        ? await this.options.runExternal(spec)
        : await runProcess(spec, {
        started: async (pid, executable) => {
          await this.options.runRegistry.register({
            runId,
            appInstanceToken,
            pid,
            pgid: pid,
            executable,
            taskId: job.taskId,
            stage: 'publish:bilibili'
          })
          if (job.stopped || this.#stopRequestedTaskIds.has(job.taskId)) await this.options.runRegistry.stopTask(job.taskId)
        },
        finished: () => this.options.runRegistry.finish(runId)
      }, { runId, appInstanceToken })
      await phaseTransition
      let refreshedLoginInfo: BiliupLoginInfo | undefined
      try {
        refreshedLoginInfo = BiliupLoginInfoSchema.parse(JSON.parse(await readFile(cookiePath, 'utf8')))
      } catch {
        // biliup may leave the input credential unchanged or terminate before writing it.
      }
      return { result, loginInfo, refreshedLoginInfo }
    } finally {
      await rm(runDirectory, { recursive: true, force: true })
    }
  }

  async #saveRefreshedLogin(sidecar: SidecarResult): Promise<void> {
    if (!sidecar.refreshedLoginInfo) return
    try {
      await this.options.accountStore.saveRefreshedIfCurrent(sidecar.loginInfo, sidecar.refreshedLoginInfo)
    } catch {
      // A verified submission must not become retryable merely because credential refresh persistence failed.
    }
  }

  async #preflight(taskDirectory: string, manifest: TaskManifest, draft: BilibiliPublicationDraft): Promise<void> {
    if (manifest.kind !== 'subtitle') throw new Error('只有双语硬字幕任务可以投稿')
    if (manifest.pipeline.stages.verify?.status !== 'completed') throw new Error('只有验证完成的任务才能投稿')
    const final = manifest.artifacts.final
    if (!final?.valid || !manifest.runtime.finalRelativePath) throw new Error('任务没有可投稿的有效成片')
    if (draft.finalSha256 !== final.sha256) throw new Error('成片已变化，请重新打开投稿弹窗确认')
    await sha256ContainedFile(taskDirectory, final.relativePath, 'B站投稿成片', {
      expectedSize: final.size,
      expectedSha256: draft.finalSha256
    })
    if (draft.coverRelativePath) await sha256ContainedFile(taskDirectory, draft.coverRelativePath, 'B站投稿封面', { maxBytes: 10 * 1024 * 1024 })
  }

  async #verifySidecar(): Promise<void> {
    if (this.#sidecarVerified) return
    const info = await stat(this.options.sidecarPath)
    if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error('内置 biliup sidecar 不可执行')
    const hash = createHash('sha256').update(await readFile(this.options.sidecarPath)).digest('hex')
    if (hash !== (this.options.sidecarSha256 ?? BILIUP_BINARY_SHA256)) throw new Error('内置 biliup sidecar 完整性校验失败')
    this.#sidecarVerified = true
  }

  #assertNotStopped(taskId: string, directoryKey: string): void {
    if (this.#stopRequestedTaskIds.has(taskId) || this.#stoppingDirectories.has(directoryKey)) throw new Error('投稿已停止')
  }

  #beginDirectoryStop(directoryKey: string): void {
    this.#stoppingDirectories.add(directoryKey)
    this.#stopOperationCounts.set(directoryKey, (this.#stopOperationCounts.get(directoryKey) ?? 0) + 1)
  }

  #endDirectoryStop(directoryKey: string, taskId?: string): void {
    const remaining = (this.#stopOperationCounts.get(directoryKey) ?? 1) - 1
    if (remaining > 0) this.#stopOperationCounts.set(directoryKey, remaining)
    else this.#stopOperationCounts.delete(directoryKey)
    this.#maybeReleaseDirectoryStop(directoryKey, taskId)
  }

  #maybeReleaseDirectoryStop(directoryKey: string, taskId?: string): void {
    if ((this.#stopOperationCounts.get(directoryKey) ?? 0) > 0) return
    if (this.#startingDirectories.has(directoryKey)) return
    if ([...this.#active.values()].some((job) => resolve(job.taskDirectory) === directoryKey)) return
    this.#stoppingDirectories.delete(directoryKey)
    if (taskId && !this.hasTask(taskId)) this.#stopRequestedTaskIds.delete(taskId)
  }

  #jobStopped(job: PublicationJob): boolean {
    return job.stopped
      || this.#stopRequestedTaskIds.has(job.taskId)
      || this.#stoppingDirectories.has(resolve(job.taskDirectory))
      || this.#active.get(job.taskId) !== job
  }

  async #mutateActiveJob(job: PublicationJob, change: (manifest: TaskManifest) => void): Promise<TaskManifest | undefined> {
    if (this.#jobStopped(job)) return undefined
    try {
      const manifest = await this.options.store.mutate(job.taskDirectory, (draft) => {
        if (this.#jobStopped(job)) throw new PublicationCommitCancelled()
        change(draft)
      })
      this.options.publishManifest(job.taskDirectory, manifest)
      return manifest
    } catch (error) {
      if (error instanceof PublicationCommitCancelled) return undefined
      throw error
    }
  }

  async #markFailed(job: PublicationJob, failure: { code: string; message: string; retryable: boolean }): Promise<void> {
    await this.#mutateActiveJob(job, (draft) => {
      draft.publication.status = 'failed'
      draft.publication.lastError = { ...failure, message: failure.message.slice(0, 500) }
      draft.publication.phaseMessage = '投稿失败，可继续投稿'
      draft.publication.updatedAt = new Date().toISOString()
    })
  }

  async #markUnknown(job: PublicationJob, message: string): Promise<void> {
    await this.#mutateActiveJob(job, (draft) => {
      draft.publication.status = 'unknown'
      draft.publication.lastError = { code: 'submission-outcome-unknown', message: message.slice(0, 500), retryable: false }
      draft.publication.phaseMessage = '提交结果未知，请先到 B站创作中心确认'
      draft.publication.updatedAt = new Date().toISOString()
    })
  }

  #containedPath(taskDirectory: string, relativePath: string, label: string): string {
    const root = resolve(taskDirectory)
    const path = resolve(root, relativePath)
    if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error(`${label}路径不在任务目录内`)
    return path
  }
}

function sidecarEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] as const
  return Object.fromEntries(allowed.flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]]))
}
