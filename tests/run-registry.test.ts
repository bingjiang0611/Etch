import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProcessExitedBeforeRegistrationError, probeProcessIdentity, runProcess, startProcess, type ProcessHostIdentity, type RunningProcess } from '../src/main/runtime/process-runner'
import { RunRegistry } from '../src/main/runtime/run-registry'

const directories: string[] = []
const processes: RunningProcess[] = []
const hostIdentities = new WeakMap<RunningProcess, ProcessHostIdentity>()

afterEach(async () => {
  const runningProcesses = processes.splice(0)
  for (const running of runningProcesses) running.cancel()
  await Promise.all(runningProcesses.map((running) => running.result))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
}, 15_000)

async function registry(graceMs = 100): Promise<RunRegistry> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-run-registry-'))
  directories.push(directory)
  return new RunRegistry(join(directory, 'runs.json'), graceMs)
}

function nodeProcess(runs: RunRegistry, source = 'setInterval(() => undefined, 1_000)', onStdout?: (chunk: string) => void): RunningProcess {
  const hostIdentity = { runId: randomUUID(), appInstanceToken: runs.appInstanceToken }
  const running = startProcess({
    command: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    onStdout
  }, hostIdentity)
  hostIdentities.set(running, hostIdentity)
  processes.push(running)
  return running
}

async function stableProcess(runs: RunRegistry): Promise<RunningProcess> {
  const hostIdentity = { runId: randomUUID(), appInstanceToken: runs.appInstanceToken }
  const running = startProcess({ command: '/bin/sleep', args: ['60'], cwd: process.cwd() }, hostIdentity)
  hostIdentities.set(running, hostIdentity)
  processes.push(running)
  await new Promise((resolve) => setTimeout(resolve, 25))
  return running
}

function registration(running: RunningProcess) {
  const hostIdentity = hostIdentities.get(running)
  if (!hostIdentity) throw new Error('test process is missing host identity')
  return {
    ...hostIdentity,
    pid: running.pid,
    pgid: running.pid,
    executable: running.executable,
    taskId: randomUUID(),
    stage: 'translate'
  }
}

function leaderlessSource(releaseParent: string): string {
  return [
    "const { spawn } = require('node:child_process')",
    "const { existsSync } = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], { stdio: 'ignore' })",
    'child.unref()',
    'console.log(child.pid)',
    `const timer = setInterval(() => { if (existsSync(${JSON.stringify(releaseParent)})) { clearInterval(timer); process.exit(0) } }, 10)`
  ].join(';')
}

async function waitForPidToDisappear(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    try { process.kill(pid, 0) } catch { return true }
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  try { process.kill(pid, 0); return false } catch { return true }
}

describe('RunRegistry', () => {
  it('stops only the active process registered for the requested task', async () => {
    const runs = await registry(100)
    const first = await stableProcess(runs)
    const second = await stableProcess(runs)
    const firstInput = registration(first)
    const secondInput = registration(second)
    await runs.register(firstInput)
    await runs.register(secondInput)

    await expect(runs.stopTask(firstInput.taskId)).resolves.toBe(1)
    await first.result

    expect((await runs.load()).map((record) => record.taskId)).toEqual([secondInput.taskId])
    expect(await waitForPidToDisappear(first.pid, 1_000)).toBe(true)
    expect(await waitForPidToDisappear(second.pid, 50)).toBe(false)
  }, 15_000)

  it('serializes concurrent register and finish updates across registry instances without losing active records', async () => {
    const runs = await registry()
    const other = new RunRegistry(runs.path, 100, runs.appInstanceToken)
    const running = await Promise.all([stableProcess(runs), stableProcess(runs), stableProcess(runs)])
    const inputs = running.map(registration)

    await Promise.all([
      runs.register(inputs[0]),
      other.register(inputs[1]),
      runs.register(inputs[2])
    ])
    expect((await runs.load()).map((record) => record.runId).sort()).toEqual(inputs.map((input) => input.runId).sort())

    await Promise.all([runs.finish(inputs[0].runId), other.finish(inputs[1].runId)])
    expect((await runs.load()).map((record) => record.runId)).toEqual([inputs[2].runId])
  }, 30_000)

  it('serializes mixed finish and recover operations across registry instances', async () => {
    const runs = await registry(100)
    const other = new RunRegistry(runs.path, 100, runs.appInstanceToken)
    const running = await Promise.all([stableProcess(runs), stableProcess(runs), stableProcess(runs)])
    const inputs = running.map(registration)
    await Promise.all(inputs.map((input, index) => (index % 2 ? other : runs).register(input)))

    const [, , recovered] = await Promise.all([
      runs.finish(inputs[0].runId),
      other.finish(inputs[1].runId),
      runs.recover()
    ])

    expect(recovered.reclaimed.map((record) => record.runId)).toEqual([inputs[2].runId])
    expect(recovered.unverified).toEqual([])
    expect(await other.load()).toEqual([])
  }, 30_000)

  it('refuses registration when the sampled process group does not match the claimed pgid', async () => {
    const runs = await registry()
    const running = await stableProcess(runs)
    const input = { ...registration(running), pgid: running.pid + 100_000 }

    await expect(runs.register(input)).rejects.toThrow('无法证明新进程身份与进程组')
    expect(await runs.load()).toEqual([])
  }, 15_000)

  it('reports the narrow pre-registration exit race separately from other registration failures', async () => {
    const runs = await registry()
    const hostIdentity = { runId: randomUUID(), appInstanceToken: runs.appInstanceToken }
    const running = startProcess({ command: '/usr/bin/true', args: [], cwd: process.cwd() }, hostIdentity)
    hostIdentities.set(running, hostIdentity)
    processes.push(running)
    await running.result

    await expect(runs.register(registration(running))).rejects.toBeInstanceOf(ProcessExitedBeforeRegistrationError)
    expect(await runs.load()).toEqual([])
  })

  it('waits after SIGTERM and uses SIGKILL only while the registered process identity still matches', async () => {
    const runs = await registry(100)
    let ready!: () => void
    const readySignal = new Promise<void>((resolve) => { ready = resolve })
    const running = nodeProcess(runs,
      "process.on('SIGTERM', () => undefined); console.log('ready'); setInterval(() => undefined, 1_000)",
      () => ready()
    )
    await readySignal
    const input = registration(running)
    const record = await runs.register(input)

    const recovered = await runs.recover()

    expect(recovered.reclaimed).toEqual([record])
    expect(recovered.unverified).toEqual([])
    expect(await runs.load()).toEqual([])
    await expect(running.result).resolves.toMatchObject({ signal: 'SIGKILL' })
  }, 15_000)

  it('reclaims a leaderless descendant from the live runner before deleting its durable record', async () => {
    const runs = await registry(1_000)
    const releaseParent = join(directories.at(-1)!, 'release-live-parent')
    const runId = randomUUID()
    const taskId = randomUUID()
    let leaderPid = 0
    let grandchildPid = 0

    try {
      const result = await runProcess({
        command: process.execPath,
        args: ['-e', leaderlessSource(releaseParent)],
        cwd: process.cwd(),
        onStdout: (chunk) => { grandchildPid = Number(chunk.trim()) }
      }, {
        started: async (pid, executable) => {
          leaderPid = pid
          await runs.register({ runId, appInstanceToken: runs.appInstanceToken, pid, pgid: pid, executable, taskId, stage: 'translate' })
          await writeFile(releaseParent, 'release', 'utf8')
        },
        finished: () => runs.finish(runId)
      }, { runId, appInstanceToken: runs.appInstanceToken })

      expect(result).toMatchObject({ exitCode: 0, signal: null })
      expect(grandchildPid).toBeGreaterThan(0)
      expect(await runs.load()).toEqual([])
      expect(await waitForPidToDisappear(grandchildPid, 2_000)).toBe(true)
    } finally {
      if (leaderPid) try { process.kill(-leaderPid, 'SIGKILL') } catch { /* already reclaimed */ }
    }
  }, 15_000)

  it('keeps a cold-recovery leaderless group registered, rejects a replacement, and never blindly signals it', async () => {
    const runs = await registry(100)
    const releaseParent = join(directories.at(-1)!, 'release-parent')
    let grandchildPid = 0
    let ready!: () => void
    const readySignal = new Promise<void>((resolve) => { ready = resolve })
    const running = nodeProcess(runs,
      leaderlessSource(releaseParent),
      (chunk) => {
        grandchildPid = Number(chunk.trim())
        ready()
      }
    )
    await readySignal
    const input = registration(running)
    await runs.register(input)
    await writeFile(releaseParent, 'release', 'utf8')
    await running.result
    expect(() => process.kill(grandchildPid, 0)).not.toThrow()

    const killSpy = vi.spyOn(process, 'kill')
    try {
      const replacement = nodeProcess(runs)
      await expect(runs.register({ ...registration(replacement), taskId: input.taskId }))
        .rejects.toThrow('仍有活动 Provider 进程登记')

      const recovered = await runs.recover()
      expect(recovered.reclaimed).toEqual([])
      expect(recovered.unverified.map((record) => record.runId)).toEqual([input.runId])
      expect((await runs.load()).map((record) => record.runId)).toEqual([input.runId])
      expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
      expect(() => process.kill(grandchildPid, 0)).not.toThrow()

      killSpy.mockClear()
      const confirmed = await runs.confirmRecovery()
      expect(confirmed.reclaimed.map((record) => record.runId)).toEqual([input.runId])
      expect(confirmed.forgotten).toEqual([])
      expect(confirmed.unresolved).toEqual([])
      expect(await runs.load()).toEqual([])
      expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGTERM')).toBe(true)
      expect(await waitForPidToDisappear(grandchildPid, 2_000)).toBe(true)
    } finally {
      killSpy.mockRestore()
      try { process.kill(-running.pid, 'SIGKILL') } catch { /* already reclaimed */ }
    }
  }, 15_000)

  it('forgets a confirmed legacy leaderless record without signaling its unprovable group', async () => {
    const runs = await registry(100)
    const releaseParent = join(directories.at(-1)!, 'release-legacy-parent')
    let grandchildPid = 0
    let ready!: () => void
    const readySignal = new Promise<void>((resolve) => { ready = resolve })
    const running = nodeProcess(runs, leaderlessSource(releaseParent), (chunk) => {
      grandchildPid = Number(chunk.trim())
      ready()
    })
    await readySignal
    const identity = await probeProcessIdentity(running.pid)
    expect(identity.state).toBe('present')
    if (identity.state !== 'present') return
    const input = registration(running)
    const legacyRecord = {
      runId: input.runId,
      pid: input.pid,
      pgid: input.pgid,
      executable: input.executable,
      processStartedAt: identity.startedAt,
      taskId: input.taskId,
      stage: input.stage,
      registeredAt: new Date().toISOString()
    }
    await writeFile(runs.path, `${JSON.stringify({ schemaVersion: 1, active: [legacyRecord] })}\n`, 'utf8')
    await writeFile(releaseParent, 'release', 'utf8')
    await running.result
    expect(() => process.kill(grandchildPid, 0)).not.toThrow()

    const killSpy = vi.spyOn(process, 'kill')
    try {
      const recovered = await runs.recover()
      expect(recovered.reclaimed).toEqual([])
      expect(recovered.unverified).toEqual([legacyRecord])
      expect(await runs.load()).toEqual([legacyRecord])

      killSpy.mockClear()
      const confirmed = await runs.confirmRecovery()
      expect(confirmed).toEqual({ reclaimed: [], forgotten: [legacyRecord], unresolved: [] })
      expect(await runs.load()).toEqual([])
      expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
      expect(() => process.kill(grandchildPid, 0)).not.toThrow()
    } finally {
      killSpy.mockRestore()
      try { process.kill(-running.pid, 'SIGKILL') } catch { /* test-owned group already gone */ }
    }
  }, 15_000)

  it('never signals a reused PID, returns it for explicit recovery confirmation, and clears the stale record', async () => {
    const runs = await registry()
    const record = {
      runId: randomUUID(),
      pid: process.pid,
      pgid: process.pid,
      executable: process.execPath,
      processStartedAt: 'identity-does-not-match',
      taskId: randomUUID(),
      stage: 'audit',
      registeredAt: new Date().toISOString()
    }
    await writeFile(runs.path, `${JSON.stringify({ schemaVersion: 1, active: [record] })}\n`, 'utf8')
    const killSpy = vi.spyOn(process, 'kill')
    try {
      const recovered = await runs.recover()

      expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
      expect(recovered.reclaimed).toEqual([])
      expect(recovered.unverified).toEqual([record])
      expect(await runs.load()).toEqual([])
    } finally {
      killSpy.mockRestore()
    }
  })

  it('treats a live schema-v1 record without host tokens as unverified and never signals it', async () => {
    const runs = await registry()
    const running = startProcess({ command: '/bin/sleep', args: ['60'], cwd: process.cwd() })
    processes.push(running)
    const identity = await probeProcessIdentity(running.pid)
    expect(identity.state).toBe('present')
    if (identity.state !== 'present') return
    const record = {
      runId: randomUUID(),
      pid: running.pid,
      pgid: identity.pgid,
      executable: running.executable,
      processStartedAt: identity.startedAt,
      taskId: randomUUID(),
      stage: 'translate',
      registeredAt: new Date().toISOString()
    }
    await writeFile(runs.path, `${JSON.stringify({ schemaVersion: 1, active: [record] })}\n`, 'utf8')
    const killSpy = vi.spyOn(process, 'kill')
    try {
      const recovered = await runs.recover()

      expect(recovered.reclaimed).toEqual([])
      expect(recovered.unverified).toEqual([record])
      expect(await runs.load()).toEqual([record])
      expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
      expect(() => process.kill(running.pid, 0)).not.toThrow()

      const currentRunning = await stableProcess(runs)
      const currentInput = registration(currentRunning)
      const currentRecord = await runs.register(currentInput)
      killSpy.mockClear()
      const confirmed = await runs.confirmRecovery()
      expect(confirmed.reclaimed).toEqual([])
      expect(confirmed.forgotten).toEqual([record])
      expect(confirmed.unresolved).toEqual([])
      expect(await runs.load()).toEqual([currentRecord])
      expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
      expect(() => process.kill(running.pid, 0)).not.toThrow()
      expect(() => process.kill(currentRunning.pid, 0)).not.toThrow()

      await runs.finish(currentInput.runId)
      expect(await runs.load()).toEqual([])
    } finally {
      killSpy.mockRestore()
    }
  })

  it('reports whether a task still has a durable active run', async () => {
    const runs = await registry()
    const running = await stableProcess(runs)
    const input = registration(running)
    await runs.register(input)

    expect(await runs.hasActiveTask(input.taskId)).toBe(true)
    expect(await runs.hasActiveTask(randomUUID())).toBe(false)

    await runs.finish(input.runId)
    expect(await runs.hasActiveTask(input.taskId)).toBe(false)
  }, 15_000)
})
