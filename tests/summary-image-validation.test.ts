import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { assertImageUsable, imageIssues, pngDimensions } from '../src/core/png'

function png(width: number, height: number, padding = 0): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length, 0)
    return Buffer.concat([length, Buffer.from(type, 'ascii'), body, Buffer.alloc(4)])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(padding ? randomBytes(padding) : Buffer.alloc(0))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

describe('配图文件验收', () => {
  it('读出 PNG 尺寸并接受实测的 1792×1024 与 1376×768', () => {
    expect(pngDimensions(png(1792, 1024, 20_000))).toEqual({ width: 1792, height: 1024 })
    expect(imageIssues(png(1792, 1024, 20_000))).toEqual([])
    expect(imageIssues(png(1376, 768, 20_000))).toEqual([])
  })

  it('拒绝非 PNG、过小与非 16:9 的产物', () => {
    expect(imageIssues(Buffer.alloc(20_000)).join('；')).toContain('不是合法 PNG')
    expect(imageIssues(png(1792, 1024)).join('；')).toContain('小于 10 KB')
    expect(imageIssues(png(1024, 1024, 20_000)).join('；')).toContain('不是 16:9')
    expect(() => assertImageUsable('00-cover.png', png(1024, 1024, 20_000))).toThrow('未通过配图验收')
  })

  it('缺少 IHDR 头或尺寸为 0 时直接报错', () => {
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16)
    ])
    expect(() => pngDimensions(broken)).toThrow('缺少 IHDR 头')
    expect(() => pngDimensions(png(0, 1024))).toThrow('尺寸无效')
  })
})
