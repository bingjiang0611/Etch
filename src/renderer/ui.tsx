import { useEffect, useRef, useState } from 'react'
import type { QueuePage, ReviewTimelineWindow, TaskDetail, TaskReviewPage } from '../shared/ipc'
import { POOL_BY_STAGE, STAGE_ORDER } from '../shared/pipeline'
import type { AppSettings } from '../shared/settings-schema'
import type { ProviderId, StageId } from '../shared/task-schema'
import { clearPlaybackPosition, loadPlaybackPosition, savePlaybackPosition } from './playback-position'
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  PLAYBACK_RATE_PRESETS,
  SEEK_STEP_SECONDS,
  parsePlaybackRate,
  playbackRateLabel,
  seekTarget
} from './playback-controls'
import { TimelineWindowCoordinator, type TimelineRequestIdentity } from './timeline-window-coordinator'

export const pools = ['download', 'whisper', 'agent', 'audit', 'ffmpeg'] as const

export type SubtitlePreset = AppSettings['subtitlePreset']
type StageState = TaskDetail['manifest']['pipeline']['stages'][string]
type IconName = 'queue' | 'glossary' | 'settings' | 'plus' | 'play' | 'pause' | 'seek-back' | 'seek-forward' | 'back' | 'link' | 'local' | 'search' | 'chevron' | 'warning' | 'refresh' | 'empty' | 'check' | 'folder' | 'record-remove' | 'trash' | 'fullscreen' | 'fullscreen-exit'

export const providerNames: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  qoder: 'Qoder',
  opencode: 'OpenCode',
}

export const stageLabels: Record<StageId, string> = {
  source: '抓取',
  inspect: '探测',
  english: '英文字幕',
  cues: '英文清理与审计',
  translate: '翻译',
  audit: '术语审计',
  review: '人工校对',
  srt: '生成 SRT',
  burn: '压制',
  verify: '验证',
}

export function Icon({ name }: { name: IconName }): React.JSX.Element {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (name === 'queue')
    return (
      <svg {...common}>
        <line x1="4" y1="7" x2="20" y2="7" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="17" x2="14" y2="17" />
      </svg>
    )
  if (name === 'glossary')
    return (
      <svg {...common}>
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 18.5z" />
        <line x1="8" y1="8" x2="16" y2="8" />
        <line x1="8" y1="12" x2="16" y2="12" />
        <line x1="8" y1="16" x2="12" y2="16" />
      </svg>
    )
  if (name === 'settings')
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
      </svg>
    )
  if (name === 'plus')
    return (
      <svg {...common} strokeWidth="1.8">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    )
  if (name === 'play')
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    )
  if (name === 'pause')
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="7" y="5" width="3.5" height="14" rx="1" />
        <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
      </svg>
    )
  if (name === 'seek-back')
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M11.5 6.5v11L4 12z" />
        <path d="M20 6.5v11L12.5 12z" />
      </svg>
    )
  if (name === 'seek-forward')
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M4 6.5v11L11.5 12z" />
        <path d="M12.5 6.5v11L20 12z" />
      </svg>
    )
  if (name === 'back')
    return (
      <svg {...common} strokeWidth="1.8">
        <polyline points="15 6 9 12 15 18" />
      </svg>
    )
  if (name === 'link')
    return (
      <svg {...common}>
        <path d="M9 15l6-6M11 6l1-1a3.5 3.5 0 0 1 5 5l-1 1M13 18l-1 1a3.5 3.5 0 0 1-5-5l1-1" />
      </svg>
    )
  if (name === 'local')
    return (
      <svg {...common}>
        <rect x="4" y="4" width="16" height="16" rx="2.5" />
        <path d="M9 8.5 15 12l-6 3.5z" fill="currentColor" stroke="none" />
      </svg>
    )
  if (name === 'search')
    return (
      <svg {...common} strokeWidth="1.7">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.5" y2="16.5" />
      </svg>
    )
  if (name === 'chevron')
    return (
      <svg {...common} strokeWidth="1.8">
        <polyline points="9 6 15 12 9 18" />
      </svg>
    )
  if (name === 'warning')
    return (
      <svg {...common} strokeWidth="1.7">
        <path d="M12 3 2 20h20z" />
        <line x1="12" y1="10" x2="12" y2="14" />
        <circle cx="12" cy="17" r=".6" fill="currentColor" />
      </svg>
    )
  if (name === 'refresh')
    return (
      <svg {...common} strokeWidth="1.7">
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
    )
  if (name === 'check')
    return (
      <svg {...common} strokeWidth="2.4">
        <polyline points="4 12 10 18 20 6" />
      </svg>
    )
  if (name === 'folder')
    return (
      <svg {...common}>
        <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6A2.5 2.5 0 0 1 20.5 9.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
      </svg>
    )
  if (name === 'record-remove')
    return (
      <svg {...common}>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    )
  if (name === 'trash')
    return (
      <svg {...common}>
        <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v6M14 10v6" />
      </svg>
    )
  if (name === 'fullscreen')
    return (
      <svg {...common} strokeWidth="1.9">
        <path d="M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
      </svg>
    )
  if (name === 'fullscreen-exit')
    return (
      <svg {...common} strokeWidth="1.9">
        <path d="M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4" />
      </svg>
    )
  return (
    <svg {...common}>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <line x1="7" y1="10" x2="17" y2="10" />
      <line x1="7" y1="14" x2="14" y2="14" />
    </svg>
  )
}

export function reviewTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function durationLabel(seconds?: number): string {
  return seconds === undefined ? '—' : reviewTime(seconds * 1000)
}

export function subtitleKindLabel(kind?: TaskDetail['manifest']['runtime']['subtitleKind']): string {
  if (kind === 'manual') return '人工字幕'
  if (kind === 'automatic') return '自动字幕'
  if (kind === 'whisper') return 'Whisper 转写字幕'
  return '字幕来源待识别'
}

export function getStage(detail: TaskDetail, id: StageId): StageState {
  return detail.manifest.pipeline.stages[id] ?? { status: 'pending', attempt: 0 }
}

export function isStageDone(stage: StageState): boolean {
  return stage.status === 'completed' || stage.status === 'skipped'
}

export function completedStageCount(detail: TaskDetail): number {
  return STAGE_ORDER.filter((id) => isStageDone(getStage(detail, id))).length
}

export function activeStageId(detail: TaskDetail): StageId | undefined {
  return STAGE_ORDER.find((id) => ['running', 'checkpoint', 'failed', 'paused', 'stale'].includes(getStage(detail, id).status))
}

export function taskStatusText(detail: TaskDetail | undefined, fallback: QueuePage['items'][number]['status'], waitingSlot = false): string {
  const fallbackLabels: Record<QueuePage['items'][number]['status'], string> = {
    pending: '等待中',
    ready: '可处理',
    running: '处理中',
    checkpoint: '待确认',
    completed: '已完成',
    failed: '失败',
    paused: '已暂停',
    skipped: '已跳过',
    stale: '待重建',
  }
  if (!detail) return waitingSlot ? '排队中' : fallbackLabels[fallback]
  if (detail.manifest.translation.auditCheckpoint) return '待裁决'
  if (waitingSlot) return '排队中'
  const active = activeStageId(detail)
  if (active) return stageLabels[active]
  return getStage(detail, 'verify').status === 'completed' ? '已完成' : fallbackLabels[fallback]
}

export function bilibiliPublicationText(detail: TaskDetail): string {
  const labels: Record<TaskDetail['manifest']['publication']['status'], string> = {
    idle: '未投稿',
    waiting_config: '投稿待配置',
    queued: 'B站排队中',
    uploading: 'B站上传中',
    submitting: 'B站提交中',
    submitted: '已提交 B站',
    paused: 'B站投稿已暂停',
    failed: 'B站投稿失败',
    unknown: 'B站结果待确认'
  }
  return labels[detail.manifest.publication.status]
}

export function stageSubLabel(detail: TaskDetail, id: StageId, stage: StageState): string {
  if (stage.errorCode) return stage.errorCode
  if (id === 'inspect' && detail.manifest.runtime.width && detail.manifest.runtime.height) return `${detail.manifest.runtime.width}×${detail.manifest.runtime.height}`
  if (id === 'english' && detail.manifest.runtime.subtitleKind) return detail.manifest.runtime.subtitleKind
  if (id === 'translate' && detail.manifest.translation.batches.length) {
    const verified = detail.manifest.translation.batches.filter((batch) => batch.status === 'verified').length
    return `${verified}/${detail.manifest.translation.batches.length} 批`
  }
  return stage.status === 'pending' ? '' : stage.status
}

export function poolState(detail: TaskDetail, pool: (typeof pools)[number]): StageState['status'] {
  const states = STAGE_ORDER.filter((id) => POOL_BY_STAGE[id] === pool).map((id) => getStage(detail, id).status)
  return states.find((status) => status === 'failed') ?? states.find((status) => status === 'running') ?? states.find((status) => status === 'checkpoint') ?? states.find((status) => status === 'paused') ?? states.find((status) => status === 'stale') ?? (states.every((status) => status === 'completed' || status === 'skipped') ? 'completed' : 'pending')
}

export function poolStateLabel(status: StageState['status']): string {
  if (status === 'completed' || status === 'skipped') return '已释放'
  if (status === 'running') return '运行中'
  if (status === 'failed') return '失败'
  if (status === 'checkpoint') return '待确认'
  if (status === 'paused') return '已暂停'
  if (status === 'stale') return '待重建'
  return '空闲'
}

export function SwitchControl({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void }): React.JSX.Element {
  return <button className={`switch ${checked ? 'is-on' : ''}`} type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} />
}

export function PresetDemo({ preset, active, className, disabled, onClick }: { preset: SubtitlePreset; active: boolean; className: 'preset-card' | 'preset-chip'; disabled?: boolean; onClick: () => void }): React.JSX.Element {
  const name = preset === 'compact' ? '紧凑' : preset === 'standard' ? '标准' : '大字'
  if (className === 'preset-chip')
    return (
      <button className={`${className} ${active ? 'is-active' : ''}`} data-size={preset} type="button" disabled={disabled} aria-pressed={active} onClick={onClick}>
        <span className="demo">
          <span />
        </span>
        <small>{name}</small>
      </button>
    )
  return (
    <button className={`${className} ${active ? 'is-active' : ''}`} data-size={preset} type="button" disabled={disabled} aria-pressed={active} onClick={onClick}>
      <span className="canvas-demo">
        <span>
          <span className="en">attention head</span>
          <span className="zh">注意力头</span>
        </span>
      </span>
      <span className="name">
        <strong>{name}</strong>
        <small>{preset}</small>
      </span>
    </button>
  )
}

export function VideoPreview({
  detail,
  reviewPage,
  cueDrafts,
  preset,
  videoRef,
  onActiveCueChange,
}: {
  detail: TaskDetail
  reviewPage: TaskReviewPage | undefined
  cueDrafts: Record<number, string>
  preset: SubtitlePreset
  videoRef: React.RefObject<HTMLVideoElement | null>
  onActiveCueChange?: (cueId: number | undefined) => void
}): React.JSX.Element {
  const [activeCueId, setActiveCueId] = useState<number>()
  const [isPlaying, setIsPlaying] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [subtitlePreview, setSubtitlePreview] = useState(true)
  const [rateInput, setRateInput] = useState(playbackRateLabel(1))
  const [timelineWindow, setTimelineWindow] = useState<ReviewTimelineWindow>()
  const stageRef = useRef<HTMLDivElement>(null)
  const currentTimeRef = useRef<HTMLSpanElement>(null)
  const progressRef = useRef<HTMLElement>(null)
  const scrubberRef = useRef<HTMLInputElement>(null)
  const lastPlaybackPositionRef = useRef<number | undefined>(undefined)
  const lastPersistedSecondRef = useRef(-1)
  const playbackRateRef = useRef(1)
  const timelineWindowRef = useRef<ReviewTimelineWindow | undefined>(undefined)
  const detailRef = useRef(detail)
  const syncPlaybackRef = useRef<(video: HTMLVideoElement) => void>(() => undefined)
  const timelineCoordinatorRef = useRef<TimelineWindowCoordinator | undefined>(undefined)
  detailRef.current = detail
  timelineWindowRef.current = timelineWindow

  const timelineIdentity = (): TimelineRequestIdentity => ({
    taskId: detailRef.current.manifest.taskId,
    revision: detailRef.current.manifest.revision,
    englishSha256: detailRef.current.manifest.artifacts.englishClean?.sha256,
    chineseSha256: detailRef.current.manifest.artifacts.chineseCues?.sha256
  })
  timelineCoordinatorRef.current ??= new TimelineWindowCoordinator(
    (identity, milliseconds) => window.etch.reviewTimelineWindow(
      identity.taskId,
      milliseconds,
      identity.revision,
      identity.englishSha256,
      identity.chineseSha256
    ),
    (next) => {
      timelineWindowRef.current = next
      setTimelineWindow(next)
      if (videoRef.current) syncPlaybackRef.current(videoRef.current)
    }
  )
  timelineCoordinatorRef.current.reset(timelineIdentity())

  const requestTimelineWindow = (milliseconds: number): void => {
    timelineCoordinatorRef.current!.request(timelineIdentity(), milliseconds)
  }

  const syncPlayback = (video: HTMLVideoElement): void => {
    const milliseconds = video.currentTime * 1000
    const currentWindow = timelineWindowRef.current
    const timelineItems = currentWindow
      && currentWindow.taskId === detailRef.current.manifest.taskId
      && currentWindow.revision === detailRef.current.manifest.revision
      && currentWindow.rangeStartMs <= milliseconds
      && milliseconds < currentWindow.rangeEndMs
      ? currentWindow.items
      : undefined
    const pageCoversTime = Boolean(reviewPage?.items.length
      && reviewPage.items[0].startMs <= milliseconds
      && milliseconds < reviewPage.items.at(-1)!.endMs)
    const candidates = timelineItems ?? (pageCoversTime ? reviewPage?.items : undefined)
    const nextCue = candidates?.find((cue) => cue.startMs <= milliseconds && milliseconds < cue.endMs)
    if (!candidates && reviewPage?.availability === 'ready') requestTimelineWindow(milliseconds)
    setActiveCueId((current) => (current === nextCue?.cueId ? current : nextCue?.cueId))
    if (currentTimeRef.current) currentTimeRef.current.textContent = reviewTime(milliseconds)
    if (progressRef.current) {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (detail.manifest.runtime.durationSeconds ?? 0)
      const ratio = duration ? Math.min(1, Math.max(0, video.currentTime / duration)) : 0
      progressRef.current.style.width = `${ratio * 100}%`
      if (scrubberRef.current) {
        scrubberRef.current.value = String(Math.round(ratio * 1000))
        scrubberRef.current.setAttribute('aria-valuetext', `${reviewTime(milliseconds)} / ${durationLabel(duration || undefined)}`)
      }
    }
  }
  syncPlaybackRef.current = syncPlayback

  useEffect(() => {
    timelineCoordinatorRef.current!.reset(timelineIdentity())
    timelineWindowRef.current = undefined
    setTimelineWindow(undefined)
  }, [
    detail.manifest.taskId,
    detail.manifest.revision,
    detail.manifest.artifacts.englishClean?.sha256,
    detail.manifest.artifacts.chineseCues?.sha256
  ])

  useEffect(() => {
    if (videoRef.current) syncPlayback(videoRef.current)
    else {
      setActiveCueId(undefined)
      setIsPlaying(false)
      if (currentTimeRef.current) currentTimeRef.current.textContent = '0:00'
      if (progressRef.current) progressRef.current.style.width = '0%'
      if (scrubberRef.current) scrubberRef.current.value = '0'
    }
  }, [reviewPage?.items, timelineWindow?.artifactIdentity, detail.mediaUrl])

  useEffect(() => {
    setSubtitlePreview(true)
    setRateInput(playbackRateLabel(1))
    playbackRateRef.current = 1
    if (videoRef.current) videoRef.current.playbackRate = 1
  }, [detail.manifest.taskId])

  useEffect(() => {
    const unsubscribe = window.etch.onVideoFullscreenChanged(setIsFullscreen)
    return () => {
      unsubscribe()
      void window.etch.setVideoFullscreen(false).catch(() => undefined)
    }
  }, [])

  // Arrow keys only drive the preview when nothing else owns them: typing in the cue editor, an
  // open dialog and the focused scrubber all keep their native behaviour.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return
      if (!videoRef.current) return
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      seekBy(event.key === 'ArrowLeft' ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const taskId = detail.manifest.taskId
    lastPlaybackPositionRef.current = undefined
    lastPersistedSecondRef.current = -1
    return () => {
      const seconds = lastPlaybackPositionRef.current
      if (seconds === undefined) return
      try {
        savePlaybackPosition(window.localStorage, taskId, seconds)
      } catch {
        // Renderer storage is optional; playback remains usable without persistence.
      }
    }
  }, [detail.manifest.taskId])

  useEffect(() => {
    onActiveCueChange?.(activeCueId)
  }, [activeCueId, onActiveCueChange])

  const activeCue = timelineWindow?.items.find((cue) => cue.cueId === activeCueId)
    ?? reviewPage?.items.find((cue) => cue.cueId === activeCueId)
  const subtitleUnavailable = reviewPage?.availability !== 'ready' || !reviewPage.items.length
  const showingBurnedFinal = Boolean(detail.manifest.runtime.finalRelativePath && detail.manifest.artifacts.final?.valid)
  const togglePlayback = (): void => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }
  const seekBy = (deltaSeconds: number): void => {
    const video = videoRef.current
    if (!video) return
    const duration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : (detailRef.current.manifest.runtime.durationSeconds ?? 0)
    video.currentTime = seekTarget(video.currentTime, deltaSeconds, duration)
  }
  const changePlaybackRate = (value: string): void => {
    setRateInput(value)
    const parsed = parsePlaybackRate(value)
    if (parsed === undefined) return
    playbackRateRef.current = parsed
    if (videoRef.current) videoRef.current.playbackRate = parsed
  }
  const commitPlaybackRate = (): void => {
    setRateInput(playbackRateLabel(playbackRateRef.current))
  }
  const persistPlayback = (video: HTMLVideoElement, force = false): void => {
    const seconds = video.currentTime
    lastPlaybackPositionRef.current = seconds
    const wholeSecond = Math.floor(seconds)
    if (!force && wholeSecond === lastPersistedSecondRef.current) return
    lastPersistedSecondRef.current = wholeSecond
    try {
      savePlaybackPosition(window.localStorage, detail.manifest.taskId, seconds)
    } catch {
      // Renderer storage is optional; playback remains usable without persistence.
    }
  }
  const restorePlayback = (video: HTMLVideoElement): void => {
    video.playbackRate = playbackRateRef.current
    try {
      const restored = loadPlaybackPosition(window.localStorage, detail.manifest.taskId, video.duration)
      if (restored !== undefined) {
        video.currentTime = restored
        lastPlaybackPositionRef.current = restored
        lastPersistedSecondRef.current = Math.floor(restored)
      }
    } catch {
      // Renderer storage is optional; playback remains usable without persistence.
    }
    syncPlayback(video)
  }
  const clearSavedPlayback = (): void => {
    lastPlaybackPositionRef.current = undefined
    lastPersistedSecondRef.current = -1
    try {
      clearPlaybackPosition(window.localStorage, detail.manifest.taskId)
    } catch {
      // Renderer storage is optional; playback remains usable without persistence.
    }
  }
  const toggleFullscreen = (): void => {
    if (!stageRef.current) return
    void window.etch.setVideoFullscreen(!isFullscreen).catch(() => undefined)
  }

  return (
    <div className={`editor-stage ${isFullscreen ? 'is-video-fullscreen' : ''}`} data-preset={preset} ref={stageRef}>
      <div className="stage-video">
        <div className="frame-grid" aria-hidden="true" />
        {detail.mediaUrl ? (
          <video
            ref={videoRef}
            playsInline
            preload="metadata"
            src={detail.mediaUrl}
            onClick={togglePlayback}
            onLoadedMetadata={(event) => restorePlayback(event.currentTarget)}
            onTimeUpdate={(event) => {
              syncPlayback(event.currentTarget)
              persistPlayback(event.currentTarget)
            }}
            onSeeked={(event) => {
              syncPlayback(event.currentTarget)
              persistPlayback(event.currentTarget, true)
            }}
            onPlay={() => setIsPlaying(true)}
            onPause={(event) => {
              setIsPlaying(false)
              if (event.currentTarget.ended) clearSavedPlayback()
              else persistPlayback(event.currentTarget, true)
            }}
            onEnded={() => {
              setIsPlaying(false)
              clearSavedPlayback()
            }}
          />
        ) : (
          <div className="media-placeholder">
            <span className="center-play">
              <Icon name="play" />
            </span>
            <span>媒体尚未准备</span>
          </div>
        )}
        {!showingBurnedFinal && subtitlePreview && (activeCue || subtitleUnavailable) && (
          <div className={`burn-overlay ${activeCue ? '' : 'is-empty'}`} aria-label="硬字幕合成预览">
            {activeCue ? (
              <>
                <p className="en">{activeCue.english}</p>
                <p className="zh">{cueDrafts[activeCue.cueId] ?? activeCue.chinese}</p>
              </>
            ) : (
              <p className="overlay-empty">字幕尚未生成</p>
            )}
          </div>
        )}
      </div>
      <div className="stage-toolbar">
        <button
          className="stage-seek-button"
          type="button"
          disabled={!detail.mediaUrl}
          aria-label={`后退 ${SEEK_STEP_SECONDS} 秒`}
          title={`后退 ${SEEK_STEP_SECONDS} 秒（←）`}
          onClick={() => seekBy(-SEEK_STEP_SECONDS)}
        >
          <Icon name="seek-back" />
        </button>
        <button className="stage-play-button" type="button" disabled={!detail.mediaUrl} aria-label={isPlaying ? '暂停视频' : '播放视频'} onClick={togglePlayback}>
          <Icon name={isPlaying ? 'pause' : 'play'} />
        </button>
        <button
          className="stage-seek-button"
          type="button"
          disabled={!detail.mediaUrl}
          aria-label={`前进 ${SEEK_STEP_SECONDS} 秒`}
          title={`前进 ${SEEK_STEP_SECONDS} 秒（→）`}
          onClick={() => seekBy(SEEK_STEP_SECONDS)}
        >
          <Icon name="seek-forward" />
        </button>
        <span className="stage-time mono">
          <span ref={currentTimeRef}>0:00</span>
          <span className="sep">/</span>
          <span>{durationLabel(detail.manifest.runtime.durationSeconds)}</span>
        </span>
        <label className="stage-scrub">
          <span className="sr-only">视频进度</span>
          <i ref={progressRef} />
          <input
            ref={scrubberRef}
            aria-label="视频进度"
            type="range"
            min="0"
            max="1000"
            defaultValue="0"
            disabled={!detail.mediaUrl}
            onInput={(event) => {
              const video = videoRef.current
              if (!video) return
              const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (detail.manifest.runtime.durationSeconds ?? 0)
              if (duration) video.currentTime = (Number(event.currentTarget.value) / 1000) * duration
            }}
          />
        </label>
        <label className="stage-rate" title={`播放倍速 ${MIN_PLAYBACK_RATE}–${MAX_PLAYBACK_RATE}×`}>
          <span className="sr-only">播放倍速</span>
          <input
            className="mono"
            type="text"
            list="stage-rate-presets"
            inputMode="decimal"
            spellCheck={false}
            aria-label={`播放倍速 ${MIN_PLAYBACK_RATE}–${MAX_PLAYBACK_RATE}×`}
            disabled={!detail.mediaUrl}
            value={rateInput}
            onChange={(event) => changePlaybackRate(event.target.value)}
            onBlur={commitPlaybackRate}
          />
          <datalist id="stage-rate-presets">
            {PLAYBACK_RATE_PRESETS.map((rate) => <option value={playbackRateLabel(rate)} key={rate} />)}
          </datalist>
        </label>
        {showingBurnedFinal ? (
          <span className="preview-mode-badge">硬字幕成片</span>
        ) : (
          <div className="preview-toggle" role="group" aria-label="预览模式">
            <button className={subtitlePreview ? 'is-active' : ''} type="button" aria-pressed={subtitlePreview} onClick={() => setSubtitlePreview(true)}>
              字幕预览
            </button>
            <button className={!subtitlePreview ? 'is-active' : ''} type="button" aria-pressed={!subtitlePreview} onClick={() => setSubtitlePreview(false)}>
              仅看画面
            </button>
          </div>
        )}
        <button
          className="stage-fullscreen-button"
          type="button"
          disabled={!detail.mediaUrl}
          aria-label={isFullscreen ? '退出视频全屏' : '视频全屏'}
          aria-pressed={isFullscreen}
          title={isFullscreen ? '退出全屏' : '全屏'}
          onClick={toggleFullscreen}
        >
          <Icon name={isFullscreen ? 'fullscreen-exit' : 'fullscreen'} />
        </button>
      </div>
    </div>
  )
}
