import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskManifest } from '../src/shared/task-schema'
import { parseSrt } from '../src/core/srt'
import { sha256File } from '../src/main/core/fingerprint'
import { TaskStore } from '../src/main/storage/task-store'
import { TaskReviewService } from '../src/main/task-review'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function reviewTask(): Promise<{ directory: string; store: TaskStore; review: TaskReviewService }> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-review-'))
  directories.push(directory)
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/review' }, '', 'codex')
  for (const stage of Object.values(manifest.pipeline.stages)) stage.status = 'completed'
  await writeFile(join(directory, 'english.clean.srt'), '1\n00:00:00,000 --> 00:00:02,000\nHello.\n\n2\n00:00:02,000 --> 00:00:04,000\nWorld Cup.\n')
  await writeFile(join(directory, 'zh_cues.tsv'), '1\t你好。\n2\t世界杯。\n')
  await writeFile(join(directory, 'audit.json'), `${JSON.stringify({ glossary: [{ source: 'World Cup', target: '世界杯', cueIds: [2] }], patches: [], resolutions: [{ cueId: 2, translation: '世界杯' }] })}\n`)
  const realArtifact = async (relativePath: string) => {
    const info = await stat(join(directory, relativePath))
    return { relativePath, sha256: await sha256File(join(directory, relativePath)), size: info.size, valid: true, producer: 'fixture', inputFingerprint: '1'.repeat(64) }
  }
  const placeholderArtifact = (relativePath: string) => ({ relativePath, sha256: '0'.repeat(64), size: 1, valid: true, producer: 'fixture', inputFingerprint: '1'.repeat(64) })
  manifest.artifacts.englishClean = await realArtifact('english.clean.srt')
  manifest.artifacts.chineseCues = await realArtifact('zh_cues.tsv')
  manifest.artifacts.audit = await realArtifact('audit.json')
  manifest.artifacts.bilingual = placeholderArtifact('bilingual.srt')
  manifest.artifacts.final = placeholderArtifact('final.mp4')
  manifest.artifacts.burnLog = placeholderArtifact('burn.log')
  manifest.artifacts.verification = placeholderArtifact('verification.json')
  manifest.runtime.finalRelativePath = 'final.mp4'
  manifest.runtime.completedAt = new Date().toISOString()
  const store = new TaskStore()
  await store.create(directory, manifest)
  return { directory, store, review: new TaskReviewService(store, () => false, () => undefined) }
}

async function enterManualReview(
  task: Awaited<ReturnType<typeof reviewTask>>,
  chinese: string,
  glossary: Array<{ source: string; target: string; cueIds: number[] }>
) {
  await writeFile(join(task.directory, 'zh_cues.tsv'), chinese)
  await writeFile(join(task.directory, 'audit.json'), `${JSON.stringify({ glossary, patches: [] })}\n`)
  const chineseInfo = await stat(join(task.directory, 'zh_cues.tsv'))
  const auditInfo = await stat(join(task.directory, 'audit.json'))
  const chineseSha256 = await sha256File(join(task.directory, 'zh_cues.tsv'))
  const auditSha256 = await sha256File(join(task.directory, 'audit.json'))
  const before = await task.store.load(task.directory)
  return task.store.mutate(task.directory, (manifest) => {
    manifest.artifacts.chineseCues = {
      ...manifest.artifacts.chineseCues!,
      sha256: chineseSha256,
      size: chineseInfo.size
    }
    manifest.artifacts.audit = {
      ...manifest.artifacts.audit!,
      sha256: auditSha256,
      size: auditInfo.size
    }
    manifest.pipeline.stages.review.status = 'checkpoint'
    manifest.pipeline.stages.review.checkpointId = 'manual-review'
  }, before.revision)
}

describe('TaskReviewService', () => {
  it('reads bounded cue pages with timing and audit glossary', async () => {
    const { directory, review } = await reviewTask()
    const page = await review.page(directory, 1, 1)
    expect(page.total).toBe(2)
    expect(page.items).toEqual([{ cueId: 2, startMs: 2000, endMs: 4000, english: 'World Cup.', chinese: '世界杯。' }])
    expect(page.glossary).toEqual([{ source: 'World Cup', target: '世界杯', cueIds: [2] }])
    expect(await review.glossarySummary(directory)).toEqual({ glossaryState: 'ready', glossaryCount: 1 })
  })

  it('reads the manifest-selected Chinese cue artifact instead of the legacy fixed filename', async () => {
    const { directory, store, review } = await reviewTask()
    const relativePath = `zh_cues.audit-${crypto.randomUUID()}.tsv`
    await writeFile(join(directory, relativePath), '1\t候选版本。\n2\t历史术语版本。\n')
    const info = await stat(join(directory, relativePath))
    const sha256 = await sha256File(join(directory, relativePath))
    await store.mutate(directory, (manifest) => {
      manifest.artifacts.chineseCues = {
        relativePath,
        sha256,
        size: info.size,
        valid: false,
        producer: 'user-audit-decision',
        inputFingerprint: '2'.repeat(64)
      }
    })

    const page = await review.page(directory, 0, 2)
    expect(page.items.map((item) => item.chinese)).toEqual(['候选版本。', '历史术语版本。'])
  })

  it('falls back to the fixed Chinese cue filename only for legacy manifests without an artifact', async () => {
    const { directory, store, review } = await reviewTask()
    await store.mutate(directory, (manifest) => { delete manifest.artifacts.chineseCues })
    expect((await review.page(directory, 0, 2)).items.map((item) => item.chinese)).toEqual(['你好。', '世界杯。'])
  })

  it('reads the manifest-selected English artifact and only uses the fixed filename for legacy manifests', async () => {
    const selected = await reviewTask()
    const relativePath = `english.clean-${crypto.randomUUID()}.srt`
    await writeFile(join(selected.directory, relativePath), '1\n00:00:00,000 --> 00:00:02,000\nSelected hello.\n\n2\n00:00:02,000 --> 00:00:04,000\nSelected World Cup.\n')
    const info = await stat(join(selected.directory, relativePath))
    const sha256 = await sha256File(join(selected.directory, relativePath))
    await selected.store.mutate(selected.directory, (manifest) => {
      manifest.artifacts.englishClean = {
        relativePath,
        sha256,
        size: info.size,
        valid: false,
        producer: 'fixture-selected',
        inputFingerprint: '2'.repeat(64)
      }
    })
    expect((await selected.review.page(selected.directory, 0, 2)).items.map((item) => item.english))
      .toEqual(['Selected hello.', 'Selected World Cup.'])

    const legacy = await reviewTask()
    await legacy.store.mutate(legacy.directory, (manifest) => { delete manifest.artifacts.englishClean })
    expect((await legacy.review.page(legacy.directory, 0, 2)).items.map((item) => item.english))
      .toEqual(['Hello.', 'World Cup.'])
  })

  it('isolates a malformed audit summary from the rest of the catalog', async () => {
    const { directory, review } = await reviewTask()
    await writeFile(join(directory, 'audit.json'), '{invalid')
    expect(await review.glossarySummary(directory)).toEqual({ glossaryState: 'invalid', glossaryCount: 0 })
  })

  it('returns the audit glossary while subtitle review is waiting at a checkpoint', async () => {
    const { directory, store, review } = await reviewTask()
    const before = await store.load(directory)
    await store.mutate(
      directory,
      (manifest) => {
        manifest.pipeline.stages.audit.status = 'checkpoint'
      },
      before.revision,
    )
    const page = await review.page(directory, 0, 1)
    expect(page.availability).toBe('not-ready')
    expect(page.message).toBe('完成全局审计后才能校对字幕')
    expect(page.glossaryState).toBe('ready')
    expect(page.glossary).toEqual([{ source: 'World Cup', target: '世界杯', cueIds: [2] }])
  })

  it('persists manual edits and invalidates only generated downstream artifacts', async () => {
    const { directory, store, review } = await reviewTask()
    const before = await store.load(directory)
    const updated = await review.update(directory, before.revision, [{ cueId: 2, translation: '世界杯赛事。' }])
    expect(updated.translation.manualEdits).toMatchObject([{ cueId: 2, translation: '世界杯赛事。' }])
    expect(updated.pipeline.stages.translate.status).toBe('completed')
    expect(updated.pipeline.stages.audit.status).toBe('completed')
    expect(updated.pipeline.stages.review.status).toBe('completed')
    expect(['srt', 'burn', 'verify'].map((stage) => updated.pipeline.stages[stage].status)).toEqual(['stale', 'stale', 'stale'])
    expect(['chineseCues', 'bilingual', 'final', 'burnLog', 'verification'].every((name) => updated.artifacts[name].valid === false)).toBe(true)
    expect(updated.runtime.finalRelativePath).toBeUndefined()
    expect((await review.page(directory, 0, 100)).items[1].chinese).toBe('世界杯赛事。')
    await expect(review.update(directory, before.revision, [{ cueId: 1, translation: '旧页面。' }])).rejects.toThrow('请刷新后重试')
  })

  it('stores a per-task subtitle preset and invalidates only burn and verification outputs', async () => {
    const { directory, store, review } = await reviewTask()
    const before = await store.load(directory)
    const updated = await review.updateSubtitlePreset(directory, before.revision, 'large')

    expect(updated.render.subtitlePreset).toBe('large')
    expect(updated.pipeline.stages.srt.status).toBe('completed')
    expect(updated.pipeline.stages.burn.status).toBe('stale')
    expect(updated.pipeline.stages.verify.status).toBe('stale')
    expect(updated.artifacts.bilingual.valid).toBe(true)
    expect(['final', 'burnLog', 'verification'].every((name) => updated.artifacts[name].valid === false)).toBe(true)
    expect(updated.runtime.finalRelativePath).toBeUndefined()
    expect(updated.runtime.completedAt).toBeUndefined()
  })

  it('treats the current subtitle preset as an idempotent CAS without invalidating a completed render', async () => {
    const { directory, store } = await reviewTask()
    const onManifest = vi.fn()
    const review = new TaskReviewService(store, () => false, onManifest)
    const before = await store.load(directory)

    const unchanged = await review.updateSubtitlePreset(directory, before.revision, before.render.subtitlePreset)

    expect(unchanged).toEqual(before)
    expect(onManifest).not.toHaveBeenCalled()
    expect(unchanged.pipeline.stages.burn.status).toBe('completed')
    expect(unchanged.pipeline.stages.verify.status).toBe('completed')
    expect(['final', 'burnLog', 'verification'].every((name) => unchanged.artifacts[name].valid)).toBe(true)
    expect(unchanged.runtime.finalRelativePath).toBe('final.mp4')
    expect(unchanged.runtime.completedAt).toBe(before.runtime.completedAt)

    await store.mutate(directory, (manifest) => { manifest.title = 'concurrent update' }, before.revision)
    await expect(review.updateSubtitlePreset(directory, before.revision, before.render.subtitlePreset))
      .rejects.toThrow('任务已被更新')
  })

  it('keeps not-yet-started burn and verification stages pending when the task preset changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-pending-preset-'))
    directories.push(directory)
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/pending-preset' }, '', 'codex')
    await store.create(directory, manifest)
    const review = new TaskReviewService(store, () => false, () => undefined)

    const updated = await review.updateSubtitlePreset(directory, manifest.revision, 'large')

    expect(updated.render.subtitlePreset).toBe('large')
    expect(updated.pipeline.stages.burn.status).toBe('pending')
    expect(updated.pipeline.stages.verify.status).toBe('pending')
    expect(updated.runtime.currentMessage).toBe(manifest.runtime.currentMessage)
  })

  it('returns a bounded timeline window around playback without changing the editor page', async () => {
    const { directory, store, review } = await reviewTask()
    const timecode = (milliseconds: number): string => {
      const hours = Math.floor(milliseconds / 3_600_000)
      const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
      const seconds = Math.floor((milliseconds % 60_000) / 1_000)
      const millis = milliseconds % 1_000
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`
    }
    const english = Array.from({ length: 250 }, (_, index) => {
      const start = index * 1_000
      return `${index + 1}\n${timecode(start)} --> ${timecode(start + 900)}\nCue ${index + 1}.\n`
    }).join('\n')
    const chinese = Array.from({ length: 250 }, (_, index) => `${index + 1}\t字幕 ${index + 1}。`).join('\n')
    await writeFile(join(directory, 'english.clean.srt'), english)
    await writeFile(join(directory, 'zh_cues.tsv'), `${chinese}\n`)
    const [englishInfo, chineseInfo, englishSha256, chineseSha256] = await Promise.all([
      stat(join(directory, 'english.clean.srt')),
      stat(join(directory, 'zh_cues.tsv')),
      sha256File(join(directory, 'english.clean.srt')),
      sha256File(join(directory, 'zh_cues.tsv'))
    ])
    const before = await store.load(directory)
    const updated = await store.mutate(directory, (manifest) => {
      manifest.artifacts.englishClean = {
        ...manifest.artifacts.englishClean,
        size: englishInfo.size,
        sha256: englishSha256
      }
      manifest.artifacts.chineseCues = {
        ...manifest.artifacts.chineseCues,
        size: chineseInfo.size,
        sha256: chineseSha256
      }
      manifest.runtime.durationSeconds = 250
    }, before.revision)

    const request = {
      taskId: updated.taskId,
      milliseconds: 175_500,
      limit: 100,
      expectedRevision: updated.revision,
      expectedEnglishSha256: updated.artifacts.englishClean.sha256,
      expectedChineseSha256: updated.artifacts.chineseCues.sha256
    }
    const timeline = await review.timelineWindow(directory, request)

    expect(timeline.items).toHaveLength(100)
    expect(timeline.items.some((cue) => cue.cueId === 176)).toBe(true)
    expect(timeline.rangeStartMs).toBeLessThanOrEqual(request.milliseconds)
    expect(timeline.rangeEndMs).toBeGreaterThan(request.milliseconds)
    expect((await review.page(directory, 0, 100)).offset).toBe(0)
    await expect(review.timelineWindow(directory, { ...request, expectedRevision: updated.revision - 1 })).rejects.toThrow('任务已更新')
  })

  it('singleflights concurrent timeline source loads for one artifact identity', async () => {
    const { directory, store } = await reviewTask()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const loader = vi.fn(async () => {
      await blocked
      return {
        english: parseSrt('1\n00:00:00,000 --> 00:00:02,000\nHello.\n\n2\n00:00:02,000 --> 00:00:04,000\nWorld Cup.\n'),
        englishSha256: 'a'.repeat(64),
        chinese: new Map([['1', '你好。'], ['2', '世界杯。']])
      }
    })
    const review = new TaskReviewService(store, () => false, () => undefined, 60_000, loader)
    const manifest = await store.load(directory)
    const request = (milliseconds: number) => ({
      taskId: manifest.taskId,
      milliseconds,
      limit: 1,
      expectedRevision: manifest.revision,
      expectedEnglishSha256: manifest.artifacts.englishClean.sha256,
      expectedChineseSha256: manifest.artifacts.chineseCues.sha256
    })

    const first = review.timelineWindow(directory, request(500))
    const second = review.timelineWindow(directory, request(2_500))
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce())
    release()
    const windows = await Promise.all([first, second])

    expect(loader).toHaveBeenCalledOnce()
    expect(windows[0].items[0].cueId).toBe(1)
    expect(windows[1].items[0].cueId).toBe(2)
  })

  it('uses LRU timeline bounds and forgets deleted task caches', async () => {
    const tasks = await Promise.all([reviewTask(), reviewTask(), reviewTask()])
    const store = new TaskStore()
    const loader = vi.fn(async () => ({
      english: parseSrt('1\n00:00:00,000 --> 00:00:02,000\nHello.\n\n2\n00:00:02,000 --> 00:00:04,000\nWorld Cup.\n'),
      englishSha256: 'a'.repeat(64),
      chinese: new Map([['1', '你好。'], ['2', '世界杯。']])
    }))
    const review = new TaskReviewService(store, () => false, () => undefined, 60_000, loader, 2)
    const request = async (index: number) => {
      const manifest = await store.load(tasks[index].directory)
      await review.timelineWindow(tasks[index].directory, {
        taskId: manifest.taskId,
        milliseconds: 500,
        limit: 1,
        expectedRevision: manifest.revision,
        expectedEnglishSha256: manifest.artifacts.englishClean.sha256,
        expectedChineseSha256: manifest.artifacts.chineseCues.sha256
      })
      return manifest.taskId
    }

    const firstTaskId = await request(0)
    const secondTaskId = await request(1)
    await request(0)
    await request(2)
    await request(1)
    expect(loader).toHaveBeenCalledTimes(4)

    review.forget(firstTaskId)
    await request(0)
    expect(loader).toHaveBeenCalledTimes(5)
    review.forget(secondTaskId)
  })

  it('persists glossary field edits as a new audit artifact without changing cue references or subtitle artifacts', async () => {
    const { directory, store, review } = await reviewTask()
    const before = await store.load(directory)
    const updated = await review.updateGlossary(directory, before.revision, [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: ' FIFA World Cup ',
      target: ' 世界杯赛事 '
    }])
    expect(updated.revision).toBe(before.revision + 1)
    expect(updated.artifacts.audit.relativePath).toMatch(/^audit\.glossary-[0-9a-f-]+\.json$/u)
    expect(updated.artifacts.audit.producer).toBe('user-glossary-edit')
    expect(updated.pipeline.stages.srt.status).toBe('completed')
    expect(updated.pipeline.stages.burn.status).toBe('completed')
    expect(updated.pipeline.stages.verify.status).toBe('completed')
    expect(updated.runtime.finalRelativePath).toBe('final.mp4')

    const persisted = JSON.parse(await readFile(join(directory, updated.artifacts.audit.relativePath), 'utf8')) as {
      glossary: Array<{ source: string; target: string; cueIds: number[] }>
      resolutions: Array<{ cueId: number; translation: string }>
    }
    expect(persisted.glossary).toEqual([{ source: 'FIFA World Cup', target: '世界杯赛事', cueIds: [2] }])
    expect(persisted.resolutions).toEqual([{ cueId: 2, translation: '世界杯' }])
    expect((await review.page(directory, 0, 100)).glossary).toEqual(persisted.glossary)
    expect((await readdir(directory)).filter((name) => name.startsWith('audit.glossary-'))).toHaveLength(1)
  })

  it('previews every referenced cue and atomically applies a glossary target during manual review', async () => {
    const { directory, store, review } = await reviewTask()
    const before = await store.load(directory)
    const checkpoint = await store.mutate(directory, (manifest) => {
      manifest.pipeline.stages.review.status = 'checkpoint'
      manifest.pipeline.stages.review.checkpointId = 'manual-review'
      manifest.pipeline.stages.review.errorCode = '等待人工校对字幕与术语'
    }, before.revision)
    const edits = [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'FIFA World Cup',
      target: '世界杯赛事'
    }]

    const preview = await review.previewGlossaryApply(directory, checkpoint.revision, edits)
    expect(preview).toMatchObject({
      taskId: checkpoint.taskId,
      revision: checkpoint.revision,
      finalCues: [{ cueId: 2, before: '世界杯。', after: '世界杯赛事。' }],
      impacts: [{
        index: 0,
        source: 'FIFA World Cup',
        previousTarget: '世界杯',
        nextTarget: '世界杯赛事',
        cues: [{
          cueId: 2,
          before: '世界杯。',
          after: '世界杯赛事。',
          matched: true,
          matchedVariant: '世界杯',
          reason: 'matched-target'
        }]
      }]
    })
    await expect(review.applyGlossary(directory, checkpoint.revision, '0'.repeat(64), edits))
      .rejects.toThrow('影响范围已变化')

    const applied = await review.applyGlossary(directory, checkpoint.revision, preview.impactFingerprint, edits)
    expect(applied.preview).toEqual(preview)
    expect(applied.manifest.artifacts.audit.producer).toBe('user-glossary-edit')
    expect(applied.manifest.translation.manualEdits).toMatchObject([{ cueId: 2, translation: '世界杯赛事。' }])
    expect(['srt', 'burn', 'verify'].map((stage) => applied.manifest.pipeline.stages[stage].status)).toEqual(['stale', 'stale', 'stale'])
    expect(applied.manifest.pipeline.stages.review.status).toBe('checkpoint')
    expect(applied.manifest.runtime.finalRelativePath).toBeUndefined()
    expect((await review.page(directory, 0, 100)).items[1].chinese).toBe('世界杯赛事。')
    expect((await review.page(directory, 0, 100)).glossary).toEqual([{ source: 'FIFA World Cup', target: '世界杯赛事', cueIds: [2] }])
    expect(applied.manifest.runtime.currentMessage).toBe('已同步 1 条译文，等待完成校对')
  })

  it('never cascades a replacement into another glossary edit on the same cue', async () => {
    const task = await reviewTask()
    const checkpoint = await enterManualReview(task, '1\t智能体\n2\t世界杯。\n', [
      { source: 'agent', target: '智能体', cueIds: [1] },
      { source: 'broker', target: '代理', cueIds: [1] }
    ])
    const edits = [
      { index: 0, expectedSource: 'agent', expectedTarget: '智能体', source: 'agent', target: '代理' },
      { index: 1, expectedSource: 'broker', expectedTarget: '代理', source: 'broker', target: '经纪人' }
    ]

    const preview = await task.review.previewGlossaryApply(task.directory, checkpoint.revision, edits)
    expect(preview.impacts[0].cues).toEqual([{
      cueId: 1,
      before: '智能体',
      after: '代理',
      matched: true,
      matchedVariant: '智能体',
      reason: 'matched-target'
    }])
    expect(preview.impacts[1].cues).toEqual([{
      cueId: 1,
      before: '智能体',
      after: '智能体',
      matched: false,
      reason: 'target-not-found'
    }])
    expect(preview.finalCues).toEqual([{ cueId: 1, before: '智能体', after: '代理' }])

    const applied = await task.review.applyGlossary(task.directory, checkpoint.revision, preview.impactFingerprint, edits)
    expect(applied.manifest.translation.manualEdits).toMatchObject([{ cueId: 1, translation: '代理' }])
    expect((await task.review.page(task.directory, 0, 2)).items[0].chinese).toBe('代理')
  })

  it('merges two non-overlapping glossary replacements from the original cue text', async () => {
    const task = await reviewTask()
    const checkpoint = await enterManualReview(task, '1\t智能体连接代理。\n2\t世界杯。\n', [
      { source: 'agent', target: '智能体', cueIds: [1] },
      { source: 'proxy', target: '代理', cueIds: [1] }
    ])
    const edits = [
      { index: 0, expectedSource: 'agent', expectedTarget: '智能体', source: 'agent', target: '代理' },
      { index: 1, expectedSource: 'proxy', expectedTarget: '代理', source: 'proxy', target: '经纪人' }
    ]

    const preview = await task.review.previewGlossaryApply(task.directory, checkpoint.revision, edits)
    expect(preview.impacts[0].cues[0]).toMatchObject({ before: '智能体连接代理。', after: '代理连接代理。', matched: true })
    expect(preview.impacts[1].cues[0]).toMatchObject({ before: '智能体连接代理。', after: '智能体连接经纪人。', matched: true })
    expect(preview.finalCues).toEqual([{ cueId: 1, before: '智能体连接代理。', after: '代理连接经纪人。' }])

    const applied = await task.review.applyGlossary(task.directory, checkpoint.revision, preview.impactFingerprint, edits)
    expect(applied.manifest.translation.manualEdits).toMatchObject([{ cueId: 1, translation: '代理连接经纪人。' }])
    expect((await task.review.page(task.directory, 0, 2)).items[0].chinese).toBe('代理连接经纪人。')
  })

  it('rejects overlapping glossary matches instead of silently choosing one replacement', async () => {
    const task = await reviewTask()
    const checkpoint = await enterManualReview(task, '1\t人工智能\n2\t世界杯。\n', [
      { source: 'artificial intelligence', target: '人工智能', cueIds: [1] },
      { source: 'intelligence', target: '智能', cueIds: [1] }
    ])
    const edits = [
      { index: 0, expectedSource: 'artificial intelligence', expectedTarget: '人工智能', source: 'artificial intelligence', target: 'AI' },
      { index: 1, expectedSource: 'intelligence', expectedTarget: '智能', source: 'intelligence', target: '智慧' }
    ]

    await expect(task.review.previewGlossaryApply(task.directory, checkpoint.revision, edits))
      .rejects.toThrow('术语匹配范围重叠：“人工智能”与“智能”')
    expect((await task.store.load(task.directory)).revision).toBe(checkpoint.revision)
  })

  it('reports an honest non-match and never invents a replacement outside audit cue references', async () => {
    const { directory, store, review } = await reviewTask()
    const before = await store.load(directory)
    const manuallyChanged = await review.update(directory, before.revision, [{ cueId: 2, translation: '世界足球盛会。' }])
    const checkpoint = await store.mutate(directory, (manifest) => {
      manifest.pipeline.stages.review.status = 'checkpoint'
      manifest.pipeline.stages.review.checkpointId = 'manual-review'
    }, manuallyChanged.revision)
    const edits = [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'World Cup',
      target: '世界杯赛事'
    }]

    const preview = await review.previewGlossaryApply(directory, checkpoint.revision, edits)
    expect(preview.impacts[0].cues).toEqual([{
      cueId: 2,
      before: '世界足球盛会。',
      after: '世界足球盛会。',
      matched: false,
      reason: 'target-not-found'
    }])
    expect(preview.finalCues).toEqual([{ cueId: 2, before: '世界足球盛会。', after: '世界足球盛会。' }])
    const applied = await review.applyGlossary(directory, checkpoint.revision, preview.impactFingerprint, edits)
    expect(applied.manifest.translation.manualEdits).toMatchObject([{ cueId: 2, translation: '世界足球盛会。' }])
    expect(applied.manifest.runtime.currentMessage).toBe('已保存统一译法；1 处引用未找到旧译法，等待人工确认')
    expect((await review.page(directory, 0, 100)).items.map((item) => item.chinese)).toEqual(['你好。', '世界足球盛会。'])
  })

  it('counts multiple unmatched glossary edits on the same cue only once', async () => {
    const task = await reviewTask()
    const checkpoint = await enterManualReview(task, '1\t完全不同。\n2\t世界杯。\n', [
      { source: 'agent', target: '智能体', cueIds: [1] },
      { source: 'broker', target: '代理', cueIds: [1] }
    ])
    const edits = [
      { index: 0, expectedSource: 'agent', expectedTarget: '智能体', source: 'agent', target: '助手' },
      { index: 1, expectedSource: 'broker', expectedTarget: '代理', source: 'broker', target: '经纪人' }
    ]

    const preview = await task.review.previewGlossaryApply(task.directory, checkpoint.revision, edits)
    expect(preview.finalCues).toEqual([{ cueId: 1, before: '完全不同。', after: '完全不同。' }])
    const applied = await task.review.applyGlossary(task.directory, checkpoint.revision, preview.impactFingerprint, edits)
    expect(applied.manifest.runtime.currentMessage).toBe('已保存统一译法；1 处引用未找到旧译法，等待人工确认')
  })

  it('reports source-only edits and matched no-op targets without claiming subtitle changes', async () => {
    const sourceOnly = await reviewTask()
    const sourceBefore = await sourceOnly.store.load(sourceOnly.directory)
    const sourceCheckpoint = await sourceOnly.store.mutate(sourceOnly.directory, (manifest) => {
      manifest.pipeline.stages.review.status = 'checkpoint'
      manifest.pipeline.stages.review.checkpointId = 'manual-review'
    }, sourceBefore.revision)
    const sourceEdits = [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'FIFA World Cup',
      target: '世界杯'
    }]
    const sourcePreview = await sourceOnly.review.previewGlossaryApply(sourceOnly.directory, sourceCheckpoint.revision, sourceEdits)
    const sourceApplied = await sourceOnly.review.applyGlossary(
      sourceOnly.directory,
      sourceCheckpoint.revision,
      sourcePreview.impactFingerprint,
      sourceEdits
    )
    expect(sourceApplied.manifest.runtime.currentMessage).toBe('已保存原文术语修改，译文无需同步')
    expect(sourceApplied.manifest.translation.manualEdits).toEqual([])

    const matchedNoop = await reviewTask()
    const noopBefore = await matchedNoop.store.load(matchedNoop.directory)
    const alternative = await matchedNoop.review.updateGlossary(matchedNoop.directory, noopBefore.revision, [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'World Cup',
      target: '世界杯 / World Cup'
    }])
    const noopCheckpoint = await matchedNoop.store.mutate(matchedNoop.directory, (manifest) => {
      manifest.pipeline.stages.review.status = 'checkpoint'
      manifest.pipeline.stages.review.checkpointId = 'manual-review'
    }, alternative.revision)
    const noopEdits = [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯 / World Cup',
      source: 'World Cup',
      target: '世界杯'
    }]
    const noopPreview = await matchedNoop.review.previewGlossaryApply(matchedNoop.directory, noopCheckpoint.revision, noopEdits)
    expect(noopPreview.impacts[0].cues[0]).toMatchObject({ matched: true, before: '世界杯。', after: '世界杯。' })
    const noopApplied = await matchedNoop.review.applyGlossary(
      matchedNoop.directory,
      noopCheckpoint.revision,
      noopPreview.impactFingerprint,
      noopEdits
    )
    expect(noopApplied.manifest.runtime.currentMessage).toBe('已保存统一译法；1 处引用已符合新译法，无需改写')
    expect(noopApplied.manifest.translation.manualEdits).toEqual([])
  })

  it('recognizes a cue that already contains the new target as matched without rewriting it', async () => {
    const task = await reviewTask()
    const checkpoint = await enterManualReview(task, '1\t智能代理。\n2\t世界杯。\n', [
      { source: 'agent', target: '智能体', cueIds: [1] }
    ])
    const edits = [{
      index: 0,
      expectedSource: 'agent',
      expectedTarget: '智能体',
      source: 'agent',
      target: '智能代理'
    }]

    const preview = await task.review.previewGlossaryApply(task.directory, checkpoint.revision, edits)
    expect(preview.impacts[0].cues).toEqual([{
      cueId: 1,
      before: '智能代理。',
      after: '智能代理。',
      matched: true,
      matchedVariant: '智能代理',
      reason: 'already-next-target'
    }])
    expect(preview.finalCues).toEqual([{ cueId: 1, before: '智能代理。', after: '智能代理。' }])

    const applied = await task.review.applyGlossary(task.directory, checkpoint.revision, preview.impactFingerprint, edits)
    expect(applied.manifest.runtime.currentMessage).toBe('已保存统一译法；1 处引用已符合新译法，无需改写')
    expect(applied.manifest.translation.manualEdits).toEqual([])
  })

  it('rejects another glossary edit that would overwrite an already-adopted target on the same cue', async () => {
    const task = await reviewTask()
    const checkpoint = await enterManualReview(task, '1\t代理\n2\t世界杯。\n', [
      { source: 'agent', target: '智能体', cueIds: [1] },
      { source: 'broker', target: '代理', cueIds: [1] }
    ])
    const edits = [
      { index: 0, expectedSource: 'agent', expectedTarget: '智能体', source: 'agent', target: '代理' },
      { index: 1, expectedSource: 'broker', expectedTarget: '代理', source: 'broker', target: '经纪人' }
    ]

    await expect(task.review.previewGlossaryApply(task.directory, checkpoint.revision, edits))
      .rejects.toThrow('术语匹配范围重叠')
    expect((await task.store.load(task.directory)).revision).toBe(checkpoint.revision)
  })

  it('allows two glossary edits to recognize the same already-adopted target without rewriting it', async () => {
    const task = await reviewTask()
    const checkpoint = await enterManualReview(task, '1\t代理\n2\t世界杯。\n', [
      { source: 'agent', target: '智能体', cueIds: [1] },
      { source: 'broker', target: '经纪人', cueIds: [1] }
    ])
    const edits = [
      { index: 0, expectedSource: 'agent', expectedTarget: '智能体', source: 'agent', target: '代理' },
      { index: 1, expectedSource: 'broker', expectedTarget: '经纪人', source: 'broker', target: '代理' }
    ]

    const preview = await task.review.previewGlossaryApply(task.directory, checkpoint.revision, edits)
    expect(preview.finalCues).toEqual([{ cueId: 1, before: '代理', after: '代理' }])
    expect(preview.impacts.flatMap((impact) => impact.cues).every((cue) => cue.reason === 'already-next-target')).toBe(true)
    const applied = await task.review.applyGlossary(task.directory, checkpoint.revision, preview.impactFingerprint, edits)
    expect(applied.manifest.translation.manualEdits).toEqual([])
  })

  it('rejects a mutation nested inside an outer already-adopted target even with another no-op claim between them', async () => {
    const task = await reviewTask()
    const checkpoint = await enterManualReview(task, '1\t人工智能代理\n2\t世界杯。\n', [
      { source: 'whole phrase', target: '整体旧译', cueIds: [1] },
      { source: 'prefix', target: '前缀旧译', cueIds: [1] },
      { source: 'agent', target: '代理', cueIds: [1] }
    ])
    const edits = [
      { index: 0, expectedSource: 'whole phrase', expectedTarget: '整体旧译', source: 'whole phrase', target: '人工智能代理' },
      { index: 1, expectedSource: 'prefix', expectedTarget: '前缀旧译', source: 'prefix', target: '人工' },
      { index: 2, expectedSource: 'agent', expectedTarget: '代理', source: 'agent', target: '经纪人' }
    ]

    await expect(task.review.previewGlossaryApply(task.directory, checkpoint.revision, edits))
      .rejects.toThrow('术语匹配范围重叠')
    expect((await task.store.load(task.directory)).revision).toBe(checkpoint.revision)
  })

  it('rejects a same-revision English artifact mutation before applying a preview', async () => {
    const { directory, store, review } = await reviewTask()
    const before = await store.load(directory)
    const checkpoint = await store.mutate(directory, (manifest) => {
      manifest.pipeline.stages.review.status = 'checkpoint'
      manifest.pipeline.stages.review.checkpointId = 'manual-review'
    }, before.revision)
    const edits = [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'World Cup',
      target: '世界杯赛事'
    }]
    const preview = await review.previewGlossaryApply(directory, checkpoint.revision, edits)
    await writeFile(join(directory, 'english.clean.srt'), '1\n00:00:00,000 --> 00:00:02,000\nHello.\n\n2\n00:00:02,000 --> 00:00:04,000\nWorld Cub.\n')

    await expect(review.applyGlossary(directory, checkpoint.revision, preview.impactFingerprint, edits))
      .rejects.toThrow('英文清理字幕产物 SHA-256 不匹配')
    expect((await store.load(directory)).artifacts.audit.sha256).toBe(checkpoint.artifacts.audit.sha256)
  })

  it('allows impact preview and apply only at the manual-review checkpoint and rejects TOCTOU revisions', async () => {
    const { directory, store, review } = await reviewTask()
    const before = await store.load(directory)
    const edits = [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'World Cup',
      target: '世界杯赛事'
    }]
    await expect(review.previewGlossaryApply(directory, before.revision, edits)).rejects.toThrow('不在人工校对 checkpoint')
    const checkpoint = await store.mutate(directory, (manifest) => {
      manifest.pipeline.stages.review.status = 'checkpoint'
      manifest.pipeline.stages.review.checkpointId = 'manual-review'
    }, before.revision)
    const preview = await review.previewGlossaryApply(directory, checkpoint.revision, edits)
    await store.mutate(directory, (manifest) => { manifest.title = '并发更新' }, checkpoint.revision)
    await expect(review.applyGlossary(directory, checkpoint.revision, preview.impactFingerprint, edits)).rejects.toThrow('请刷新后重试')
  })

  it('keeps the previous glossary artifact readable during a grace period, then removes unreferenced versions', async () => {
    const { directory, store } = await reviewTask()
    const review = new TaskReviewService(store, () => false, () => undefined, 500)
    const before = await store.load(directory)
    const first = await review.updateGlossary(directory, before.revision, [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'FIFA World Cup',
      target: '世界杯赛事'
    }])
    const previousPath = join(directory, first.artifacts.audit.relativePath)
    const second = await review.updateGlossary(directory, first.revision, [{
      index: 0,
      expectedSource: 'FIFA World Cup',
      expectedTarget: '世界杯赛事',
      source: 'FIFA World Cup',
      target: '世界杯锦标赛'
    }])

    expect(JSON.parse(await readFile(previousPath, 'utf8')).glossary[0].target).toBe('世界杯赛事')
    expect((await readdir(directory)).filter((name) => name.startsWith('audit.glossary-'))).toHaveLength(2)
    expect((await review.page(directory, 0, 1)).glossary).toEqual([{ source: 'FIFA World Cup', target: '世界杯锦标赛', cueIds: [2] }])
    expect(second.artifacts.audit.relativePath).not.toBe(first.artifacts.audit.relativePath)
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect((await readdir(directory)).filter((name) => name.startsWith('audit.glossary-'))).toEqual([second.artifacts.audit.relativePath])
  })

  it('removes an old orphaned glossary artifact after the task is opened again', async () => {
    const { directory, store } = await reviewTask()
    const orphan = `audit.glossary-${crypto.randomUUID()}.json`
    const orphanPath = join(directory, orphan)
    await writeFile(orphanPath, '{}\n')
    const old = new Date(Date.now() - 10_000)
    await utimes(orphanPath, old, old)
    const review = new TaskReviewService(store, () => false, () => undefined, 200)

    await review.page(directory, 0, 1)
    expect((await readdir(directory)).filter((name) => name === orphan)).toEqual([orphan])
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect((await readdir(directory)).filter((name) => name === orphan)).toEqual([])
  })

  it('rejects audit artifact paths outside the task directory', async () => {
    const { directory, store, review } = await reviewTask()
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'etch-review-outside-'))
    directories.push(outsideDirectory)
    const outsidePath = join(outsideDirectory, 'audit.json')
    const outsideAudit = `${JSON.stringify({ glossary: [{ source: 'World Cup', target: '外部文件', cueIds: [2] }], patches: [] })}\n`
    await writeFile(outsidePath, outsideAudit)
    const before = await store.load(directory)
    const damaged = await store.mutate(directory, (manifest) => {
      manifest.artifacts.audit = {
        ...manifest.artifacts.audit!,
        relativePath: relative(directory, outsidePath),
        producer: 'user-glossary-edit'
      }
    }, before.revision)

    await expect(review.updateGlossary(directory, damaged.revision, [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '外部文件',
      source: 'World Cup',
      target: '不应写入'
    }])).rejects.toThrow('路径无效')
    expect(await readFile(outsidePath, 'utf8')).toBe(outsideAudit)
  })

  it('rejects stale or mismatched glossary edits and blocks edits while running or awaiting audit decisions', async () => {
    const first = await reviewTask()
    const before = await first.store.load(first.directory)
    await expect(first.review.updateGlossary(first.directory, before.revision, [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '旧译法',
      source: 'World Cup',
      target: '世界杯赛事'
    }])).rejects.toThrow('术语表已被更新')
    await first.store.mutate(first.directory, (manifest) => { manifest.title = '新标题' })
    await expect(first.review.updateGlossary(first.directory, before.revision, [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'World Cup',
      target: '世界杯赛事'
    }])).rejects.toThrow('请刷新后重试')

    const runningTask = await reviewTask()
    const runningReview = new TaskReviewService(runningTask.store, () => true, () => undefined)
    await expect(runningReview.updateGlossary(runningTask.directory, 0, [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'World Cup',
      target: '世界杯赛事'
    }])).rejects.toThrow('任务运行中')

    const checkpointTask = await reviewTask()
    const checkpointBefore = await checkpointTask.store.load(checkpointTask.directory)
    const checkpoint = await checkpointTask.store.mutate(checkpointTask.directory, (manifest) => {
      manifest.translation.auditCheckpoint = {
        ambiguities: [{ cueId: 2, en: 'World Cup.', before: '世界杯。', recommended: '世界杯赛事。', reason: '待确认' }]
      }
    }, checkpointBefore.revision)
    await expect(checkpointTask.review.updateGlossary(checkpointTask.directory, checkpoint.revision, [{
      index: 0,
      expectedSource: 'World Cup',
      expectedTarget: '世界杯',
      source: 'World Cup',
      target: '世界杯赛事'
    }])).rejects.toThrow('先完成术语审计裁决')
  })

  it('rejects edits while the task is running', async () => {
    const { directory, store } = await reviewTask()
    const review = new TaskReviewService(store, () => true, () => undefined)
    await expect(review.update(directory, 0, [{ cueId: 1, translation: '你好。' }])).rejects.toThrow('任务运行中')
  })
})
