import { describe, expect, it } from 'vitest'
import { CreateUrlsSchema, SetTaskCategoryPayloadSchema, TaskSummarySchema } from '../src/shared/ipc'
import { AppSettingsSchema, defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, migrateTaskManifest } from '../src/shared/task-schema'
import {
  ALL_TASKS_TAB,
  UNSORTED_TAB,
  categoryCounts,
  createCategoryDraft,
  effectiveCategory,
  moveCategory,
  renameCategoryDraft,
  resolveTab,
  taskMatchesTab
} from '../src/renderer/task-categories'

const categories = [
  { id: 'ai', name: 'AI 访谈', color: 'blue' as const },
  { id: 'talk', name: '技术讲座', color: 'ok' as const }
]

describe('任务分类归属', () => {
  it('把引用已删除分类的任务当成未分类，而不是让它从所有 tab 里消失', () => {
    expect(effectiveCategory(categories, 'ai')).toBe('ai')
    expect(effectiveCategory(categories, 'gone')).toBe('')
    expect(taskMatchesTab(categories, 'gone', UNSORTED_TAB)).toBe(true)
    expect(taskMatchesTab(categories, 'gone', 'ai')).toBe(false)
    expect(taskMatchesTab(categories, 'gone', ALL_TASKS_TAB)).toBe(true)
  })

  it('计数把未分类和已删分类算在一起，空分类记为 0', () => {
    const counts = categoryCounts(categories, [
      { category: 'ai' },
      { category: 'ai' },
      { category: '' },
      { category: 'gone' }
    ])
    expect(counts).toEqual({ total: 4, unsorted: 2, byCategory: { ai: 2, talk: 0 } })
  })

  it('分类被删或未分类清空后回落到全部任务，否则保持当前 tab', () => {
    expect(resolveTab(categories, 'ai', 1)).toBe('ai')
    expect(resolveTab(categories, 'gone', 1)).toBe(ALL_TASKS_TAB)
    expect(resolveTab(categories, UNSORTED_TAB, 2)).toBe(UNSORTED_TAB)
    expect(resolveTab(categories, UNSORTED_TAB, 0)).toBe(ALL_TASKS_TAB)
    // 空分类仍然留在原 tab 上，交给空状态给出归类入口。
    expect(resolveTab(categories, 'talk', 0)).toBe('talk')
  })
})

describe('分类增改与排序', () => {
  it('拒绝空名和重名，新分类拿到未占用的下一个颜色', () => {
    expect(createCategoryDraft(categories, '  ')).toEqual({ error: '分类名称不能为空' })
    expect(createCategoryDraft(categories, 'AI 访谈')).toEqual({ error: '已经有叫「AI 访谈」的分类了' })
    const created = createCategoryDraft(categories, '  发布会 ')
    expect(created).toMatchObject({ category: { name: '发布会', color: 'warn' } })
    expect('category' in created && created.category.id).toBeTruthy()
  })

  it('重命名允许改回自己，但不允许撞上别的分类', () => {
    expect(renameCategoryDraft(categories, 'ai', 'AI 访谈')).toEqual(categories)
    expect(renameCategoryDraft(categories, 'ai', '技术讲座')).toEqual({ error: '已经有叫「技术讲座」的分类了' })
    expect(renameCategoryDraft(categories, 'ai', ' 访谈 ')).toEqual([{ id: 'ai', name: '访谈', color: 'blue' }, categories[1]])
  })

  it('上下移动到边界时原样返回，不越界也不丢分类', () => {
    expect(moveCategory(categories, 'ai', -1).map((item) => item.id)).toEqual(['ai', 'talk'])
    expect(moveCategory(categories, 'ai', 1).map((item) => item.id)).toEqual(['talk', 'ai'])
    expect(moveCategory(categories, 'talk', 1).map((item) => item.id)).toEqual(['ai', 'talk'])
  })
})

describe('分类落在设置里', () => {
  it('旧设置没有 taskCategories 时补空数组，不需要 schemaVersion 迁移', () => {
    const legacy: Record<string, unknown> = { ...defaultSettings('/Users/test') }
    delete legacy.taskCategories
    expect(AppSettingsSchema.parse(legacy).taskCategories).toEqual([])
  })

  it('拒绝非法颜色和空名分类，避免把坏数据写进设置', () => {
    const settings = defaultSettings('/Users/test')
    expect(() => AppSettingsSchema.parse({ ...settings, taskCategories: [{ id: 'ai', name: 'AI', color: 'purple' }] })).toThrow()
    expect(() => AppSettingsSchema.parse({ ...settings, taskCategories: [{ id: 'ai', name: '  ', color: 'blue' }] })).toThrow()
    expect(AppSettingsSchema.parse({ ...settings, taskCategories: categories }).taskCategories).toEqual(categories)
  })
})

describe('分类字段的持久化与 IPC', () => {
  it('旧 manifest 没有 category 时补空串，新建时写入传入的分类', () => {
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/one' }, '', 'claude', '', 'standard', false, 'subtitle', 'ai')
    expect(manifest.category).toBe('ai')
    const legacy: Record<string, unknown> = { ...manifest }
    delete legacy.category
    expect(migrateTaskManifest(legacy).category).toBe('')
  })

  it('创建与改分类的 payload 会 trim，且分类可选', () => {
    const created = CreateUrlsSchema.parse({ urls: ['https://example.com/one'], provider: 'claude' })
    expect(created.category).toBe('')
    expect(CreateUrlsSchema.parse({ urls: ['https://example.com/one'], provider: 'claude', category: ' ai ' }).category).toBe('ai')
    expect(SetTaskCategoryPayloadSchema.parse({ taskId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', category: ' ai ' }).category).toBe('ai')
    expect(() => SetTaskCategoryPayloadSchema.parse({ taskId: 'not-a-uuid', category: 'ai' })).toThrow()
  })

  it('队列条目带 category，缺失时默认未分类', () => {
    const base = {
      taskId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      title: 'demo',
      status: 'pending',
      revision: 0,
      updatedAt: '2026-08-08T00:00:00.000Z'
    }
    expect(TaskSummarySchema.parse(base).category).toBe('')
    expect(TaskSummarySchema.parse({ ...base, category: 'ai' }).category).toBe('ai')
  })
})
