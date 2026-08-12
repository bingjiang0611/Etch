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

// 文档任务的替代 session 必须跟当前选择对齐；字幕/总结仍沿用原 Provider，
// 避免在没有对应缓存失效策略时跨 Provider 复用产物。
function selectedInvocation(
  manifest: TaskManifest,
  previous: SessionGeneration
): { provider: ProviderId; model: ModelSelection } {
  const { selectedProvider, selectedModel } = manifest.translation
  return manifest.kind === 'document' && selectedProvider && selectedModel
    ? { provider: selectedProvider, model: selectedModel }
    : { provider: previous.provider, model: previous.model }
}

function modelSelectionMatches(left: ModelSelection, right: ModelSelection): boolean {
  if (left.source !== right.source) return false
  return left.source === 'cli-default'
    || (right.source !== 'cli-default' && left.modelId === right.modelId)
}

export function activeSessionGenerationDrifted(manifest: TaskManifest): boolean {
  const active = manifest.translation.sessionGenerations.find((item) =>
    item.id === manifest.translation.activeGenerationId && item.status === 'active'
  )
  const { selectedProvider, selectedModel } = manifest.translation
  return Boolean(active && selectedProvider && selectedModel
    && (active.provider !== selectedProvider || !modelSelectionMatches(active.model, selectedModel)))
}

export function replaceLostSessionGeneration(manifest: TaskManifest, taskDirectory: string): SessionGeneration {
  const previousId = manifest.translation.activeGenerationId
  const previous = manifest.translation.sessionGenerations.find((item) => item.id === previousId)
  if (!previous?.externalSessionId || previous.status !== 'active') {
    throw new Error('无法替换缺少 external session 的 active generation')
  }
  const { provider, model } = selectedInvocation(manifest, previous)
  const replacement = activateSessionGeneration(manifest, provider, model, taskDirectory, 'resume-replacement')
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
  const { provider, model } = selectedInvocation(manifest, previous)
  const replacement = activateSessionGeneration(manifest, provider, model, taskDirectory, 'resume-replacement')
  const contaminated = manifest.translation.sessionGenerations.find((item) => item.id === previousId)!
  contaminated.status = 'lost'
  return replacement
}
