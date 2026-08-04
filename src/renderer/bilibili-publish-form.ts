import { renderBilibiliDescription, truncateBilibiliTitle, type BilibiliCopyright, type BilibiliPartition, type BilibiliPublicationDraft } from '../shared/bilibili'
import type { TaskDetail } from '../shared/ipc'
import type { AppSettings } from '../shared/settings-schema'
import { saveBilibiliPublishPreferences, type BilibiliPublishPreferences, type BilibiliPublishPreferencesStorageAccess } from './bilibili-publish-preferences'

export interface BilibiliPublishFormState {
  title: string
  tid: string
  tags: string
  description: string
  copyright: BilibiliCopyright
  source: string
  coverRelativePath?: string
  coverDataUrl?: string
}

export function initialBilibiliPublishForm(task: TaskDetail, settings: AppSettings, preferences?: BilibiliPublishPreferences): BilibiliPublishFormState {
  const existing = task.manifest.publication.draft
  if (existing) {
    return {
      title: existing.title,
      tid: String(existing.tid),
      tags: existing.tags.join(', '),
      description: existing.description,
      copyright: existing.copyright,
      source: existing.source,
      coverRelativePath: existing.coverRelativePath
    }
  }
  const source = task.manifest.input.kind === 'url' ? task.manifest.input.url : ''
  const template = settings.bilibiliPublishTemplate
  return {
    title: truncateBilibiliTitle(task.manifest.title),
    tid: preferences ? String(preferences.tid) : template.tid ? String(template.tid) : '',
    tags: (preferences?.tags ?? template.tags).join(', '),
    description: renderBilibiliDescription(template.descriptionTemplate, task.manifest.title, source),
    copyright: preferences?.copyright ?? (task.manifest.input.kind === 'url' ? 'repost' : 'original'),
    source,
    coverRelativePath: task.manifest.artifacts.thumbnail?.valid ? task.manifest.artifacts.thumbnail.relativePath : undefined
  }
}

export function reconcileBilibiliPartitionTid(
  tid: string,
  partitions: readonly BilibiliPartition[],
  templateTid?: number,
  hasTaskDraft = false
): string {
  if (partitions.some((partition) => partition.tid === Number(tid))) return tid
  if (hasTaskDraft && tid) return ''
  if (templateTid && partitions.some((partition) => partition.tid === templateTid)) return String(templateTid)
  return partitions[0] ? String(partitions[0].tid) : ''
}

export async function publishBilibiliDraftAndRemember(
  publish: (taskId: string, draft: BilibiliPublicationDraft) => Promise<TaskDetail>,
  storage: BilibiliPublishPreferencesStorageAccess,
  taskId: string,
  draft: BilibiliPublicationDraft
): Promise<TaskDetail> {
  const detail = await publish(taskId, draft)
  saveBilibiliPublishPreferences(storage, {
    tid: draft.tid,
    tags: draft.tags,
    copyright: draft.copyright
  })
  return detail
}
