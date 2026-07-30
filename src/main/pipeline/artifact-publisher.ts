import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { StageId } from '../../shared/task-schema'

const ARTIFACT_ROOT = '.etch-artifacts'
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export function artifactRunRelativeDirectory(stage: StageId, runId: string): string {
  if (!SAFE_NAME.test(runId)) throw new Error('artifact run ID 非法')
  return join(ARTIFACT_ROOT, stage, runId)
}

export function artifactCandidateRelativePath(stage: StageId, runId: string, logicalName: string): string {
  if (!SAFE_NAME.test(logicalName)) throw new Error(`artifact 文件名非法：${logicalName}`)
  return join(artifactRunRelativeDirectory(stage, runId), logicalName)
}

export async function ensureArtifactRunDirectory(
  taskDirectory: string,
  stage: StageId,
  runId: string
): Promise<string> {
  const directory = join(taskDirectory, artifactRunRelativeDirectory(stage, runId))
  await mkdir(directory, { recursive: true })
  return directory
}

export async function cleanupArtifactRun(
  taskDirectory: string,
  stage: StageId,
  runId: string
): Promise<void> {
  await rm(join(taskDirectory, artifactRunRelativeDirectory(stage, runId)), { recursive: true, force: true })
}
