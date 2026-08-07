import { describe, expect, it } from 'vitest'
import { permissionGuideCopy } from '../src/renderer/permission-guide'

describe('Chrome cookie permission guide copy', () => {
  it('asks for the macOS grant and shows the settings steps only when access is denied', () => {
    const denied = permissionGuideCopy('denied')
    expect(denied.steps.length).toBeGreaterThan(0)
    expect(denied.body).toContain('完全磁盘访问')
    expect(denied.secondary).toBe('稍后设置')
  })

  it('switches to the restart wording once the grant is live', () => {
    const granted = permissionGuideCopy('granted')
    expect(granted.steps).toEqual([])
    expect(granted.eyebrow).toBe('授权已生效')
    expect(granted.title).toContain('重启 Etch')
    expect(granted.secondary).toBe('稍后重启')
    // 已授权时不能再让用户去开权限，否则会把人送去一个已经打开的开关。
    expect(granted.body).not.toContain('完全磁盘访问')
  })

  it('does not blame permissions when Chrome itself is absent', () => {
    const missing = permissionGuideCopy('missing')
    expect(missing.steps).toEqual([])
    expect(missing.title).toContain('未找到 Chrome')
    expect(missing.body).not.toContain('完全磁盘访问')
  })
})
