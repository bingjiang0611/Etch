import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ModelSelection, ProviderId, SessionGeneration, TaskManifest } from '../../shared/task-schema'

export type GenerationReason = SessionGeneration['reason']

export function activateSessionGeneration(
  manifest: TaskManifest,
  provider: ProviderId,
  model: ModelSelection,
  taskDirectory: string,
  reason: GenerationReason
): SessionGeneration {
  const now = new Date().toISOString()
  const active = manifest.translation.sessionGenerations.find((item) => item.id === manifest.translation.activeGenerationId)
  if (active) {
    active.status = 'closed'
    active.closedAt = now
  }
  const id = randomUUID()
  const generation: SessionGeneration = {
    id,
    provider,
    model,
    stateRoot: join(taskDirectory, 'agent-workspace', 'provider-state', provider, id),
    status: 'active',
    reason,
    createdAt: now
  }
  manifest.translation.sessionGenerations.push(generation)
  manifest.translation.activeGenerationId = id
  return generation
}

export function replaceLostSessionGeneration(manifest: TaskManifest, taskDirectory: string): SessionGeneration {
  const previousId = manifest.translation.activeGenerationId
  const previous = manifest.translation.sessionGenerations.find((item) => item.id === previousId)
  if (!previous?.externalSessionId || previous.status !== 'active') {
    throw new Error('无法替换缺少 external session 的 active generation')
  }
  const replacement = activateSessionGeneration(manifest, previous.provider, previous.model, taskDirectory, 'resume-replacement')
  const lost = manifest.translation.sessionGenerations.find((item) => item.id === previousId)!
  lost.status = 'lost'
  return replacement
}

export function replaceContaminatedSessionGeneration(manifest: TaskManifest, taskDirectory: string): SessionGeneration {
  const previousId = manifest.translation.activeGenerationId
  const previous = manifest.translation.sessionGenerations.find((item) => item.id === previousId)
  if (!previous || previous.status !== 'active') {
    throw new Error('无法替换缺少 active generation 的污染 session')
  }
  const replacement = activateSessionGeneration(manifest, previous.provider, previous.model, taskDirectory, 'resume-replacement')
  const contaminated = manifest.translation.sessionGenerations.find((item) => item.id === previousId)!
  contaminated.status = 'lost'
  return replacement
}
