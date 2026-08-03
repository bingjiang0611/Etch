import { describe, expect, it } from 'vitest'
import { readableRemoteError } from '../src/renderer/readable-error'

describe('readableRemoteError', () => {
  it('removes Electron IPC wrappers from an actionable publication error', () => {
    expect(readableRemoteError(
      new Error("Error invoking remote method 'bilibili:continue': Error: 无法转换投稿封面"),
      '继续失败'
    )).toBe('无法转换投稿封面')
  })

  it('uses the fallback for non-errors and empty wrappers', () => {
    expect(readableRemoteError('failure', '操作失败')).toBe('操作失败')
    expect(readableRemoteError(new Error("Error invoking remote method 'bilibili:continue': Error: "), '操作失败')).toBe('操作失败')
  })
})
