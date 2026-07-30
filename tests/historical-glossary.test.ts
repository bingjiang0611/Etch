import { mkdtemp, open, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { sha256File } from '../src/main/core/fingerprint'
import type { IndexedTask } from '../src/main/storage/index-store'
import { TaskStore } from '../src/main/storage/task-store'
import { createTaskManifest, type TaskManifest } from '../src/shared/task-schema'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function historicalTask(options: {
  source: string
  target: string
  producer?: string
  audited?: boolean
  reviewed?: boolean
  verified?: boolean
  indexedStatus?: string
  mtimeMs?: number
  english?: string
}): Promise<{ directory: string; manifest: TaskManifest; indexed: IndexedTask }> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-history-'))
  directories.push(directory)
  const manifest = createTaskManifest({ kind: 'url', url: `https://example.com/${directories.length}` }, '', 'codex')
  for (const stage of Object.values(manifest.pipeline.stages)) stage.status = 'completed'
  manifest.pipeline.stages.audit.status = options.audited === false ? 'pending' : 'completed'
  if (options.reviewed === false) {
    manifest.pipeline.stages.review.status = 'checkpoint'
    manifest.pipeline.stages.review.checkpointId = 'manual-review'
    for (const stage of ['srt', 'burn', 'verify'] as const) manifest.pipeline.stages[stage].status = 'pending'
  } else if (options.verified === false) {
    manifest.pipeline.stages.verify.status = 'pending'
  }
  const auditPath = join(directory, 'audit.json')
  const englishPath = join(directory, 'english.clean.srt')
  await writeFile(auditPath, `${JSON.stringify({
    glossary: [{ source: options.source, target: options.target, cueIds: [1] }],
    patches: []
  })}\n`, 'utf8')
  await writeFile(englishPath, `1\n00:00:00,000 --> 00:00:02,000\n${options.english ?? options.source}\n`, 'utf8')
  if (options.mtimeMs !== undefined) {
    const time = new Date(options.mtimeMs)
    await utimes(auditPath, time, time)
  }
  const info = await stat(auditPath)
  const englishInfo = await stat(englishPath)
  manifest.artifacts.audit = {
    relativePath: 'audit.json',
    sha256: await sha256File(auditPath),
    size: info.size,
    valid: true,
    producer: options.producer ?? 'global-audit',
    inputFingerprint: '1'.repeat(64)
  }
  manifest.artifacts.englishClean = {
    relativePath: 'english.clean.srt',
    sha256: await sha256File(englishPath),
    size: englishInfo.size,
    valid: true,
    producer: 'etch-srt',
    inputFingerprint: '2'.repeat(64)
  }
  const store = new TaskStore()
  await store.create(directory, manifest)
  return {
    directory,
    manifest,
    indexed: {
      taskId: manifest.taskId,
      location: directory,
      title: manifest.title,
      revision: manifest.revision,
      status: options.indexedStatus ?? 'completed',
      updatedAt: manifest.updatedAt
    }
  }
}

describe('HistoricalGlossaryService', () => {
  it('uses relevant audited aliases, lets manual history override newer automatic history, and lets history override settings', async () => {
    const automatic = await historicalTask({ source: 'Julien/Julian Alvarez', target: '胡利安·阿尔瓦雷斯', mtimeMs: 2_000 })
    const manual = await historicalTask({ source: 'Julien Alvarez', target: '胡利安·阿尔瓦雷斯', producer: 'user-glossary-edit', mtimeMs: 1_000 })
    const unrelated = await historicalTask({ source: 'yellow card', target: '黄牌', mtimeMs: 3_000 })
    const current = await historicalTask({ source: 'Julian Alvarez', target: '不应读取当前任务', producer: 'user-glossary-edit', mtimeMs: 4_000 })
    const tasks = [automatic.indexed, manual.indexed, unrelated.indexed, current.indexed]
    const service = new HistoricalGlossaryService(new TaskStore(), () => tasks)

    const snapshot = await service.resolve(
      current.manifest.taskId,
      'Julien Alvarez enters the runtime.',
      { 'Julien Alvarez': '设置译法', runtime: '运行时' }
    )

    expect(snapshot.entries).toEqual([
      expect.objectContaining({ source: 'Julien Alvarez', target: '胡利安·阿尔瓦雷斯', authority: 'historical', sourceTaskId: manual.manifest.taskId }),
      { source: 'runtime', target: '运行时', authority: 'settings', contextSamples: [] }
    ])
    expect(snapshot.stats).toEqual({
      candidateTasks: 4,
      validArtifacts: 4,
      skippedArtifacts: 0,
      historicalEntries: 1,
      settingsEntries: 1
    })
  })

  it('uses the newer artifact for conflicts at the same authority level', async () => {
    const older = await historicalTask({ source: 'agent', target: '智能体', mtimeMs: 1_000 })
    const newer = await historicalTask({ source: 'Agent', target: '智能体', mtimeMs: 2_000 })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [older.indexed, newer.indexed])
    const snapshot = await service.resolve(crypto.randomUUID(), 'An AGENT is running.', {})
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ source: 'Agent', target: '智能体', sourceTaskId: newer.manifest.taskId })
    ])
  })

  it('preserves multiple historical meanings for the same source with cue context evidence', async () => {
    const finance = await historicalTask({ source: 'bank', target: '银行', english: 'The bank approved the loan.', producer: 'user-glossary-edit', mtimeMs: 1_000 })
    const river = await historicalTask({ source: 'bank', target: '河岸', english: 'They rested on the river bank.', mtimeMs: 2_000 })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [finance.indexed, river.indexed])
    const snapshot = await service.resolve(crypto.randomUUID(), 'The bank approved a mortgage.', {})
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ source: 'bank', target: '银行', contextSamples: ['The bank approved the loan.'] }),
      expect.objectContaining({ source: 'bank', target: '河岸', contextSamples: ['They rested on the river bank.'] })
    ])
  })

  it('expands parenthetical plural suffixes without creating a single-letter historical alias', async () => {
    const history = await historicalTask({
      source: 'memory session(s)',
      target: '记忆会话',
      english: 'Memory sessions persist across turns.',
      producer: 'user-glossary-edit'
    })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [history.indexed])

    expect((await service.resolve(crypto.randomUUID(), "The model's memory sessions persist.", {})).entries).toEqual([
      expect.objectContaining({ source: 'memory sessions', target: '记忆会话' })
    ])
    expect((await service.resolve(crypto.randomUUID(), "The model's memory session persists.", {})).entries).toEqual([
      expect.objectContaining({ source: 'memory session', target: '记忆会话' })
    ])
    expect((await service.resolve(crypto.randomUUID(), "The model's output is ready.", {})).entries).toEqual([])
  })

  it('selects a singular historical source for regular plural-only current cues', async () => {
    const history = await historicalTask({
      source: 'key',
      target: '键',
      english: 'Press the key to continue.',
      producer: 'user-glossary-edit'
    })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [history.indexed])

    expect((await service.resolve(crypto.randomUUID(), 'The sandbox can read your SSH keys.', {})).entries).toEqual([
      expect.objectContaining({ source: 'key', target: '键' })
    ])
    expect((await service.resolve(crypto.randomUUID(), 'Monkeys use keyboards.', {})).entries).toEqual([])
  })

  it('does not match a direct single-letter historical term inside an English possessive', async () => {
    const history = await historicalTask({
      source: 'S',
      target: '状态变量',
      english: 'State S is stable.',
      producer: 'user-glossary-edit'
    })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [history.indexed])

    expect((await service.resolve(crypto.randomUUID(), "The model's output is ready.", {})).entries).toEqual([])
    expect((await service.resolve(crypto.randomUUID(), 'State S is stable.', {})).entries).toEqual([
      expect.objectContaining({ source: 'S', target: '状态变量' })
    ])
  })

  it('isolates malformed, mismatched and out-of-root audit artifacts while preserving valid history', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const valid = await historicalTask({ source: 'World Cup', target: '世界杯' })
    const malformed = await historicalTask({ source: 'agent', target: '智能体' })
    await writeFile(join(malformed.directory, 'audit.json'), '{invalid', 'utf8')
    const malformedInfo = await stat(join(malformed.directory, 'audit.json'))
    const malformedSha = await sha256File(join(malformed.directory, 'audit.json'))
    const malformedStore = new TaskStore()
    await malformedStore.mutate(malformed.directory, (manifest) => {
      manifest.artifacts.audit!.size = malformedInfo.size
      manifest.artifacts.audit!.sha256 = malformedSha
    })
    const sizeMismatch = await historicalTask({ source: 'runtime', target: '运行时' })
    const sizeStore = new TaskStore()
    await sizeStore.mutate(sizeMismatch.directory, (manifest) => { manifest.artifacts.audit!.size += 1 })
    const outside = await historicalTask({ source: 'model', target: '模型' })
    const externalDirectory = await mkdtemp(join(tmpdir(), 'etch-history-outside-'))
    directories.push(externalDirectory)
    const externalPath = join(externalDirectory, 'audit.json')
    await writeFile(externalPath, `${JSON.stringify({ glossary: [{ source: 'model', target: '外部', cueIds: [1] }], patches: [] })}\n`)
    const outsideStore = new TaskStore()
    await outsideStore.mutate(outside.directory, (manifest) => {
      manifest.artifacts.audit!.relativePath = relative(outside.directory, externalPath)
    })
    const oversized = await historicalTask({ source: 'token', target: '词元' })
    const oversizedPath = join(oversized.directory, 'audit.json')
    await writeFile(oversizedPath, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf8')
    const oversizedInfo = await stat(oversizedPath)
    const oversizedSha = await sha256File(oversizedPath)
    const oversizedStore = new TaskStore()
    await oversizedStore.mutate(oversized.directory, (manifest) => {
      manifest.artifacts.audit!.size = oversizedInfo.size
      manifest.artifacts.audit!.sha256 = oversizedSha
    })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [
      valid.indexed,
      malformed.indexed,
      sizeMismatch.indexed,
      outside.indexed,
      oversized.indexed
    ])

    const snapshot = await service.resolve(crypto.randomUUID(), 'The World Cup agent runtime model token.', {})
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ source: 'World Cup', target: '世界杯', authority: 'historical' })
    ])
    expect(snapshot.stats).toMatchObject({ candidateTasks: 5, validArtifacts: 1, skippedArtifacts: 4, historicalEntries: 1 })
    expect(console.warn).toHaveBeenCalledTimes(4)
  })

  it('does not treat unfinished audits as authoritative history', async () => {
    const unfinished = await historicalTask({ source: 'agent', target: '智能体', audited: false })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [unfinished.indexed])
    const snapshot = await service.resolve(crypto.randomUUID(), 'An agent.', {})
    expect(snapshot.entries).toEqual([])
    expect(snapshot.stats).toMatchObject({ candidateTasks: 1, validArtifacts: 0, skippedArtifacts: 1 })
  })

  it('does not treat an audit-complete manual-review checkpoint as authoritative history', async () => {
    const unreviewed = await historicalTask({ source: 'agent', target: '智能体', reviewed: false })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [unreviewed.indexed])
    const snapshot = await service.resolve(crypto.randomUUID(), 'An agent.', {})
    expect(snapshot.entries).toEqual([])
    expect(snapshot.stats).toMatchObject({ candidateTasks: 1, validArtifacts: 0, skippedArtifacts: 1 })
  })

  it('does not treat a reviewed but undelivered task as authoritative history', async () => {
    const undelivered = await historicalTask({ source: 'agent', target: '智能体', verified: false })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [undelivered.indexed])
    const snapshot = await service.resolve(crypto.randomUUID(), 'An agent.', {})
    expect(snapshot.entries).toEqual([])
    expect(snapshot.stats).toMatchObject({ candidateTasks: 1, validArtifacts: 0, skippedArtifacts: 1 })
  })

  it('does not treat a task that skipped human review as authoritative history', async () => {
    const skippedReview = await historicalTask({ source: 'agent', target: '智能体' })
    const store = new TaskStore()
    await store.mutate(skippedReview.directory, (manifest) => { manifest.pipeline.stages.review.status = 'skipped' })
    const service = new HistoricalGlossaryService(store, () => [skippedReview.indexed])
    const snapshot = await service.resolve(crypto.randomUUID(), 'An agent.', {})
    expect(snapshot.entries).toEqual([])
    expect(snapshot.stats).toMatchObject({ candidateTasks: 1, validArtifacts: 0, skippedArtifacts: 1 })
  })

  it('does not treat a terminal task that skipped final verification as authoritative history', async () => {
    const skippedVerify = await historicalTask({ source: 'agent', target: '智能体' })
    const store = new TaskStore()
    await store.mutate(skippedVerify.directory, (manifest) => { manifest.pipeline.stages.verify.status = 'skipped' })
    const service = new HistoricalGlossaryService(store, () => [skippedVerify.indexed])
    const snapshot = await service.resolve(crypto.randomUUID(), 'An agent.', {})
    expect(snapshot.entries).toEqual([])
    expect(snapshot.stats).toMatchObject({ candidateTasks: 1, validArtifacts: 0, skippedArtifacts: 1 })
  })

  it('prefilters non-completed task index rows before reading historical artifacts', async () => {
    const pending = await historicalTask({ source: 'agent', target: '智能体', indexedStatus: 'pending' })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [pending.indexed])
    const snapshot = await service.resolve(crypto.randomUUID(), 'An agent.', {})
    expect(snapshot.entries).toEqual([])
    expect(snapshot.stats).toMatchObject({ candidateTasks: 0, validArtifacts: 0, skippedArtifacts: 0 })
  })

  it('keeps the previously validated library copy when its source artifact is later corrupted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const history = await historicalTask({ source: 'agent', target: '智能体' })
    const service = new HistoricalGlossaryService(new TaskStore(), () => [history.indexed])
    expect((await service.resolve(crypto.randomUUID(), 'An agent.', {})).entries).toHaveLength(1)
    const auditPath = join(history.directory, 'audit.json')
    const before = await stat(auditPath)
    const bytes = await readFile(auditPath)
    await writeFile(auditPath, Buffer.alloc(bytes.length, 0x78))
    await utimes(auditPath, before.atime, before.mtime)
    const snapshot = await service.resolve(crypto.randomUUID(), 'An agent.', {})
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ source: 'agent', target: '智能体', authority: 'historical' })
    ])
    expect(snapshot.stats).toMatchObject({ validArtifacts: 0, skippedArtifacts: 1 })
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it('persists one unified entry for duplicate terms, preserves distinct meanings, and keeps deletions suppressed', async () => {
    const first = await historicalTask({ source: 'agent', target: '智能体', english: 'The agent is ready.' })
    const duplicate = await historicalTask({ source: 'Agent', target: '智能体', english: 'An Agent is running.' })
    const distinctMeaning = await historicalTask({ source: 'agent', target: '代理人', english: 'The agent represents the player.' })
    const directory = await mkdtemp(join(tmpdir(), 'etch-global-glossary-'))
    directories.push(directory)
    const libraryPath = join(directory, 'glossary.json')
    const tasks = [first.indexed, duplicate.indexed, distinctMeaning.indexed]
    const service = new HistoricalGlossaryService(new TaskStore(), () => tasks, libraryPath)

    const initial = await service.libraryPage('', 0, 50)
    expect(initial.items).toHaveLength(2)
    expect(initial.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: '智能体', sourceCount: 2 }),
      expect.objectContaining({ target: '代理人', sourceCount: 1 })
    ]))

    const duplicateEntry = initial.items.find((item) => item.target === '智能体')!
    await service.deleteEntry(duplicateEntry.id, initial.revision)
    await expect(service.deleteEntry(initial.items.find((item) => item.target === '代理人')!.id, initial.revision))
      .rejects.toThrow('术语库已更新')
    expect((await service.libraryPage('', 0, 50)).items).toEqual([
      expect.objectContaining({ target: '代理人' })
    ])

    const restarted = new HistoricalGlossaryService(new TaskStore(), () => tasks, libraryPath)
    expect((await restarted.libraryPage('', 0, 50)).items).toEqual([
      expect.objectContaining({ target: '代理人' })
    ])
    expect((await restarted.resolve(crypto.randomUUID(), 'An agent is ready.', {})).entries).toEqual([
      expect.objectContaining({ target: '代理人' })
    ])
  })

  it('reconciles sources and import markers after the authoritative task is removed', async () => {
    const history = await historicalTask({ source: 'agent', target: '智能体' })
    const directory = await mkdtemp(join(tmpdir(), 'etch-global-glossary-'))
    directories.push(directory)
    const libraryPath = join(directory, 'glossary.json')
    const tasks = [history.indexed]
    const service = new HistoricalGlossaryService(new TaskStore(), () => tasks, libraryPath)

    expect((await service.libraryPage('', 0, 50)).items).toHaveLength(1)
    tasks.splice(0)
    await service.sync()
    expect((await service.libraryPage('', 0, 50)).items).toEqual([])

    const persisted = JSON.parse(await readFile(libraryPath, 'utf8')) as {
      importedArtifacts: Record<string, string>
      entries: unknown[]
    }
    expect(persisted.importedArtifacts).toEqual({})
    expect(persisted.entries).toEqual([])
  })

  it('serializes snapshot-to-reconcile so an older scan cannot restore a deleted task', async () => {
    const history = await historicalTask({ source: 'agent', target: '智能体' })
    const directory = await mkdtemp(join(tmpdir(), 'etch-global-glossary-race-'))
    directories.push(directory)
    const libraryPath = join(directory, 'glossary.json')
    const tasks = [history.indexed]
    const store = new TaskStore()
    const originalLoad = store.load.bind(store)
    let scanStarted!: () => void
    let releaseScan!: () => void
    const started = new Promise<void>((resolve) => { scanStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseScan = resolve })
    vi.spyOn(store, 'load').mockImplementationOnce(async (taskDirectory) => {
      scanStarted()
      await blocked
      return originalLoad(taskDirectory)
    })
    const service = new HistoricalGlossaryService(store, () => tasks, libraryPath)

    const staleScan = service.sync()
    await started
    tasks.splice(0)
    const deletionScan = service.sync()
    releaseScan()
    await Promise.all([staleScan, deletionScan])

    const persisted = JSON.parse(await readFile(libraryPath, 'utf8')) as {
      importedArtifacts: Record<string, string>
      entries: unknown[]
    }
    expect(persisted.importedArtifacts).toEqual({})
    expect(persisted.entries).toEqual([])
  })

  it('uses file identity to avoid rereading and rehashing unchanged cached artifacts', async () => {
    const history = await historicalTask({ source: 'agent', target: '智能体' })
    const probe = await open(join(history.directory, 'audit.json'), 'r')
    const readFileSpy = vi.spyOn(
      Object.getPrototypeOf(probe) as { readFile: typeof probe.readFile },
      'readFile'
    )
    await probe.close()
    const service = new HistoricalGlossaryService(new TaskStore(), () => [history.indexed])

    expect((await service.resolve(crypto.randomUUID(), 'An agent.', {})).entries).toHaveLength(1)
    const payloadReads = readFileSpy.mock.calls.length
    expect(payloadReads).toBe(2)
    expect((await service.resolve(crypto.randomUUID(), 'An agent.', {})).entries).toHaveLength(1)
    expect(readFileSpy).toHaveBeenCalledTimes(payloadReads)
  })

  it('rejects an in-directory symlink to an audit file outside the task root', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const history = await historicalTask({ source: 'agent', target: '智能体' })
    const externalDirectory = await mkdtemp(join(tmpdir(), 'etch-history-symlink-'))
    directories.push(externalDirectory)
    const externalPath = join(externalDirectory, 'audit.json')
    await writeFile(externalPath, await readFile(join(history.directory, 'audit.json')))
    await rm(join(history.directory, 'audit.json'))
    await symlink(externalPath, join(history.directory, 'audit.json'))
    const service = new HistoricalGlossaryService(new TaskStore(), () => [history.indexed])
    const snapshot = await service.resolve(crypto.randomUUID(), 'An agent.', {})
    expect(snapshot.entries).toEqual([])
    expect(console.warn).toHaveBeenCalledOnce()
  })
})
