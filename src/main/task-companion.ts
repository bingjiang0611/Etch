import { constants as fsConstants } from 'node:fs'
import { copyFile, link, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  SHARED_STAGE_IDS,
  createTaskManifest,
  type ModelSelection,
  type ProviderId,
  type TaskKind,
  type TaskManifest
} from '../shared/task-schema'
import { sha256ContainedFile } from './storage/safe-artifact'

const REQUIRED_SHARED_ARTIFACTS = ['source', 'metadata', 'probe', 'english', 'englishClean', 'englishCues'] as const
const SHARED_ARTIFACTS = [
  ...REQUIRED_SHARED_ARTIFACTS,
  'sourceLog',
  'thumbnail',
  'whisperLog',
  'englishSourceAudit'
] as const

export interface CompanionTaskOptions {
  provider: ProviderId
  styleNote?: string
  autoPublish?: boolean
  model?: ModelSelection
  targetTaskId?: string
}

function oppositeKind(kind: Exclude<TaskKind, 'document'>): Exclude<TaskKind, 'document'> {
  return kind === 'subtitle' ? 'summary' : 'subtitle'
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

async function reuseFile(sourceDirectory: string, targetDirectory: string, relativePath: string): Promise<void> {
  const sourcePath = join(sourceDirectory, relativePath)
  const targetPath = join(targetDirectory, relativePath)
  await mkdir(dirname(targetPath), { recursive: true })
  try {
    await link(sourcePath, targetPath)
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '')) throw error
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE)
  }
}

export async function createCompanionManifest(
  sourceDirectory: string,
  targetDirectory: string,
  source: TaskManifest,
  options: CompanionTaskOptions
): Promise<TaskManifest> {
  if (source.kind === 'document') throw new Error('网页翻译任务不支持追加视频成果')
  for (const stage of SHARED_STAGE_IDS) {
    if (source.pipeline.stages[stage]?.status !== 'completed') {
      throw new Error(`完成“${stage}”后才能追加成果`)
    }
  }
  for (const key of REQUIRED_SHARED_ARTIFACTS) {
    if (!source.artifacts[key]?.valid) throw new Error(`共享产物 ${key} 不可用`)
  }

  const targetKind = oppositeKind(source.kind)
  const target = createTaskManifest(
    source.input,
    source.title,
    options.provider,
    options.styleNote ?? '',
    source.render.subtitlePreset,
    options.autoPublish ?? false,
    targetKind,
    source.category,
    'auto',
    'normal',
    'general',
    'storytelling',
    options.model ?? { source: 'cli-default' }
  )
  if (options.targetTaskId) target.taskId = options.targetTaskId
  target.lineage = {
    rootTaskId: source.lineage.rootTaskId,
    reusedFromTaskId: source.taskId
  }

  await mkdir(targetDirectory, { recursive: true })
  const reusedPaths = new Set<string>()
  for (const key of SHARED_ARTIFACTS) {
    const artifact = source.artifacts[key]
    if (!artifact?.valid) continue
    await sha256ContainedFile(sourceDirectory, artifact.relativePath, `共享产物 ${key}`, {
      expectedSize: artifact.size,
      expectedSha256: artifact.sha256
    })
    if (!reusedPaths.has(artifact.relativePath)) {
      await reuseFile(sourceDirectory, targetDirectory, artifact.relativePath)
      reusedPaths.add(artifact.relativePath)
    }
    await sha256ContainedFile(targetDirectory, artifact.relativePath, `复用产物 ${key}`, {
      expectedSize: artifact.size,
      expectedSha256: artifact.sha256
    })
    target.artifacts[key] = structuredClone(artifact)
  }

  for (const stage of SHARED_STAGE_IDS) {
    target.pipeline.stages[stage] = structuredClone(source.pipeline.stages[stage])
    target.pipeline.stages[stage].status = 'completed'
    delete target.pipeline.stages[stage].errorCode
    delete target.pipeline.stages[stage].checkpointId
    delete target.pipeline.stages[stage].activeLease
  }
  const firstOutputStage = targetKind === 'subtitle' ? 'translate' : 'digest'
  target.pipeline.stages[firstOutputStage].status = 'ready'

  const { videoId, uploadDate, durationSeconds, width, height, subtitleKind } = source.runtime
  Object.assign(target.runtime, { videoId, uploadDate, durationSeconds, width, height, subtitleKind })
  target.video.sourcePlatform = source.video.sourcePlatform
  target.video.decisions = structuredClone(source.video.decisions)
  target.runtime.currentMessage = targetKind === 'subtitle' ? '已复用英文底稿，等待翻译' : '已复用英文底稿，等待素材分析'
  return target
}
