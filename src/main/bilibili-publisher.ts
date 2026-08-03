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
import { BiliupLoginInfoSchema, type BilibiliAccountStore } from './storage/bilibili-account-store'
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
}

interface PublisherOptions {
  store: TaskStore
  accountStore: Pick<BilibiliAccountStore, 'account' | 'loginInfo' | 'markExpired' | 'save'>
  settings: () => AppSettings
  sidecarPath: string
  sidecarSha256?: string
  temporaryRoot: string
  runRegistry: RunRegistry
  appRuns: AsyncRunScope
  publishManifest(taskDirectory: string, manifest: TaskManifest): void
  runExternal?(spec: ProcessSpec): Promise<ProcessResult>
  onActiveChange?(active: boolean): void
  sleep?(milliseconds: number): Promise<void>
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
  const compact = output.replace(ANSI_ESCAPE_PATTERN, '').replace(/\s+/gu, ' ').trim().slice(-500)
  if (/SESSDATA|cookie|登录|oauth2\/info|token|Unauthorized|code:\s*-101/iu.test(compact)) {
    return { code: 'auth-expired', message: 'B站登录已失效，请重新扫码登录', retryable: false }
  }
  if (/captcha|验证码|风控|账号异常|敏感|分区|标题|标签|转载来源|copyright|code:\s*(?:-?210|211|220|601)/iu.test(compact)) {
    const platformCode = compact.match(/code:\s*(-?\d+)/iu)?.[1]
    return { code: 'platform-rejected', message: `B站拒绝了投稿参数${platformCode ? `（code ${platformCode}）` : ''}`, retryable: false }
  }
  const retryable = /timeout|timed out|connection|network|reset|broken pipe|temporar|502|503|504|dns|resolve|限流|稍后重试/iu.test(compact)
  return {
    code: retryable ? 'transient-network' : 'sidecar-failed',
    message: retryable ? 'B站上传网络异常，请稍后重试' : 'biliup 投稿失败，请检查账号状态和稿件参数',
    retryable
  }
}

export class BilibiliPublisher {
  readonly #queue: PublicationJob[] = []
  readonly #sleep: (milliseconds: number) => Promise<void>
  #active?: PublicationJob
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
      const paused = await this.options.store.mutate(taskDirectory, (draft) => {
        draft.publication.status = 'paused'
        draft.publication.phaseMessage = '上次投稿被应用退出中断，可继续投稿'
        draft.publication.updatedAt = new Date().toISOString()
      })
      this.options.publishManifest(taskDirectory, paused)
    }
  }

  hasTask(taskId: string): boolean {
    return this.#active?.taskId === taskId || this.#queue.some((job) => job.taskId === taskId)
  }

  async start(taskDirectory: string, draftInput: BilibiliPublicationDraft): Promise<TaskManifest> {
    const draft = BilibiliPublicationDraftSchema.parse(draftInput)
    const manifest = await this.options.store.load(taskDirectory)
    if (this.hasTask(manifest.taskId)) throw new Error('这个任务已经在投稿队列中')
    if (manifest.publication.status === 'submitted') throw new Error('这个任务已经确认投稿成功，不能重复投稿')
    if (manifest.publication.status === 'unknown') throw new Error('提交结果未知，请先在 B站创作中心确认，避免重复投稿')
    if ((await this.options.accountStore.account()).status !== 'connected') throw new Error('请先重新扫码连接 B站账号')
    await this.#preflight(taskDirectory, manifest, draft)
    const queued = await this.options.store.mutate(taskDirectory, (next) => {
      next.publication.draft = draft
      next.publication.status = 'queued'
      next.publication.phaseMessage = '等待本地投稿队列'
      next.publication.updatedAt = new Date().toISOString()
      delete next.publication.lastError
    })
    this.options.publishManifest(taskDirectory, queued)
    this.#queue.push({ taskDirectory, taskId: manifest.taskId, draft, stopped: false })
    this.#pump()
    return queued
  }

  async continue(taskDirectory: string): Promise<TaskManifest> {
    const manifest = await this.options.store.load(taskDirectory)
    if (!manifest.publication.draft) throw new Error('没有可继续的投稿草稿，请重新打开投稿弹窗')
    return this.start(taskDirectory, manifest.publication.draft)
  }

  async stop(taskDirectory: string): Promise<TaskManifest> {
    const manifest = await this.options.store.load(taskDirectory)
    const queuedIndex = this.#queue.findIndex((job) => job.taskId === manifest.taskId)
    if (queuedIndex >= 0) {
      this.#queue[queuedIndex].stopped = true
      this.#queue.splice(queuedIndex, 1)
    }
    if (this.#active?.taskId === manifest.taskId) {
      this.#active.stopped = true
      await this.options.runRegistry.stopTask(manifest.taskId)
    }
    const paused = await this.options.store.mutate(taskDirectory, (draft) => {
      if (draft.publication.status === 'submitted') return
      if (draft.publication.status === 'submitting') {
        draft.publication.status = 'unknown'
        draft.publication.phaseMessage = '提交阶段已停止，请先到 B站创作中心确认'
        draft.publication.lastError = {
          code: 'submission-outcome-unknown',
          message: '投稿在提交阶段被停止，无法确认 B站是否已经受理',
          retryable: false
        }
      } else {
        draft.publication.status = 'paused'
        draft.publication.phaseMessage = '已停止，可继续投稿'
      }
      draft.publication.updatedAt = new Date().toISOString()
    })
    this.options.publishManifest(taskDirectory, paused)
    return paused
  }

  async considerAuto(taskDirectory: string): Promise<void> {
    const manifest = await this.options.store.load(taskDirectory)
    if (!manifest.publication.autoPublish || manifest.pipeline.stages.verify?.status !== 'completed') return
    if (!['idle', 'waiting_config'].includes(manifest.publication.status) || this.hasTask(manifest.taskId)) return
    const template = this.options.settings().bilibiliPublishTemplate
    const account = await this.options.accountStore.account()
    if (account.status !== 'connected' || !publicationTemplateReady(template)) {
      if (manifest.publication.status === 'waiting_config') return
      const waiting = await this.options.store.mutate(taskDirectory, (draft) => {
        draft.publication.status = 'waiting_config'
        draft.publication.phaseMessage = account.status !== 'connected' ? '等待连接 B站账号' : '等待补全自动投稿模板'
        draft.publication.updatedAt = new Date().toISOString()
      })
      this.options.publishManifest(taskDirectory, waiting)
      return
    }
    const final = manifest.artifacts.final
    if (!final?.valid) return
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
    await this.start(taskDirectory, draft)
  }

  #pump(): void {
    if (this.#active) return
    const job = this.#queue.shift()
    if (!job) return
    this.#active = job
    this.options.onActiveChange?.(true)
    const run = this.#runJob(job)
      .catch((error) => console.error('B站投稿任务失败', { taskId: job.taskId, error }))
      .finally(() => {
        if (this.#active === job) this.#active = undefined
        this.options.onActiveChange?.(false)
        this.#pump()
      })
    this.options.appRuns.track(run)
  }

  async #runJob(job: PublicationJob): Promise<void> {
    let submitting = false
    try {
      await this.#verifySidecar()
      const current = await this.options.store.load(job.taskDirectory)
      await this.#preflight(job.taskDirectory, current, job.draft)
      for (let retry = 0; retry < 3; retry += 1) {
        if (job.stopped) return
        const running = await this.options.store.mutate(job.taskDirectory, (draft) => {
          draft.publication.status = 'uploading'
          draft.publication.attempt += 1
          draft.publication.phaseMessage = retry ? `网络异常，正在进行第 ${retry + 1} 次尝试` : '正在上传成片'
          draft.publication.updatedAt = new Date().toISOString()
          delete draft.publication.lastError
        })
        this.options.publishManifest(job.taskDirectory, running)
        submitting = false
        const result = await this.#runSidecar(job, async () => {
          if (submitting) return
          submitting = true
          const next = await this.options.store.mutate(job.taskDirectory, (draft) => {
            draft.publication.status = 'submitting'
            draft.publication.phaseMessage = '成片已上传，正在提交稿件'
            draft.publication.updatedAt = new Date().toISOString()
          })
          this.options.publishManifest(job.taskDirectory, next)
        })
        if (job.stopped) return
        const output = `${result.stdout}\n${result.stderr}`
        const receipt = parseBiliupReceipt(output)
        if (receipt) {
          const submitted = await this.options.store.mutate(job.taskDirectory, (draft) => {
            draft.publication.status = 'submitted'
            draft.publication.receipt = receipt
            draft.publication.phaseMessage = '已提交，审核状态请在 B站创作中心查看'
            draft.publication.submittedAt = new Date().toISOString()
            draft.publication.updatedAt = draft.publication.submittedAt
            delete draft.publication.lastError
          })
          this.options.publishManifest(job.taskDirectory, submitted)
          return
        }
        if (submitting || (result.exitCode === 0 && !result.cancelled && !result.timedOut)) {
          await this.#markUnknown(job.taskDirectory, 'biliup 已进入提交阶段，但 Etch 没有取得可验证回执')
          return
        }
        if (result.cancelled) {
          const paused = await this.options.store.mutate(job.taskDirectory, (draft) => {
            draft.publication.status = 'paused'
            draft.publication.phaseMessage = '投稿进程已停止，可继续投稿'
            draft.publication.updatedAt = new Date().toISOString()
          })
          this.options.publishManifest(job.taskDirectory, paused)
          return
        }
        const failure = result.timedOut
          ? { code: 'transient-timeout', message: '上传连接超时', retryable: true }
          : classifyBiliupFailure(output)
        if (failure.code === 'auth-expired') await this.options.accountStore.markExpired(failure.message)
        if (!failure.retryable || retry === 2) {
          await this.#markFailed(job.taskDirectory, failure)
          return
        }
        await this.#sleep(1_000 * (2 ** retry))
      }
    } catch (error) {
      if (job.stopped) return
      if (submitting) {
        await this.#markUnknown(job.taskDirectory, error instanceof Error ? error.message : '提交阶段异常中断')
        return
      }
      await this.#markFailed(job.taskDirectory, {
        code: 'preflight-or-run-failed',
        message: error instanceof Error ? error.message : '投稿启动失败',
        retryable: false
      })
    }
  }

  async #runSidecar(job: PublicationJob, onUploaded: () => Promise<void>): Promise<ProcessResult> {
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
      const result = this.options.runExternal
        ? await this.options.runExternal(spec)
        : await runProcess(spec, {
        started: async (pid, executable) => this.options.runRegistry.register({
          runId,
          appInstanceToken,
          pid,
          pgid: pid,
          executable,
          taskId: job.taskId,
          stage: 'publish:bilibili'
        }).then(() => undefined),
        finished: () => this.options.runRegistry.finish(runId)
      }, { runId, appInstanceToken })
      await phaseTransition
      try {
        const refreshed = BiliupLoginInfoSchema.parse(JSON.parse(await readFile(cookiePath, 'utf8')))
        const account = await this.options.accountStore.account()
        if (account.status === 'connected') await this.options.accountStore.save(refreshed, account)
      } catch {
        // biliup may leave the input credential unchanged or terminate before writing it.
      }
      return result
    } finally {
      await rm(runDirectory, { recursive: true, force: true })
    }
  }

  async #preflight(taskDirectory: string, manifest: TaskManifest, draft: BilibiliPublicationDraft): Promise<void> {
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

  async #markFailed(taskDirectory: string, failure: { code: string; message: string; retryable: boolean }): Promise<void> {
    const manifest = await this.options.store.mutate(taskDirectory, (draft) => {
      draft.publication.status = 'failed'
      draft.publication.lastError = { ...failure, message: failure.message.slice(0, 500) }
      draft.publication.phaseMessage = '投稿失败，可继续投稿'
      draft.publication.updatedAt = new Date().toISOString()
    })
    this.options.publishManifest(taskDirectory, manifest)
  }

  async #markUnknown(taskDirectory: string, message: string): Promise<void> {
    const manifest = await this.options.store.mutate(taskDirectory, (draft) => {
      draft.publication.status = 'unknown'
      draft.publication.lastError = { code: 'submission-outcome-unknown', message: message.slice(0, 500), retryable: false }
      draft.publication.phaseMessage = '提交结果未知，请先到 B站创作中心确认'
      draft.publication.updatedAt = new Date().toISOString()
    })
    this.options.publishManifest(taskDirectory, manifest)
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
