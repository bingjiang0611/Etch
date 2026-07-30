import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmProviderRecovery, recoverProviderRunsAtStartup, requireRecoveryConfirmationForUnverifiedRuns } from '../src/main/runtime/startup-recovery'
import { AppStateStore } from '../src/main/storage/app-state-store'
import { RunRegistry, type RunRecord } from '../src/main/runtime/run-registry'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('startup provider recovery', () => {
  it('persists recovery hold and reports identity-mismatched orphan records before pipeline startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-startup-recovery-'))
    directories.push(directory)
    const state = new AppStateStore(join(directory, 'app-state.json'))
    await state.beginLaunch()
    const record: RunRecord = {
      runId: randomUUID(),
      pid: 12345,
      pgid: 12345,
      executable: '/mock/codex',
      processStartedAt: 'identity-before-reuse',
      taskId: randomUUID(),
      stage: 'translate',
      registeredAt: new Date().toISOString()
    }
    const warn = vi.fn()

    await expect(requireRecoveryConfirmationForUnverifiedRuns([record], state, warn)).resolves.toBe(1)

    expect((await state.load()).recoveryHold).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('等待用户确认恢复'), {
      taskId: record.taskId,
      stage: 'translate',
      pid: 12345,
      pgid: 12345,
      reason: 'process identity or process-group ownership could not be verified'
    })
  })

  it('does not create a recovery hold when no unverified process exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-startup-recovery-empty-'))
    directories.push(directory)
    const state = new AppStateStore(join(directory, 'app-state.json'))
    await state.beginLaunch()

    await expect(requireRecoveryConfirmationForUnverifiedRuns([], state)).resolves.toBe(0)

    expect((await state.load()).recoveryHold).toBe(false)
  })

  it('lets startup finish with an unverified run and persists the recovery hold for the UI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-startup-recovery-ui-'))
    directories.push(directory)
    const state = new AppStateStore(join(directory, 'app-state.json'))
    await state.beginLaunch()
    const record: RunRecord = {
      runId: randomUUID(), pid: 12345, pgid: 12345, executable: '/mock/codex',
      processStartedAt: 'unverified', taskId: randomUUID(), stage: 'translate', registeredAt: new Date().toISOString()
    }
    const recover = vi.fn(async () => ({ reclaimed: [], unverified: [record] }))
    const runs = { recover } as unknown as RunRegistry

    const result = await recoverProviderRunsAtStartup(runs, state, vi.fn())

    expect(result.unverifiedRuns).toBe(1)
    expect(result.unverified).toEqual([record])
    expect((await state.load()).recoveryHold).toBe(true)
  })

  it('releases recovery only after confirmed Provider records are resolved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-startup-confirm-recovery-'))
    directories.push(directory)
    const state = new AppStateStore(join(directory, 'app-state.json'))
    await state.beginLaunch()
    await state.holdRecovery()
    const record: RunRecord = {
      runId: randomUUID(), pid: 12345, pgid: 12345, executable: '/mock/codex',
      processStartedAt: 'unverified', taskId: randomUUID(), stage: 'translate', registeredAt: new Date().toISOString()
    }
    const confirmRecovery = vi.fn()
      .mockResolvedValueOnce({ reclaimed: [], forgotten: [], unresolved: [record] })
      .mockResolvedValueOnce({ reclaimed: [record], forgotten: [], unresolved: [] })
    const runs = { confirmRecovery } as unknown as RunRegistry

    await expect(confirmProviderRecovery(runs, state, vi.fn())).resolves.toEqual({ released: false, unresolved: 1 })
    expect((await state.load()).recoveryHold).toBe(true)

    await expect(confirmProviderRecovery(runs, state, vi.fn())).resolves.toEqual({ released: true, unresolved: 0 })
    expect((await state.load()).recoveryHold).toBe(false)
  })

  it('surfaces a corrupt durable registry so the main startup catch can diagnose and exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-startup-corrupt-registry-'))
    directories.push(directory)
    const state = new AppStateStore(join(directory, 'app-state.json'))
    await state.beginLaunch()
    const runs = new RunRegistry(join(directory, 'run-registry.json'))
    await writeFile(runs.path, '{broken-json', 'utf8')

    await expect(recoverProviderRunsAtStartup(runs, state, vi.fn())).rejects.toBeDefined()
  })
})
