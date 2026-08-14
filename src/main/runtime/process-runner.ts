import { execFile, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SIGNAL_GRACE_MS = 2_000
const GROUP_SETTLE_MS = SIGNAL_GRACE_MS + 500
const DEFAULT_CAPTURE_LIMIT_BYTES = 8 * 1024 * 1024
const IDENTITY_PROBE_ATTEMPTS = 10
const IDENTITY_PROBE_DELAY_MS = 25

export type ProcessIdentityProbe =
  | { state: 'present'; startedAt: string; pgid: number; command: string }
  | { state: 'absent' }
  | { state: 'unknown' }

export interface ExpectedProcessIdentity {
  pid: number
  pgid: number
  executable: string
  processStartedAt: string
  runId?: string
  appInstanceToken?: string
}

export interface ProcessHostIdentity {
  runId: string
  appInstanceToken: string
}

const PROCESS_HOST_RUN_PREFIX = '--etch-process-host-run='
const PROCESS_HOST_INSTANCE_PREFIX = '--etch-process-host-instance='
const PROCESS_HOST_COMMAND_SEPARATOR = '--etch-process-host-command'
const PROCESS_HOST_SOURCE = [
  "const { spawn } = require('node:child_process')",
  "const { constants } = require('node:os')",
  `const separator = process.argv.indexOf(${JSON.stringify(PROCESS_HOST_COMMAND_SEPARATOR)})`,
  "if (separator < 0 || !process.argv[separator + 1]) { process.stderr.write('Etch process host: missing command\\n'); process.exit(125) }",
  'const command = process.argv[separator + 1]',
  'const args = process.argv.slice(separator + 2)',
  'const env = { ...process.env }',
  "delete env.ELECTRON_RUN_AS_NODE",
  "process.on('SIGTERM', () => undefined)",
  "const child = spawn(command, args, { cwd: process.cwd(), env, detached: false, stdio: 'inherit' })",
  "child.once('error', (error) => { process.stderr.write(`Etch process host: ${error.message}\\n`); process.exit(127) })",
  "child.once('close', (code, signal) => { if (signal) process.exit(128 + (constants.signals[signal] ?? 1)); else process.exit(code ?? 1) })"
].join(';')

export type VerifiedSignalResult = 'signaled' | 'gone' | 'mismatch' | 'failed'

export type ProcessGroupProbe = 'present' | 'absent' | 'unknown'

export class ProcessExitedBeforeRegistrationError extends Error {
  constructor() {
    super('外部进程在持久登记采样前已经退出')
    this.name = 'ProcessExitedBeforeRegistrationError'
  }
}

function processIsAbsent(error: unknown): boolean {
  return Number((error as { code?: unknown }).code) === 1
}

export function processCommandMatches(executable: string, command: string): boolean {
  return command === executable || command.startsWith(`${executable} `)
}

function processCommandHasArgument(command: string, argument: string): boolean {
  const escaped = argument.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'u').test(command)
}

export function processCommandHasHostIdentity(command: string, identity: ProcessHostIdentity): boolean {
  return processCommandHasArgument(command, `${PROCESS_HOST_RUN_PREFIX}${identity.runId}`)
    && processCommandHasArgument(command, `${PROCESS_HOST_INSTANCE_PREFIX}${identity.appInstanceToken}`)
}

export async function probeProcessIdentity(pid: number): Promise<ProcessIdentityProbe> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', [
      '-ww',
      '-p', String(pid),
      '-o', 'lstart=',
      '-o', 'pgid=',
      '-o', 'command='
    ], { timeout: 2_000, env: { ...process.env, LC_ALL: 'C' } })
    const identity = stdout.trimEnd().match(/^(.{24})\s+(\d+)\s+(.*)$/u)
    const pgid = Number(identity?.[2])
    if (!identity?.[1]?.trim() || !Number.isSafeInteger(pgid) || pgid <= 0 || !identity[3]?.trim()) return { state: 'unknown' }
    return { state: 'present', startedAt: identity[1].trim(), pgid, command: identity[3].trim() }
  } catch (error) {
    return processIsAbsent(error) ? { state: 'absent' } : { state: 'unknown' }
  }
}

export function probeProcessGroup(pgid: number): ProcessGroupProbe {
  try {
    process.kill(-pgid, 0)
    return 'present'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown'
  }
}

export function classifyProcessGroupStates(stdout: string): ProcessGroupProbe {
  const states = stdout.split(/\s+/u).filter(Boolean)
  if (!states.length) return 'absent'
  if (states.some((state) => !/^[A-Z]/u.test(state))) return 'unknown'
  return states.every((state) => state.startsWith('Z')) ? 'absent' : 'present'
}

export async function probeProcessGroupLiveness(pgid: number): Promise<ProcessGroupProbe> {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return 'unknown'
  try {
    const { stdout } = await execFileAsync('/bin/ps', [
      '-ax',
      '-o', 'pgid=',
      '-o', 'state='
    ], { timeout: 2_000 })
    const states: string[] = []
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const member = line.match(/^\s*(\d+)\s+(\S+)\s*$/u)
      const memberPgid = Number(member?.[1])
      if (!member || !Number.isSafeInteger(memberPgid) || memberPgid <= 0) return 'unknown'
      if (memberPgid === pgid) states.push(member[2])
    }
    return classifyProcessGroupStates(states.join('\n'))
  } catch (error) {
    return processIsAbsent(error) ? 'absent' : 'unknown'
  }
}

export async function probeEffectiveProcessGroup(pgid: number): Promise<ProcessGroupProbe> {
  const group = probeProcessGroup(pgid)
  return group === 'present' ? probeProcessGroupLiveness(pgid) : group
}

export function processIdentityMatches(expected: ExpectedProcessIdentity, actual: Extract<ProcessIdentityProbe, { state: 'present' }>): boolean {
  const hasHostIdentity = Boolean(expected.runId || expected.appInstanceToken)
  return actual.startedAt === expected.processStartedAt
    && actual.pgid === expected.pgid
    && processCommandMatches(expected.executable, actual.command)
    && (!hasHostIdentity || Boolean(expected.runId && expected.appInstanceToken && processCommandHasHostIdentity(actual.command, expected as ProcessHostIdentity)))
}

export async function signalVerifiedProcess(
  expected: ExpectedProcessIdentity,
  signal: NodeJS.Signals,
  allowLeaderlessGroup = false
): Promise<VerifiedSignalResult> {
  let identity = await probeProcessIdentity(expected.pid)
  for (let attempt = 1; identity.state === 'unknown' && attempt < IDENTITY_PROBE_ATTEMPTS; attempt += 1) {
    await delay(IDENTITY_PROBE_DELAY_MS)
    identity = await probeProcessIdentity(expected.pid)
  }
  if (identity.state === 'absent') {
    const group = probeProcessGroup(expected.pgid)
    if (group === 'absent') return 'gone'
    if (!allowLeaderlessGroup || group === 'unknown') return 'failed'
  }
  if (identity.state === 'unknown') return 'failed'
  if (identity.state === 'present' && !processIdentityMatches(expected, identity)) return 'mismatch'
  try {
    process.kill(-expected.pgid, signal)
    return 'signaled'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed'
  }
}

export interface ProcessSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
  inactivityTimeoutMs?: number
  captureLimitBytes?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface ProcessResult {
  pid: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  timeoutReason?: 'wall-clock' | 'inactivity'
  cancelled: boolean
}

export interface RunningProcess {
  pid: number
  executable: string
  result: Promise<ProcessResult>
  cancel(): void
}

function completedNormally(result: ProcessResult): boolean {
  return result.exitCode === 0
    && result.signal === null
    && !result.timedOut
    && !result.cancelled
}

export async function settleRegistrationFailure(running: RunningProcess, failure: unknown): Promise<ProcessResult> {
  if (failure instanceof ProcessExitedBeforeRegistrationError) {
    let result: ProcessResult
    try {
      result = await running.result
    } catch {
      throw failure
    }
    if (completedNormally(result) && await probeEffectiveProcessGroup(running.pid) === 'absent') return result
    throw failure
  }
  running.cancel()
  try { await running.result } catch { /* preserve durable registration failure */ }
  if (!await waitForProcessGroupExit(running.pid, GROUP_SETTLE_MS)) {
    try { process.kill(-running.pid, 'SIGKILL') } catch { /* already gone or cannot be reclaimed */ }
    await waitForProcessGroupExit(running.pid, 500)
  }
  throw failure
}

async function waitForProcessGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    if (probeProcessGroup(pgid) === 'absent') return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  return await probeEffectiveProcessGroup(pgid) === 'absent'
}

export interface ProcessLifecycle {
  started(pid: number, executable: string): Promise<void>
  finished(): Promise<void>
}

export function startProcess(spec: ProcessSpec, hostIdentity?: ProcessHostIdentity): RunningProcess {
  const captureLimitBytes = spec.captureLimitBytes ?? DEFAULT_CAPTURE_LIMIT_BYTES
  if (!Number.isSafeInteger(captureLimitBytes) || captureLimitBytes <= 0) {
    throw new Error('captureLimitBytes 必须是正安全整数')
  }
  const command = hostIdentity ? process.execPath : spec.command
  const args = hostIdentity
    ? [
        '-e', PROCESS_HOST_SOURCE, '--',
        `${PROCESS_HOST_RUN_PREFIX}${hostIdentity.runId}`,
        `${PROCESS_HOST_INSTANCE_PREFIX}${hostIdentity.appInstanceToken}`,
        PROCESS_HOST_COMMAND_SEPARATOR,
        spec.command,
        ...spec.args
      ]
    : spec.args
  const env = hostIdentity
    ? { ...(spec.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' }
    : spec.env
  const child = spawn(command, args, {
    cwd: spec.cwd,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let processError: Error | undefined
  let streamError: Error | undefined
  child.on('error', (error) => { processError = error })
  child.stdin.on('error', (error) => { streamError ??= error })
  child.stdout.on('error', (error) => { streamError ??= error })
  child.stderr.on('error', (error) => { streamError ??= error })
  if (!child.pid) throw new Error(`无法启动进程：${spec.command}`)
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let stdoutTruncated = false
  let stderrTruncated = false
  let timedOut = false
  let timeoutReason: ProcessResult['timeoutReason']
  let cancelled = false
  let leaderClosed = false
  let killTimer: NodeJS.Timeout | undefined
  let inactivityTimer: NodeJS.Timeout | undefined
  let resetInactivityTimer = (): void => undefined
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    resetInactivityTimer()
    const captured = appendDiagnosticTail(stdout, chunk, captureLimitBytes)
    stdout = captured.bytes
    stdoutTruncated ||= captured.truncated
    try { spec.onStdout?.(chunk) } catch (error) { streamError ??= error instanceof Error ? error : new Error(String(error)) }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    resetInactivityTimer()
    const captured = appendDiagnosticTail(stderr, chunk, captureLimitBytes)
    stderr = captured.bytes
    stderrTruncated ||= captured.truncated
    try { spec.onStderr?.(chunk) } catch (error) { streamError ??= error instanceof Error ? error : new Error(String(error)) }
  })
  try { child.stdin.end(spec.stdin) } catch (error) { streamError ??= error instanceof Error ? error : new Error(String(error)) }

  const expectedIdentity = (async (): Promise<ExpectedProcessIdentity | undefined> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const identity = await probeProcessIdentity(child.pid!)
      if (identity.state === 'present'
        && identity.pgid === child.pid
        && processCommandMatches(command, identity.command)
        && (!hostIdentity || processCommandHasHostIdentity(identity.command, hostIdentity))) {
        return { pid: child.pid!, pgid: identity.pgid, executable: command, processStartedAt: identity.startedAt, ...hostIdentity }
      }
      if (identity.state === 'absent' || leaderClosed) return undefined
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return undefined
  })()
  const signalOwnedGroup = (signal: NodeJS.Signals): VerifiedSignalResult => {
    try {
      process.kill(-child.pid!, signal)
      return 'signaled'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed'
    }
  }
  let termination: Promise<void> | undefined
  const terminate = (): void => {
    termination ??= (async () => {
      const expected = await expectedIdentity
      const term = expected
        ? await signalVerifiedProcess(expected, 'SIGTERM', true)
        : signalOwnedGroup('SIGTERM')
      if (term !== 'signaled') return
      killTimer = setTimeout(() => {
        if (probeProcessGroup(child.pid!) === 'absent') return
        if (expected) void signalVerifiedProcess(expected, 'SIGKILL', true)
        else signalOwnedGroup('SIGKILL')
      }, SIGNAL_GRACE_MS)
      killTimer.unref()
    })()
  }
  const handleTimeout = (reason: NonNullable<ProcessResult['timeoutReason']>): void => {
    if (timedOut) return
    timedOut = true
    timeoutReason = reason
    terminate()
  }
  const timer = spec.timeoutMs ? setTimeout(() => handleTimeout('wall-clock'), spec.timeoutMs) : undefined
  timer?.unref()
  resetInactivityTimer = (): void => {
    if (!spec.inactivityTimeoutMs || leaderClosed || timedOut) return
    if (inactivityTimer) clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => handleTimeout('inactivity'), spec.inactivityTimeoutMs)
    inactivityTimer.unref()
  }
  resetInactivityTimer()
  const result = (async (): Promise<ProcessResult> => {
    const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once('close', (code, closeSignal) => resolve([code, closeSignal]))
    })
    leaderClosed = true
    if (timer) clearTimeout(timer)
    if (inactivityTimer) clearTimeout(inactivityTimer)
    if (killTimer && probeProcessGroup(child.pid!) === 'absent') clearTimeout(killTimer)
    if (processError) throw processError
    if (streamError) throw streamError
    return {
      pid: child.pid!,
      exitCode,
      signal,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      stdoutTruncated,
      stderrTruncated,
      timedOut,
      timeoutReason,
      cancelled
    }
  })()
  return {
    pid: child.pid,
    executable: command,
    result,
    cancel: () => { cancelled = true; if (!leaderClosed || probeProcessGroup(child.pid!) !== 'absent') terminate() }
  }
}

function appendDiagnosticTail(
  current: Buffer<ArrayBufferLike>,
  chunk: string,
  limit: number
): { bytes: Buffer<ArrayBufferLike>; truncated: boolean } {
  const incoming = Buffer.from(chunk)
  if (incoming.length >= limit) {
    return { bytes: Buffer.from(incoming.subarray(incoming.length - limit)), truncated: current.length > 0 || incoming.length > limit }
  }
  if (current.length + incoming.length <= limit) {
    return { bytes: Buffer.concat([current, incoming]), truncated: false }
  }
  const keep = limit - incoming.length
  return {
    bytes: Buffer.concat([current.subarray(current.length - keep), incoming]),
    truncated: true
  }
}

export async function runProcess(spec: ProcessSpec, lifecycle?: ProcessLifecycle, hostIdentity?: ProcessHostIdentity): Promise<ProcessResult> {
  const running = startProcess(spec, hostIdentity)
  let primaryFailure: unknown
  let cleanupFailure: unknown
  let processResult: ProcessResult | undefined
  if (lifecycle) {
    try {
      await lifecycle.started(running.pid, running.executable)
    } catch (error) {
      return settleRegistrationFailure(running, error)
    }
  }
  try {
    processResult = await running.result
  } catch (error) {
    primaryFailure = error
  }
  if (lifecycle) {
    try { await lifecycle.finished() } catch (error) {
      cleanupFailure = error
      if (primaryFailure) console.error('外部进程登记清理失败', error)
    }
  }
  if (primaryFailure) throw primaryFailure
  if (cleanupFailure) throw cleanupFailure
  if (!processResult) throw new Error('外部进程没有返回结果')
  return processResult
}
