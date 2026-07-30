import { describe, expect, it, vi } from 'vitest'
import { TaskNotifier } from '../src/main/runtime/task-notifier'
import { createTaskManifest } from '../src/shared/task-schema'

describe('TaskNotifier', () => {
  it('primes existing state, emits enabled hidden-window transitions once, and focuses on click', () => {
    const show = vi.fn()
    const focusWindow = vi.fn()
    const settings = { completion: true, failure: true, checkpoint: true }
    const notifier = new TaskNotifier(() => settings, {
      isWindowActive: () => false,
      show,
      focusWindow
    })
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, 'Video')
    notifier.prime([manifest])

    manifest.pipeline.stages.source.status = 'failed'
    manifest.pipeline.stages.source.attempt = 1
    manifest.pipeline.stages.source.errorCode = 'download failed'
    notifier.observe(manifest)
    notifier.observe(manifest)

    expect(show).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledWith('Video', '任务处理失败，请打开 Etch 查看详情', expect.any(Function))
    show.mock.calls[0][2]()
    expect(focusWindow).toHaveBeenCalledOnce()
  })

  it('does not backfill history or notify while the main window is active', () => {
    const show = vi.fn()
    const notifier = new TaskNotifier(
      () => ({ completion: true, failure: true, checkpoint: true }),
      { isWindowActive: () => true, show, focusWindow: vi.fn() }
    )
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, 'Video')
    manifest.pipeline.stages.review.status = 'checkpoint'
    manifest.pipeline.stages.review.checkpointId = 'manual-review'

    notifier.observe(manifest)
    manifest.pipeline.stages.review.checkpointId = 'second-review'
    notifier.observe(manifest)

    expect(show).not.toHaveBeenCalled()
  })

  it('respects per-kind settings and can notify a newly rebuilt completion', () => {
    const show = vi.fn()
    const settings = { completion: false, failure: false, checkpoint: true }
    const notifier = new TaskNotifier(
      () => settings,
      { isWindowActive: () => false, show, focusWindow: vi.fn() }
    )
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, 'Video')
    notifier.prime([manifest])
    manifest.pipeline.stages.review.status = 'checkpoint'
    manifest.pipeline.stages.review.checkpointId = 'manual-review'
    notifier.observe(manifest)
    expect(show).toHaveBeenCalledWith('Video', '任务正在等待你的确认', expect.any(Function))

    manifest.pipeline.stages.review.status = 'completed'
    manifest.pipeline.stages.verify.status = 'completed'
    notifier.observe(manifest)
    expect(show).toHaveBeenCalledTimes(1)
  })
})
