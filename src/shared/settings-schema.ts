import { z } from 'zod'
import { BilibiliPublishTemplateSchema } from './bilibili'
import { ModelSelectionSchema, ProviderIdSchema, SubtitlePresetSchema, type SubtitlePreset } from './task-schema'

export const ToolIdSchema = z.enum(['yt-dlp', 'ffmpeg', 'ffprobe', 'python', 'mlx_whisper', 'claude', 'codex', 'qoder', 'opencode'])
export type ToolId = z.infer<typeof ToolIdSchema>
export { SubtitlePresetSchema, type SubtitlePreset }

// system = 跟随 macOS 外观（prefers-color-scheme）；light / dark = 手动钉住。
export const ThemePreferenceSchema = z.enum(['system', 'light', 'dark'])
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>

// 分类色只引用已有语义 token，不新增品牌色；分类本体存在设置里，任务只存 id。
export const TASK_CATEGORY_COLORS = ['blue', 'ok', 'warn', 'audit', 'danger', 'idle'] as const
export const TaskCategoryColorSchema = z.enum(TASK_CATEGORY_COLORS)
export type TaskCategoryColor = z.infer<typeof TaskCategoryColorSchema>
export const TASK_CATEGORY_NAME_MAX = 20
export const TASK_CATEGORY_MAX = 30
export const TaskCategorySchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(TASK_CATEGORY_NAME_MAX),
  color: TaskCategoryColorSchema
})
export type TaskCategory = z.infer<typeof TaskCategorySchema>

export const AppSettingsSchema = z.object({
  schemaVersion: z.literal(2),
  workspaceRoot: z.string().min(1),
  stageConcurrency: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  queuePaused: z.boolean(),
  preventSleep: z.boolean(),
  notifications: z.object({ completion: z.boolean(), failure: z.boolean(), checkpoint: z.boolean() }),
  defaultProvider: ProviderIdSchema.optional(),
  defaultModelByProvider: z.partialRecord(ProviderIdSchema, ModelSelectionSchema).default({}),
  toolOverrides: z.partialRecord(ToolIdSchema, z.string().min(1)),
  subtitlePreset: SubtitlePresetSchema,
  theme: ThemePreferenceSchema.default('system'),
  globalGlossary: z.record(z.string(), z.string()).default({}),
  taskCategories: z.array(TaskCategorySchema).max(TASK_CATEGORY_MAX).default([]),
  bilibiliPublishTemplate: BilibiliPublishTemplateSchema
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export function migrateAppSettings(raw: unknown, homeDirectory: string): AppSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultSettings(homeDirectory)
  const legacy = raw as Record<string, unknown>
  if (legacy.schemaVersion === 1) {
    return AppSettingsSchema.parse({
      ...legacy,
      schemaVersion: 2,
      bilibiliPublishTemplate: undefined
    })
  }
  return AppSettingsSchema.parse(raw)
}

export function defaultSettings(homeDirectory: string): AppSettings {
  return AppSettingsSchema.parse({
    schemaVersion: 2,
    workspaceRoot: `${homeDirectory.replace(/\/$/, '')}/Movies/Bilingual Subs`,
    stageConcurrency: 3,
    queuePaused: false,
    preventSleep: true,
    notifications: { completion: true, failure: true, checkpoint: true },
    defaultModelByProvider: {},
    toolOverrides: {},
    subtitlePreset: 'standard',
    theme: 'system',
    globalGlossary: {},
    taskCategories: [],
    bilibiliPublishTemplate: {}
  })
}
