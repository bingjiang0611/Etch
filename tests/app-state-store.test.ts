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

  it('records only a deliberate skip and lets a granted permission clear it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-state-'))
    const store = new AppStateStore(join(root, 'app-state.json'))
    expect((await store.load()).fullDiskAccessGuideDismissed).toBe(false)
    await store.setFullDiskAccessGuideDismissed(true)
    expect((await store.load()).fullDiskAccessGuideDismissed).toBe(true)
    await store.setFullDiskAccessGuideDismissed(false)
    expect((await store.load()).fullDiskAccessGuideDismissed).toBe(false)
  })

  it('re-guides users whose older app state only recorded that the dialog was shown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-state-'))
    const path = join(root, 'app-state.json')
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      cleanExit: true,
      recoveryHold: false,
      fullDiskAccessOnboardingShown: true,
      updatedAt: new Date().toISOString()
    }))
    const store = new AppStateStore(path)
    expect((await store.load()).fullDiskAccessGuideDismissed).toBe(false)
  })
})
