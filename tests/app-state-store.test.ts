import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppStateStore } from '../src/main/storage/app-state-store'

describe('AppStateStore', () => {
  it('establishes recoveryHold after an unclean launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-state-'))
    const store = new AppStateStore(join(root, 'app-state.json'))
    expect((await store.beginLaunch()).recoveryHold).toBe(false)
    expect((await store.beginLaunch()).recoveryHold).toBe(true)
    await store.releaseRecoveryHold()
    await store.markCleanExit()
    expect((await store.load()).cleanExit).toBe(true)
  })

  it('claims the full disk access onboarding only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-state-'))
    const store = new AppStateStore(join(root, 'app-state.json'))
    expect(await store.claimFullDiskAccessOnboarding()).toBe(true)
    expect(await store.claimFullDiskAccessOnboarding()).toBe(false)
    expect((await store.load()).fullDiskAccessOnboardingShown).toBe(true)
  })

  it('treats app state written by older Etch versions as not onboarded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-state-'))
    const path = join(root, 'app-state.json')
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      cleanExit: true,
      recoveryHold: false,
      updatedAt: new Date().toISOString()
    }))
    const store = new AppStateStore(path)
    expect((await store.load()).fullDiskAccessOnboardingShown).toBe(false)
    expect(await store.claimFullDiskAccessOnboarding()).toBe(true)
  })
})
