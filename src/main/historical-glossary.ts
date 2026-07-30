import {
  AuditResultSchema,
  TranslationGlossarySnapshotSchema,
  glossarySourceAppears,
  glossarySourceAppearsExactly,
  glossarySourceVariants,
  normalizeGlossaryTerm,
  settingsGlossaryEntries,
  type TranslationGlossaryEntry,
  type TranslationGlossarySnapshot
} from '../core/translation'
import { flattenCue, parseSrt } from '../core/srt'
import { STAGE_IDS, type TaskManifest } from '../shared/task-schema'
import type { IndexedTask } from './storage/index-store'
import {
  inspectContainedFile,
  readContainedFile,
  type ContainedFileIdentity
} from './storage/safe-artifact'
import {
  GlobalGlossaryStore,
  winningGlossarySource,
  type GlossaryTaskImport,
  type StoredGlossaryEntry,
  type StoredGlossarySource
} from './storage/global-glossary-store'
import type { TaskStore } from './storage/task-store'

const MAX_AUDIT_BYTES = 5 * 1024 * 1024

interface HistoricalCandidate extends TranslationGlossaryEntry {
  sourceTaskId: string
  sourceTitle: string
  sourceAuditSha256: string
  sourceProducer: string
  contextSamples: string[]
  manuallyEdited: boolean
  artifactMtimeMs: number
  manifestUpdatedAtMs: number
  entryIndex: number
  aliasIndex: number
}

interface CachedAudit {
  key: string
  auditIdentity: ContainedFileIdentity
  englishIdentity: ContainedFileIdentity
  entries: HistoricalCandidate[]
}

interface SynchronizedGlossary {
  revision: number
  entries: StoredGlossaryEntry[]
  candidateTasks: number
  validArtifacts: number
  skippedArtifacts: number
}

function candidateWins(next: HistoricalCandidate, current: HistoricalCandidate): boolean {
  if (next.manuallyEdited !== current.manuallyEdited) return next.manuallyEdited
  if (next.artifactMtimeMs !== current.artifactMtimeMs) return next.artifactMtimeMs > current.artifactMtimeMs
  if (next.manifestUpdatedAtMs !== current.manifestUpdatedAtMs) return next.manifestUpdatedAtMs > current.manifestUpdatedAtMs
  const taskOrder = next.sourceTaskId.localeCompare(current.sourceTaskId)
  if (taskOrder !== 0) return taskOrder < 0
  if (next.entryIndex !== current.entryIndex) return next.entryIndex < current.entryIndex
  return next.aliasIndex < current.aliasIndex
}

function candidateOrder(left: HistoricalCandidate, right: HistoricalCandidate): number {
  if (candidateWins(left, right)) return -1
  if (candidateWins(right, left)) return 1
  return 0
}

function combinedSamples(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].slice(0, 5)
}

function sameIdentity(left: ContainedFileIdentity, right: ContainedFileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function identityOnly(file: ContainedFileIdentity): ContainedFileIdentity {
  const { device, inode, size, mtimeNs, ctimeNs } = file
  return { device, inode, size, mtimeNs, ctimeNs }
}

function candidateProvenance(candidate: HistoricalCandidate): string {
  return JSON.stringify([
    candidate.sourceTaskId,
    candidate.sourceAuditSha256,
    candidate.entryIndex,
    normalizeGlossaryTerm(candidate.target)
  ])
}

export class HistoricalGlossaryService {
  readonly #cache = new Map<string, CachedAudit>()
  readonly #library: GlobalGlossaryStore
  #synchronizationTail: Promise<void> = Promise.resolve()

  constructor(
    readonly store: TaskStore,
    readonly listTasks: () => readonly IndexedTask[],
    libraryPath?: string
  ) {
    this.#library = new GlobalGlossaryStore(libraryPath)
  }

  async resolve(
    currentTaskId: string,
    englishText: string,
    globalGlossary: Readonly<Record<string, string>>
  ): Promise<TranslationGlossarySnapshot> {
    const synchronized = await this.#synchronize()
    const selected = new Map<string, HistoricalCandidate>()

    for (const entry of synchronized.entries) {
      const sources = entry.sources.filter((source) => source.taskId !== currentTaskId)
      if (!sources.length) continue
      const winner = winningGlossarySource(sources)
      const contextSamples = [...new Set(sources.flatMap((source) => source.contextSamples))].slice(0, 5)
      for (const [aliasIndex, source] of glossarySourceVariants(winner.source).entries()) {
        const candidate: HistoricalCandidate = {
          source,
          target: winner.target,
          authority: 'historical',
          contextSamples,
          sourceTaskId: winner.taskId,
          sourceTitle: winner.title,
          sourceAuditSha256: winner.auditSha256,
          sourceProducer: winner.producer,
          manuallyEdited: winner.manuallyEdited,
          artifactMtimeMs: winner.artifactMtimeMs,
          manifestUpdatedAtMs: winner.manifestUpdatedAtMs,
          entryIndex: winner.entryIndex,
          aliasIndex
        }
        const key = `${normalizeGlossaryTerm(candidate.source)}\u0000${normalizeGlossaryTerm(candidate.target)}`
        const current = selected.get(key)
        if (!current) selected.set(key, candidate)
        else {
          const preferred = candidateWins(candidate, current) ? candidate : current
          selected.set(key, { ...preferred, contextSamples: combinedSamples(current.contextSamples, candidate.contextSamples) })
        }
      }
    }

    const candidates = [...selected.values()]
    const exactProvenance = new Set(candidates
      .filter((entry) => glossarySourceAppearsExactly(englishText, entry.source))
      .map(candidateProvenance))
    const relevantHistory = candidates.filter((entry) =>
      glossarySourceAppearsExactly(englishText, entry.source)
      || (!exactProvenance.has(candidateProvenance(entry)) && glossarySourceAppears(englishText, entry.source))
    )
    const historicalSources = new Set(relevantHistory.map((entry) => normalizeGlossaryTerm(entry.source)))
    const settings = settingsGlossaryEntries(globalGlossary)
      .filter((entry) => !historicalSources.has(normalizeGlossaryTerm(entry.source)))
    const entries = [...relevantHistory, ...settings].sort((left, right) => {
      const sourceOrder = normalizeGlossaryTerm(left.source).localeCompare(normalizeGlossaryTerm(right.source))
      if (sourceOrder) return sourceOrder
      if (left.authority !== right.authority) return left.authority === 'historical' ? -1 : 1
      if (left.authority === 'historical' && right.authority === 'historical') {
        return candidateOrder(left as HistoricalCandidate, right as HistoricalCandidate)
      }
      return normalizeGlossaryTerm(left.target).localeCompare(normalizeGlossaryTerm(right.target))
    })
    const historicalEntries = entries.filter((entry) => entry.authority === 'historical').length
    const settingsEntries = entries.length - historicalEntries
    const snapshot = TranslationGlossarySnapshotSchema.parse({
      schemaVersion: 1,
      currentTaskId,
      mode: 'resolved',
      stats: {
        candidateTasks: synchronized.candidateTasks,
        validArtifacts: synchronized.validArtifacts,
        skippedArtifacts: synchronized.skippedArtifacts,
        historicalEntries,
        settingsEntries
      },
      entries
    })
    console.info('historical glossary resolved', { currentTaskId, ...snapshot.stats })
    return snapshot
  }

  async sync(): Promise<void> {
    await this.#synchronize()
  }

  async libraryPage(query: string, offset: number, limit: number): Promise<{
    revision: number
    query: string
    offset: number
    total: number
    items: Array<{
      id: string
      source: string
      target: string
      sourceCount: number
      sourceTitles: string[]
      updatedAt: string
    }>
  }> {
    const library = await this.#synchronize()
    const normalizedQuery = normalizeGlossaryTerm(query)
    const matching = library.entries.filter((entry) => {
      if (!normalizedQuery) return true
      return [
        entry.source,
        entry.target,
        ...entry.sources.map((source) => source.title)
      ].some((value) => normalizeGlossaryTerm(value).includes(normalizedQuery))
    })
    return {
      revision: library.revision,
      query,
      offset,
      total: matching.length,
      items: matching.slice(offset, offset + limit).map((entry) => ({
        id: entry.id,
        source: entry.source,
        target: entry.target,
        sourceCount: new Set(entry.sources.map((source) => source.taskId)).size,
        sourceTitles: [...new Set(entry.sources.map((source) => source.title))].slice(0, 5),
        updatedAt: entry.updatedAt
      }))
    }
  }

  async deleteEntry(entryId: string, expectedRevision: number): Promise<number> {
    return (await this.#library.delete(entryId, expectedRevision)).revision
  }

  async #synchronize(): Promise<SynchronizedGlossary> {
    const previous = this.#synchronizationTail
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    this.#synchronizationTail = previous.then(() => gate)
    await previous
    try {
      return await this.#synchronizeCurrent()
    } finally {
      release()
    }
  }

  async #synchronizeCurrent(): Promise<SynchronizedGlossary> {
    const tasks = this.listTasks().filter((task) => task.status === 'completed')
    const currentTaskIds = new Set(tasks.map((task) => task.taskId))
    for (const taskId of this.#cache.keys()) if (!currentTaskIds.has(taskId)) this.#cache.delete(taskId)
    const imports: GlossaryTaskImport[] = []
    let validArtifacts = 0
    let skippedArtifacts = 0

    for (const task of tasks) {
      try {
        const manifest = await this.store.load(task.location)
        if (manifest.taskId !== task.taskId) throw new Error(`索引 taskId 与 task.json 不一致：${task.taskId}/${manifest.taskId}`)
        const entries = await this.#loadCandidates(task.location, manifest)
        const auditSha256 = manifest.artifacts.audit?.sha256
        if (!entries || !auditSha256) {
          skippedArtifacts += 1
          continue
        }
        validArtifacts += 1
        imports.push({
          taskId: task.taskId,
          auditSha256,
          entries: entries.filter((candidate) => candidate.aliasIndex === 0).map((candidate): StoredGlossarySource => ({
            taskId: candidate.sourceTaskId,
            title: candidate.sourceTitle,
            auditSha256: candidate.sourceAuditSha256,
            producer: candidate.sourceProducer,
            manuallyEdited: candidate.manuallyEdited,
            artifactMtimeMs: candidate.artifactMtimeMs,
            manifestUpdatedAtMs: candidate.manifestUpdatedAtMs,
            entryIndex: candidate.entryIndex,
            source: candidate.source,
            target: candidate.target,
            contextSamples: candidate.contextSamples
          }))
        })
      } catch (error) {
        skippedArtifacts += 1
        console.warn('historical glossary artifact skipped', {
          taskId: task.taskId,
          location: task.location,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }

    const library = await this.#library.reconcile(imports, currentTaskIds)
    return {
      revision: library.revision,
      entries: library.entries,
      candidateTasks: tasks.length,
      validArtifacts,
      skippedArtifacts
    }
  }

  async #loadCandidates(taskDirectory: string, manifest: TaskManifest): Promise<HistoricalCandidate[] | undefined> {
    const delivered = STAGE_IDS.every((stage) => ['completed', 'skipped'].includes(manifest.pipeline.stages[stage]?.status))
    const reviewed = manifest.pipeline.stages.review?.status === 'completed'
    const verified = manifest.pipeline.stages.verify?.status === 'completed'
    if (!delivered || !reviewed || !verified || manifest.pipeline.stages.audit?.status !== 'completed' || manifest.translation.auditCheckpoint) return undefined
    const artifact = manifest.artifacts.audit
    const englishArtifact = manifest.artifacts.englishClean
    if (!artifact?.valid || !englishArtifact?.valid) return undefined
    const [auditIdentity, englishIdentity] = await Promise.all([
      inspectContainedFile(taskDirectory, artifact.relativePath, '审计术语表', {
        maxBytes: MAX_AUDIT_BYTES,
        expectedSize: artifact.size
      }),
      inspectContainedFile(taskDirectory, englishArtifact.relativePath, '历史英文字幕', {
        maxBytes: MAX_AUDIT_BYTES,
        expectedSize: englishArtifact.size
      })
    ])
    const key = JSON.stringify([
      manifest.taskId,
      manifest.revision,
      manifest.updatedAt,
      artifact.relativePath,
      artifact.sha256,
      artifact.producer,
      englishArtifact.relativePath,
      englishArtifact.sha256,
      englishArtifact.producer
    ])
    const cached = this.#cache.get(manifest.taskId)
    if (
      cached?.key === key
      && sameIdentity(cached.auditIdentity, auditIdentity)
      && sameIdentity(cached.englishIdentity, englishIdentity)
    ) return cached.entries
    const [auditFile, englishFile] = await Promise.all([
      readContainedFile(taskDirectory, artifact.relativePath, '审计术语表', {
        maxBytes: MAX_AUDIT_BYTES,
        expectedSize: artifact.size,
        expectedSha256: artifact.sha256
      }),
      readContainedFile(taskDirectory, englishArtifact.relativePath, '历史英文字幕', {
        maxBytes: MAX_AUDIT_BYTES,
        expectedSize: englishArtifact.size,
        expectedSha256: englishArtifact.sha256
      })
    ])
    const [auditBytes, englishBytes] = [auditFile.bytes, englishFile.bytes]
    const audit = AuditResultSchema.parse(JSON.parse(auditBytes.toString('utf8')))
    const english = parseSrt(englishBytes.toString('utf8'))
    const englishById = new Map(english.map((cue) => [Number(cue.id), flattenCue(cue)]))
    const manuallyEdited = artifact.producer === 'user-glossary-edit'
    const manifestUpdatedAtMs = Date.parse(manifest.updatedAt)
    const entries = audit.glossary.flatMap((entry, entryIndex) => {
      if (!entry.cueIds.length) return []
      const contextSamples = [...new Set(entry.cueIds.map((cueId) => {
        const context = englishById.get(cueId)
        if (!context) throw new Error(`审计术语 ${entry.source} 引用了不存在的历史 cue：${cueId}`)
        return context
      }))].slice(0, 5)
      return glossarySourceVariants(entry.source).map((source, aliasIndex) => ({
        source,
        target: entry.target,
        authority: 'historical' as const,
        contextSamples,
        sourceTaskId: manifest.taskId,
        sourceTitle: manifest.title,
        sourceAuditSha256: artifact.sha256,
        sourceProducer: artifact.producer,
        manuallyEdited,
        artifactMtimeMs: auditFile.mtimeMs,
        manifestUpdatedAtMs,
        entryIndex,
        aliasIndex
      }))
    })
    this.#cache.set(manifest.taskId, {
      key,
      auditIdentity: identityOnly(auditFile),
      englishIdentity: identityOnly(englishFile),
      entries
    })
    return entries
  }
}
