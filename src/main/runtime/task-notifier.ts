import type { AppSettings } from '../../shared/settings-schema'
import { STAGE_IDS, lastStageForKind, type TaskManifest } from '../../shared/task-schema'

type NotificationKind = keyof AppSettings['notifications']
type TaskSignals = Record<NotificationKind, string | undefined>

export interface TaskNotificationAdapter {
  isWindowActive(): boolean
  show(title: string, body: string, onClick: () => void): void
  focusWindow(): void
}

export class TaskNotifier {
  readonly #previous = new Map<string, TaskSignals>()

  constructor(
    readonly settings: () => AppSettings['notifications'],
    readonly adapter: TaskNotificationAdapter
  ) {}

  prime(manifests: readonly TaskManifest[]): void {
    for (const manifest of manifests) this.#previous.set(manifest.taskId, signals(manifest))
  }

  observe(manifest: TaskManifest): void {
    const next = signals(manifest)
    const previous = this.#previous.get(manifest.taskId)
    this.#previous.set(manifest.taskId, next)
    if (!previous || this.adapter.isWindowActive()) return

    for (const kind of ['completion', 'failure', 'checkpoint'] as const) {
      if (!next[kind] || next[kind] === previous[kind] || !this.settings()[kind]) continue
      this.adapter.show(manifest.title, notificationBody(kind, manifest), () => this.adapter.focusWindow())
    }
  }

  forget(taskId: string): void {
    this.#previous.delete(taskId)
  }
}

function signals(manifest: TaskManifest): TaskSignals {
  const failedStage = STAGE_IDS.find((stage) => manifest.pipeline.stages[stage]?.status === 'failed')
  const checkpointStage = STAGE_IDS.find((stage) => manifest.pipeline.stages[stage]?.status === 'checkpoint')
  const finalStage = lastStageForKind(manifest.kind)
  return {
    completion: manifest.pipeline.stages[finalStage]?.status === 'completed'
      ? `${finalStage}:${manifest.runtime.completedAt ?? manifest.revision}`
      : undefined,
    failure: failedStage
      ? `${failedStage}:${manifest.pipeline.stages[failedStage].attempt}:${manifest.pipeline.stages[failedStage].errorCode ?? ''}`
      : undefined,
    checkpoint: checkpointStage
      ? `${checkpointStage}:${manifest.pipeline.stages[checkpointStage].checkpointId ?? ''}`
      : undefined
  }
}

function notificationBody(kind: NotificationKind, manifest: TaskManifest): string {
  if (kind === 'completion') {
    if (manifest.kind === 'document') return '网页翻译已完成'
    if (manifest.kind === 'summary') return '视频总结已完成'
    return '成片处理已完成'
  }
  if (kind === 'failure') return '任务处理失败，请打开 Etch 查看详情'
  return '任务正在等待你的确认'
}
