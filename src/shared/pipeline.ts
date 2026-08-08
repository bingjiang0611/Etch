import { STAGE_IDS, type StageId } from './task-schema'

export const STAGE_ORDER: readonly StageId[] = STAGE_IDS

export const POOL_KINDS = ['download', 'whisper', 'agent', 'audit', 'ffmpeg', 'image'] as const
export type PoolKind = (typeof POOL_KINDS)[number]

export const POOL_LABELS: Record<PoolKind, string> = {
  download: '抓取',
  whisper: '英文字幕',
  agent: '翻译',
  audit: '审计',
  ffmpeg: '压制',
  image: '配图'
}

export const POOL_BY_STAGE: Partial<Record<StageId, PoolKind>> = {
  source: 'download',
  english: 'whisper',
  cues: 'audit',
  translate: 'agent',
  audit: 'audit',
  burn: 'ffmpeg',
  digest: 'agent',
  summary: 'agent',
  illustrate: 'image'
}
