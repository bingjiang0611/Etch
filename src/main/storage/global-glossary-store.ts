import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { sha256Text } from '../core/fingerprint'
import { normalizeGlossaryTerm } from '../../core/translation'
import { writeJsonAtomic } from './atomic-json'

const GlossarySourceSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  auditSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  producer: z.string(),
  manuallyEdited: z.boolean(),
  artifactMtimeMs: z.number().nonnegative(),
  manifestUpdatedAtMs: z.number(),
  entryIndex: z.number().int().nonnegative(),
  source: z.string().min(1).max(500),
  target: z.string().min(1).max(500),
  contextSamples: z.array(z.string().min(1).max(10_000)).max(5)
})

const GlossaryEntrySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.string().min(1).max(500),
  target: z.string().min(1).max(500),
  contextSamples: z.array(z.string().min(1).max(10_000)).max(5),
  sources: z.array(GlossarySourceSchema).min(1).max(100_000),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
})

const GlobalGlossarySchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  entries: z.array(GlossaryEntrySchema).max(100_000),
  importedArtifacts: z.record(z.string().uuid(), z.string().regex(/^[a-f0-9]{64}$/u)),
  deletedKeys: z.array(z.string().min(1).max(1001)).max(100_000)
})

export type StoredGlossarySource = z.infer<typeof GlossarySourceSchema>
export type StoredGlossaryEntry = z.infer<typeof GlossaryEntrySchema>
type GlobalGlossary = z.infer<typeof GlobalGlossarySchema>

export interface GlossaryTaskImport {
  taskId: string
  auditSha256: string
  entries: StoredGlossarySource[]
}

function emptyGlossary(): GlobalGlossary {
  return { schemaVersion: 1, revision: 0, entries: [], importedArtifacts: {}, deletedKeys: [] }
}

export function glossaryEntryKey(source: string, target: string): string {
  return `${normalizeGlossaryTerm(source)}\u0000${normalizeGlossaryTerm(target)}`
}

function sourceWins(next: StoredGlossarySource, current: StoredGlossarySource): boolean {
  if (next.manuallyEdited !== current.manuallyEdited) return next.manuallyEdited
  if (next.artifactMtimeMs !== current.artifactMtimeMs) return next.artifactMtimeMs > current.artifactMtimeMs
  if (next.manifestUpdatedAtMs !== current.manifestUpdatedAtMs) return next.manifestUpdatedAtMs > current.manifestUpdatedAtMs
  const taskOrder = next.taskId.localeCompare(current.taskId)
  if (taskOrder !== 0) return taskOrder < 0
  return next.entryIndex < current.entryIndex
}

export function winningGlossarySource(sources: readonly StoredGlossarySource[]): StoredGlossarySource {
  const winner = sources.reduce((current, candidate) => sourceWins(candidate, current) ? candidate : current)
  return winner
}

function combinedSamples(sources: readonly StoredGlossarySource[]): string[] {
  return [...new Set(sources.flatMap((source) => source.contextSamples))].slice(0, 5)
}

function entryFromSources(
  key: string,
  sources: StoredGlossarySource[],
  createdAt: string,
  updatedAt: string
): StoredGlossaryEntry {
  const winner = winningGlossarySource(sources)
  return GlossaryEntrySchema.parse({
    id: sha256Text(key),
    source: winner.source,
    target: winner.target,
    contextSamples: combinedSamples(sources),
    sources,
    createdAt,
    updatedAt
  })
}

export class GlobalGlossaryStore {
  #memory = emptyGlossary()
  #mutationQueue: Promise<void> = Promise.resolve()

  constructor(readonly path?: string) {}

  async load(): Promise<GlobalGlossary> {
    if (!this.path) return GlobalGlossarySchema.parse(this.#memory)
    try {
      return GlobalGlossarySchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return emptyGlossary()
    }
  }

  async reconcile(
    imports: readonly GlossaryTaskImport[],
    authoritativeTaskIds: ReadonlySet<string>
  ): Promise<GlobalGlossary> {
    return this.#mutate(async (current) => {
      const changedImports = imports.filter((item) => current.importedArtifacts[item.taskId] !== item.auditSha256)
      const removedTaskIds = new Set(
        Object.keys(current.importedArtifacts).filter((taskId) => !authoritativeTaskIds.has(taskId))
      )
      if (!changedImports.length && !removedTaskIds.size) return current
      const now = new Date().toISOString()
      const deleted = new Set(current.deletedKeys)
      const entries = new Map<string, StoredGlossaryEntry>()
      for (const entry of current.entries) {
        const sources = entry.sources.filter((source) => authoritativeTaskIds.has(source.taskId))
        if (!sources.length) continue
        const key = glossaryEntryKey(entry.source, entry.target)
        entries.set(key, sources.length === entry.sources.length
          ? entry
          : entryFromSources(key, sources, entry.createdAt, now))
      }
      const importedArtifacts = Object.fromEntries(
        Object.entries(current.importedArtifacts).filter(([taskId]) => authoritativeTaskIds.has(taskId))
      )

      for (const item of changedImports) {
        for (const [key, entry] of entries) {
          const sources = entry.sources.filter((source) => source.taskId !== item.taskId)
          if (!sources.length) entries.delete(key)
          else if (sources.length !== entry.sources.length) entries.set(key, entryFromSources(key, sources, entry.createdAt, now))
        }
        for (const imported of item.entries) {
          const key = glossaryEntryKey(imported.source, imported.target)
          if (deleted.has(key)) continue
          const existing = entries.get(key)
          const sources = [...(existing?.sources ?? []), imported]
          entries.set(key, entryFromSources(key, sources, existing?.createdAt ?? now, now))
        }
        importedArtifacts[item.taskId] = item.auditSha256
      }

      return GlobalGlossarySchema.parse({
        ...current,
        revision: current.revision + 1,
        importedArtifacts,
        entries: [...entries.values()].sort((left, right) => {
          const sourceOrder = normalizeGlossaryTerm(left.source).localeCompare(normalizeGlossaryTerm(right.source))
          return sourceOrder || normalizeGlossaryTerm(left.target).localeCompare(normalizeGlossaryTerm(right.target))
        })
      })
    })
  }

  async delete(entryId: string, expectedRevision: number): Promise<GlobalGlossary> {
    return this.#mutate(async (current) => {
      if (current.revision !== expectedRevision) throw new Error('术语库已更新，请刷新后重试')
      const entry = current.entries.find((candidate) => candidate.id === entryId)
      if (!entry) throw new Error('术语不存在或已被删除')
      const key = glossaryEntryKey(entry.source, entry.target)
      return GlobalGlossarySchema.parse({
        ...current,
        revision: current.revision + 1,
        entries: current.entries.filter((candidate) => candidate.id !== entryId),
        deletedKeys: [...new Set([...current.deletedKeys, key])].sort()
      })
    })
  }

  async #mutate(operation: (current: GlobalGlossary) => Promise<GlobalGlossary>): Promise<GlobalGlossary> {
    const queued = this.#mutationQueue.then(async () => {
      const current = await this.load()
      const next = await operation(current)
      if (next === current) return current
      if (this.path) await writeJsonAtomic(this.path, next)
      else this.#memory = next
      return next
    })
    this.#mutationQueue = queued.then(() => undefined, () => undefined)
    return queued
  }
}
