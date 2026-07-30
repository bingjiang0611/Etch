import { describe, expect, it } from 'vitest'
import { parseTaskUrls } from '../src/renderer/task-input'

describe('parseTaskUrls', () => {
  it('parses one URL per line, removes blanks and exact duplicates while preserving order', () => {
    expect(parseTaskUrls(`
      https://example.com/one

      https://example.com/two
      https://example.com/one
    `)).toEqual(['https://example.com/one', 'https://example.com/two'])
  })

  it('reports the source line for invalid or unsupported URLs', () => {
    expect(() => parseTaskUrls('https://example.com/one\nnot-a-url')).toThrow('第 2 行')
    expect(() => parseTaskUrls('file:///tmp/video.mp4')).toThrow('只支持 http 或 https')
  })

  it('requires at least one URL and caps a batch at fifty unique tasks', () => {
    expect(() => parseTaskUrls(' \n ')).toThrow('至少输入一个')
    expect(() => parseTaskUrls(Array.from({ length: 51 }, (_, index) => `https://example.com/${index}`).join('\n'))).toThrow('最多新建 50 个')
  })
})
