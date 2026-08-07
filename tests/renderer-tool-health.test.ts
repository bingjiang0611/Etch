import { describe, expect, it } from 'vitest'
import { mergeToolHealth, recoveredToolForStageFailure } from '../src/renderer/tool-health'
import type { ToolHealthSnapshot } from '../src/shared/ipc'

const ready = (tool: ToolHealthSnapshot['tool']): ToolHealthSnapshot => ({
  tool,
  status: 'ready',
  executable: `/opt/homebrew/bin/${tool}`,
  summaryZh: `${tool} 可用`
})

describe('运行期工具健康合并', () => {
  it('replaces a stale ready snapshot with the failure the pipeline just observed', () => {
    const current = [ready('yt-dlp'), ready('ffmpeg'), ready('ffprobe')]
    const merged = mergeToolHealth(current, { tool: 'ffmpeg', status: 'missing', summaryZh: '未找到 ffmpeg' })

    expect(merged.map((item) => item.status)).toEqual(['ready', 'missing', 'ready'])
    expect(merged.find((item) => item.tool === 'ffmpeg')).toEqual({ tool: 'ffmpeg', status: 'missing', summaryZh: '未找到 ffmpeg' })
    expect(merged).toHaveLength(3)
  })

  it('keeps the snapshot order stable and leaves the input untouched', () => {
    const current = [ready('ffmpeg'), ready('python')]
    const merged = mergeToolHealth(current, { tool: 'python', status: 'invalid', summaryZh: 'python 无法正常执行' })

    expect(merged.map((item) => item.tool)).toEqual(['ffmpeg', 'python'])
    expect(current[1].status).toBe('ready')
  })

  it('appends a tool that the last full sweep never reported', () => {
    expect(mergeToolHealth([], { tool: 'ffprobe', status: 'missing', summaryZh: '未找到 ffprobe' })).toEqual([
      { tool: 'ffprobe', status: 'missing', summaryZh: '未找到 ffprobe' }
    ])
  })

  it('lets a recovered tool turn the row green again', () => {
    const current = [{ tool: 'ffmpeg' as const, status: 'missing' as const, summaryZh: '未找到 ffmpeg' }]
    expect(mergeToolHealth(current, ready('ffmpeg'))[0].status).toBe('ready')
  })
})

describe('阶段失败对应的工具是否已恢复', () => {
  it('reports the provider that just passed a login re-detection', () => {
    const health = [ready('ffmpeg'), { tool: 'qoder' as const, status: 'ready' as const, summaryZh: 'qoder CLI 已登录' }]
    expect(recoveredToolForStageFailure('qoder 未登录，请先运行 qodercli login', health)?.tool).toBe('qoder')
  })

  it('matches a missing-tool failure too', () => {
    expect(recoveredToolForStageFailure('未找到 ffmpeg', [ready('ffmpeg')])?.tool).toBe('ffmpeg')
  })

  it('stays silent while the tool is still broken or the stage never failed on a tool', () => {
    const brokenQoder = [{ tool: 'qoder' as const, status: 'invalid' as const, summaryZh: 'qoder 未登录，请先运行 qodercli login' }]
    expect(recoveredToolForStageFailure('qoder 未登录，请先运行 qodercli login', brokenQoder)).toBeUndefined()
    expect(recoveredToolForStageFailure(undefined, [ready('qoder')])).toBeUndefined()
    expect(recoveredToolForStageFailure('翻译批次校验失败', [ready('qoder')])).toBeUndefined()
  })
})
