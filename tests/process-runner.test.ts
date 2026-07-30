import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyProcessGroupStates, ProcessExitedBeforeRegistrationError, probeProcessGroupLiveness, probeProcessIdentity, processCommandHasHostIdentity, runProcess, signalVerifiedProcess, startProcess, type RunningProcess } from '../src/main/runtime/process-runner'

const processes: RunningProcess[] = []

async function waitForPidToDisappear(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    try { process.kill(pid, 0) } catch { return true }
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  try { process.kill(pid, 0); return false } catch { return true }
}

afterEach(async () => {
  vi.restoreAllMocks()
  const runningProcesses = processes.splice(0)
  for (const running of runningProcesses) running.cancel()
  await Promise.all(runningProcesses.map((running) => running.result))
})

function nodeProcess(source: string): RunningProcess {
  const running = startProcess({ command: process.execPath, args: ['-e', source], cwd: process.cwd() })
  processes.push(running)
  return running
}

describe('process runner safety', () => {
  it('treats an all-zombie process group as absent without hiding live or malformed members', () => {
    expect(classifyProcessGroupStates('Z\nZ+\n')).toBe('absent')
    expect(classifyProcessGroupStates('')).toBe('absent')
    expect(classifyProcessGroupStates('Z\nS+\n')).toBe('present')
    expect(classifyProcessGroupStates('unexpected')).toBe('unknown')
  })

  it('probes a live process group and a missing process group through ps', async () => {
    const running = nodeProcess('setInterval(() => undefined, 1_000)')

    await expect(probeProcessGroupLiveness(running.pid)).resolves.toBe('present')
    await expect(probeProcessGroupLiveness(2_147_483_647)).resolves.toBe('absent')
  })

  it('runs an argv-only child behind a token-attested process-group host', async () => {
    const hostIdentity = { runId: randomUUID(), appInstanceToken: randomUUID() }
    const originalClaudeCode = process.env.CLAUDECODE
    process.env.CLAUDECODE = 'parent-pollution'
    try {
      const running = startProcess({
        command: '/bin/sh',
        args: ['-c', 'printf "%s\\n" "$1" "${ELECTRON_RUN_AS_NODE-unset}" "${CLAUDECODE-unset}" "$ETCH_EXPLICIT_ENV"', 'etch-child', 'argument with spaces'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, ETCH_EXPLICIT_ENV: 'preserved' }
      }, hostIdentity)
      processes.push(running)

      const identity = await probeProcessIdentity(running.pid)
      expect(identity.state).toBe('present')
      if (identity.state === 'present') {
        expect(identity.pgid).toBe(running.pid)
        expect(processCommandHasHostIdentity(identity.command, hostIdentity)).toBe(true)
        expect(processCommandHasHostIdentity(identity.command, { ...hostIdentity, runId: randomUUID() })).toBe(false)
      }

      const result = await running.result
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toEqual(['argument with spaces', 'unset', 'unset', 'preserved'])
    } finally {
      if (originalClaudeCode === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = originalClaudeCode
    }
  })

  it('exits the host deterministically when the target process dies from a signal', async () => {
    const hostIdentity = { runId: randomUUID(), appInstanceToken: randomUUID() }
    const running = startProcess({
      command: '/bin/sh',
      args: ['-c', 'kill -TERM $$'],
      cwd: process.cwd()
    }, hostIdentity)
    processes.push(running)

    await expect(running.result).resolves.toMatchObject({ exitCode: 143, signal: null })
    expect(await waitForPidToDisappear(running.pid, 1_000)).toBe(true)
  })

  it('contains an asynchronous spawn error instead of crashing the host process', async () => {
    expect(() => startProcess({
      command: '/definitely/missing/etch-provider',
      args: [],
      cwd: process.cwd()
    })).toThrow('无法启动进程')

    await new Promise((resolve) => setImmediate(resolve))
  })

  it('turns stdin EPIPE into a rejected result instead of an unhandled stream error', async () => {
    const running = startProcess({
      command: '/usr/bin/true',
      args: [],
      cwd: process.cwd(),
      stdin: 'x'.repeat(16 * 1024 * 1024)
    })

    await expect(running.result).rejects.toMatchObject({ code: 'EPIPE' })
  }, 15_000)

  it('accepts a fast successful process that exits before durable registration can sample it', async () => {
    const finished = vi.fn(async () => undefined)

    const result = await runProcess({ command: '/usr/bin/true', args: [], cwd: process.cwd() }, {
      started: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new ProcessExitedBeforeRegistrationError()
      },
      finished
    })

    expect(result).toMatchObject({ exitCode: 0, cancelled: false })
    expect(finished).not.toHaveBeenCalled()
  })

  it('does not swallow an arbitrary registration failure merely because the process already exited', async () => {
    await expect(runProcess({ command: '/usr/bin/true', args: [], cwd: process.cwd() }, {
      started: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('registry write failed')
      },
      finished: async () => undefined
    })).rejects.toThrow('registry write failed')
  })

  it('does not accept an abnormal exit as a pre-registration success race', async () => {
    await expect(runProcess({ command: '/usr/bin/false', args: [], cwd: process.cwd() }, {
      started: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new ProcessExitedBeforeRegistrationError()
      },
      finished: async () => undefined
    })).rejects.toBeInstanceOf(ProcessExitedBeforeRegistrationError)
  })

  it('reclaims a leaderless descendant after registration fails instead of leaving its process group behind', async () => {
    let descendantPid = 0
    let ready!: () => void
    const readySignal = new Promise<void>((resolve) => { ready = resolve })

    await expect(runProcess({
      command: process.execPath,
      args: ['-e', [
        "const { spawn } = require('node:child_process')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], { stdio: 'ignore' })",
        'child.unref()',
        'console.log(child.pid)',
        'setTimeout(() => process.exit(0), 100)'
      ].join(';')],
      cwd: process.cwd(),
      onStdout: (chunk) => {
        descendantPid = Number(chunk.trim())
        ready()
      }
    }, {
      started: async () => {
        await readySignal
        await new Promise((resolve) => setTimeout(resolve, 200))
        throw new Error('registry write failed')
      },
      finished: async () => undefined
    })).rejects.toThrow('registry write failed')

    expect(descendantPid).toBeGreaterThan(0)
    expect(await waitForPidToDisappear(descendantPid, 2_000)).toBe(true)
  }, 15_000)

  it('waits for close and captures a child final stderr payload completely', async () => {
    const length = 2 * 1024 * 1024
    const running = nodeProcess(`process.stderr.write('z'.repeat(${length}))`)

    const result = await running.result

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toHaveLength(length)
    expect(result.stderr.startsWith('zzzz')).toBe(true)
    expect(result.stderr.endsWith('zzzz')).toBe(true)
    expect(result.stderrTruncated).toBe(false)
  }, 15_000)

  it('keeps bounded diagnostic tails while streaming every output chunk', async () => {
    let streamedStdout = ''
    let streamedStderr = ''
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', [
        "process.stdout.write('early-out-' + 'x'.repeat(4096) + '-late-out')",
        "process.stderr.write('early-err-' + 'y'.repeat(4096) + '-late-err')"
      ].join(';')],
      cwd: process.cwd(),
      captureLimitBytes: 256,
      onStdout: (chunk) => { streamedStdout += chunk },
      onStderr: (chunk) => { streamedStderr += chunk }
    })

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(256)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(256)
    expect(result.stdout).not.toContain('early-out')
    expect(result.stdout).toContain('late-out')
    expect(result.stderr).not.toContain('early-err')
    expect(result.stderr).toContain('late-err')
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(streamedStdout).toContain('early-out-')
    expect(streamedStdout).toContain('-late-out')
    expect(streamedStderr).toContain('early-err-')
    expect(streamedStderr).toContain('-late-err')
  })

  it('keeps a process alive while output continues within the inactivity window', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', "let count = 0; setInterval(() => { console.log('tick'); if (++count === 5) process.exit(0) }, 50)"],
      cwd: process.cwd(),
      inactivityTimeoutMs: 3_000
    })

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false })
    expect(result.stdout.match(/tick/gu)).toHaveLength(5)
  })

  it('terminates a process after the inactivity window and records the timeout reason', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1_000)'],
      cwd: process.cwd(),
      inactivityTimeoutMs: 100
    })

    expect(result).toMatchObject({
      timedOut: true,
      timeoutReason: 'inactivity',
      cancelled: false
    })
  })

  it('clears the pending SIGKILL escalation after a child closes on SIGTERM', async () => {
    const killSpy = vi.spyOn(process, 'kill')
    let ready!: () => void
    const readySignal = new Promise<void>((resolve) => { ready = resolve })
    const running = startProcess({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => undefined, 1_000)"],
      cwd: process.cwd(),
      onStdout: () => ready()
    })
    processes.push(running)
    await readySignal
    running.cancel()

    await expect(running.result).resolves.toMatchObject({ exitCode: 0, cancelled: true })
    await new Promise((resolve) => setTimeout(resolve, 2_100))

    expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGTERM')).toBe(true)
    expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false)
  }, 15_000)

  it('does not signal when the current pid identity or process group differs', async () => {
    const identity = await probeProcessIdentity(process.pid)
    expect(identity.state).toBe('present')
    if (identity.state !== 'present') return
    const killSpy = vi.spyOn(process, 'kill')

    const result = await signalVerifiedProcess({
      pid: process.pid,
      pgid: identity.pgid + 1,
      executable: process.execPath,
      processStartedAt: identity.startedAt
    }, 'SIGTERM')

    expect(result).toBe('mismatch')
    expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
  })
})
