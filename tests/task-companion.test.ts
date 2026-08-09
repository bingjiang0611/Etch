import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCompanionManifest } from '../src/main/task-companion'
import { SHARED_STAGE_IDS, createTaskManifest, type TaskKind, type TaskManifest } from '../src/shared/task-schema'

const directories: string[] = []
const artifactNames = ['source', 'metadata', 'probe', 'english', 'englishClean', 'englishCues', 'sourceLog', 'thumbnail'] as const

afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function completedSharedTask(kind: TaskKind): Promise<{ directory: string; manifest: TaskManifest }> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-companion-source-'))
  directories.push(directory)
  const manifest = createTaskManifest(
    { kind: 'url', url: 'https://example.com/video' },
    '同一条视频',
    'codex',
    '原任务要求',
    'large',
    false,
    kind,
    'agents'
  )
  for (const [index, key] of artifactNames.entries()) {
    const relativePath = `artifacts/shared/${key}.${key === 'source' ? 'mp4' : 'txt'}`
    const bytes = Buffer.from(`${key}-${index}`)
    await mkdir(dirname(join(directory, relativePath)), { recursive: true })
    await writeFile(join(directory, relativePath), bytes)
    manifest.artifacts[key] = {
      relativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      valid: true,
      producer: `test-${key}`,
      inputFingerprint: 'a'.repeat(64)
    }
  }
  for (const stage of SHARED_STAGE_IDS) manifest.pipeline.stages[stage] = { status: 'completed', attempt: 1 }
  manifest.runtime = {
    currentMessage: '共享底稿已完成',
    userPaused: false,
    videoId: 'video-id',
    uploadDate: '2026-08-09',
    durationSeconds: 123,
    width: 1920,
    height: 1080,
    subtitleKind: 'manual'
  }
  return { directory, manifest }
}

describe('追加成果共享底稿', () => {
  it.each([
    ['subtitle', 'summary', 'digest'],
    ['summary', 'subtitle', 'translate']
  ] as const)('从 %s 追加 %s，只复用共享阶段并准备目标首阶段', async (sourceKind, targetKind, firstStage) => {
    const source = await completedSharedTask(sourceKind)
    const targetDirectory = await mkdtemp(join(tmpdir(), 'etch-companion-target-'))
    directories.push(targetDirectory)

    const target = await createCompanionManifest(source.directory, targetDirectory, source.manifest, {
      provider: 'qoder',
      styleNote: '新成果要求'
    })

    expect(target.kind).toBe(targetKind)
    expect(target.lineage).toEqual({
      rootTaskId: source.manifest.taskId,
      reusedFromTaskId: source.manifest.taskId
    })
    expect(target.category).toBe('agents')
    expect(target.render.subtitlePreset).toBe('large')
    expect(target.translation).toMatchObject({ selectedProvider: 'qoder', styleNote: '新成果要求' })
    expect(target.runtime).toMatchObject({ videoId: 'video-id', width: 1920, height: 1080, subtitleKind: 'manual' })
    expect(target.pipeline.stages[firstStage].status).toBe('ready')
    for (const stage of SHARED_STAGE_IDS) expect(target.pipeline.stages[stage].status).toBe('completed')

    const sourceArtifact = source.manifest.artifacts.source
    const targetArtifact = target.artifacts.source
    expect(await readFile(join(targetDirectory, targetArtifact.relativePath), 'utf8')).toBe('source-0')
    expect((await stat(join(targetDirectory, targetArtifact.relativePath))).ino).toBe((await stat(join(source.directory, sourceArtifact.relativePath))).ino)
    expect(source.manifest.lineage).toEqual({ rootTaskId: source.manifest.taskId })
  })

  it('共享阶段未完成时拒绝追加，不制造半成品目录', async () => {
    const source = await completedSharedTask('subtitle')
    source.manifest.pipeline.stages.cues.status = 'checkpoint'
    const targetDirectory = join(tmpdir(), `etch-companion-not-created-${crypto.randomUUID()}`)

    await expect(createCompanionManifest(source.directory, targetDirectory, source.manifest, { provider: 'codex' }))
      .rejects.toThrow('完成“cues”后才能追加成果')
    await expect(stat(targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('产物哈希与 manifest 不一致时拒绝复用', async () => {
    const source = await completedSharedTask('summary')
    const targetDirectory = await mkdtemp(join(tmpdir(), 'etch-companion-corrupt-'))
    directories.push(targetDirectory)
    await writeFile(join(source.directory, source.manifest.artifacts.englishCues.relativePath), 'tampered')

    await expect(createCompanionManifest(source.directory, targetDirectory, source.manifest, { provider: 'claude' }))
      .rejects.toThrow(/大小不匹配|SHA-256 不匹配/u)
  })
})
