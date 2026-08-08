import { describe, expect, it } from 'vitest'
import {
  NEW_TASK_PROVIDER_STORAGE_KEY,
  loadLastNewTaskProvider,
  resolveNewTaskProvider,
  saveLastNewTaskProvider
} from '../src/renderer/new-task-provider'
import type { ToolHealthSnapshot } from '../src/shared/ipc'
import type { ProviderId } from '../src/shared/task-schema'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) }
  }
}

const ready = (tool: ProviderId): ToolHealthSnapshot => ({ tool, status: 'ready', summaryZh: `${tool} CLI 已登录` })
const invalid = (tool: ProviderId): ToolHealthSnapshot => ({ tool, status: 'invalid', summaryZh: `${tool} 未登录` })

describe('新建任务的 Provider 记忆', () => {
  it('round-trips the provider that last created a task', () => {
    const storage = memoryStorage()
    saveLastNewTaskProvider(storage, 'claude')

    expect(loadLastNewTaskProvider(storage)).toBe('claude')
  })

  it.each([
    ['invalid JSON', '{'],
    ['an unknown provider', JSON.stringify({ provider: 'gemini' })],
    ['a missing provider', JSON.stringify({ schemaVersion: 1 })]
  ])('discards %s', (_label, value) => {
    const storage = memoryStorage()
    storage.values.set(NEW_TASK_PROVIDER_STORAGE_KEY, value)

    expect(loadLastNewTaskProvider(storage)).toBeUndefined()
    expect(storage.values.size).toBe(0)
  })

  it('tolerates unavailable renderer storage', () => {
    const unavailable = {
      getItem: (): string | null => { throw new Error('unavailable') },
      setItem: (): void => { throw new Error('unavailable') },
      removeItem: (): void => { throw new Error('unavailable') }
    }
    expect(loadLastNewTaskProvider(unavailable)).toBeUndefined()
    expect(() => saveLastNewTaskProvider(unavailable, 'qoder')).not.toThrow()
    const unavailableGetter = (): typeof unavailable => { throw new Error('unavailable') }
    expect(loadLastNewTaskProvider(unavailableGetter)).toBeUndefined()
    expect(() => saveLastNewTaskProvider(unavailableGetter, 'qoder')).not.toThrow()
  })

  it('prefers the remembered provider, then the configured default, then Qoder', () => {
    const health = [ready('claude'), ready('codex'), ready('qoder'), ready('opencode')]
    expect(resolveNewTaskProvider('claude', 'codex', health)).toBe('claude')
    expect(resolveNewTaskProvider(undefined, 'codex', health)).toBe('codex')
    expect(resolveNewTaskProvider(undefined, undefined, health)).toBe('qoder')
  })

  it('falls back to Qoder when the remembered CLI is no longer usable', () => {
    const health = [invalid('claude'), invalid('codex'), ready('qoder')]
    expect(resolveNewTaskProvider('claude', 'codex', health)).toBe('qoder')
  })

  it('keeps the remembered provider when nothing is ready so the form can explain why', () => {
    expect(resolveNewTaskProvider('claude', 'codex', [])).toBe('claude')
    expect(resolveNewTaskProvider(undefined, undefined, [invalid('qoder')])).toBe('qoder')
  })
})
