import { STAGE_IDS, type StageId } from './task-schema'

export const STAGE_ORDER: readonly StageId[] = STAGE_IDS

export const POOL_BY_STAGE: Partial<Record<StageId, 'download' | 'whisper' | 'agent' | 'audit' | 'ffmpeg'>> = {
  source: 'download',
  english: 'whisper',
  cues: 'audit',
  translate: 'agent',
  audit: 'audit',
  burn: 'ffmpeg'
}
