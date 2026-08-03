import { describe, expect, it } from 'vitest'
import { renderBilibiliDescription, truncateBilibiliTitle } from '../src/shared/bilibili'
import { defaultSettings, migrateAppSettings } from '../src/shared/settings-schema'
import { createTaskManifest, migrateTaskManifest } from '../src/shared/task-schema'

describe('B站投稿 schema', () => {
  it('migrates existing task manifests without enabling automatic publication', () => {
    const current = createTaskManifest({ kind: 'url', url: 'https://example.com/video' })
    const legacy = structuredClone(current) as unknown as Record<string, unknown>
    legacy.schemaVersion = 1
    delete legacy.publication

    const migrated = migrateTaskManifest(legacy)

    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.publication).toEqual({ autoPublish: false, status: 'idle', attempt: 0 })
  })

  it('persists the per-task automatic publication choice explicitly', () => {
    expect(createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', undefined, '', 'standard', true).publication)
      .toMatchObject({ autoPublish: true, status: 'idle' })
  })

  it('migrates v1 settings with an intentionally incomplete publication template', () => {
    const current = defaultSettings('/Users/test')
    const legacy = structuredClone(current) as unknown as Record<string, unknown>
    legacy.schemaVersion = 1
    delete legacy.bilibiliPublishTemplate

    const migrated = migrateAppSettings(legacy, '/Users/test')

    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.bilibiliPublishTemplate).toEqual({
      partitionName: '',
      tags: [],
      descriptionTemplate: '{title}\n\n来源：{source_url}'
    })
  })

  it('renders only the supported template placeholders and truncates by Unicode characters', () => {
    expect(renderBilibiliDescription('{title}\n{source_url}\n{unknown}', '标题', 'https://example.com'))
      .toBe('标题\nhttps://example.com\n{unknown}')
    const title = `${'片'.repeat(79)}😀尾部`
    expect(Array.from(truncateBilibiliTitle(title))).toHaveLength(80)
    expect(truncateBilibiliTitle(title).endsWith('…')).toBe(true)
  })
})
