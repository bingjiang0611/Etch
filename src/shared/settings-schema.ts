import { z } from 'zod'
import { ModelSelectionSchema, ProviderIdSchema, SubtitlePresetSchema, type SubtitlePreset } from './task-schema'

export const ToolIdSchema = z.enum(['yt-dlp', 'ffmpeg', 'ffprobe', 'python', 'mlx_whisper', 'claude', 'codex', 'qoder', 'opencode'])
export type ToolId = z.infer<typeof ToolIdSchema>
export { SubtitlePresetSchema, type SubtitlePreset }

export const AppSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceRoot: z.string().min(1),
  stageConcurrency: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  queuePaused: z.boolean(),
  preventSleep: z.boolean(),
  notifications: z.object({ completion: z.boolean(), failure: z.boolean(), checkpoint: z.boolean() }),
  defaultProvider: ProviderIdSchema.optional(),
  defaultModelByProvider: z.partialRecord(ProviderIdSchema, ModelSelectionSchema),
  toolOverrides: z.partialRecord(ToolIdSchema, z.string().min(1)),
  subtitlePreset: SubtitlePresetSchema,
  globalGlossary: z.record(z.string(), z.string()).default({})
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export function defaultSettings(homeDirectory: string): AppSettings {
  return AppSettingsSchema.parse({
    schemaVersion: 1,
    workspaceRoot: `${homeDirectory.replace(/\/$/, '')}/Movies/Bilingual Subs`,
    stageConcurrency: 3,
    queuePaused: false,
    preventSleep: true,
    notifications: { completion: true, failure: true, checkpoint: true },
    defaultModelByProvider: {},
    toolOverrides: {},
    subtitlePreset: 'standard',
    globalGlossary: {}
  })
}
