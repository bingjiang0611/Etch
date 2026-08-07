import { describe, expect, it } from 'vitest'
import { INSTALLABLE_TOOLS, isInstallableTool, toolInstallScript } from '../src/main/runtime/tool-install'

const brew = '/opt/homebrew/bin/brew'

describe('本地工具一键安装脚本', () => {
  it('marks only the five non-agent tools as installable', () => {
    expect([...INSTALLABLE_TOOLS]).toEqual(['yt-dlp', 'ffmpeg', 'ffprobe', 'python', 'mlx_whisper'])
    for (const tool of INSTALLABLE_TOOLS) expect(isInstallableTool(tool)).toBe(true)
    for (const agent of ['claude', 'codex', 'qoder', 'opencode'] as const) expect(isInstallableTool(agent)).toBe(false)
  })

  it('maps ffmpeg and ffprobe to the same libass-capable formula', () => {
    expect(toolInstallScript('ffmpeg', brew)).toContain(`"${brew}" install ffmpeg-full`)
    expect(toolInstallScript('ffprobe', brew)).toContain(`"${brew}" install ffmpeg-full`)
    expect(toolInstallScript('yt-dlp', brew)).toContain(`"${brew}" install yt-dlp`)
  })

  it('installs python 3.12 without pip and mlx_whisper via that python', () => {
    const python = toolInstallScript('python', brew)
    expect(python).toContain(`"${brew}" install python@3.12`)
    expect(python).not.toContain('pip install')

    const mlx = toolInstallScript('mlx_whisper', brew)
    expect(mlx).toContain(`"${brew}" install python@3.12`)
    expect(mlx).toContain(`"$("${brew}" --prefix python@3.12)/bin/python3.12" -m pip install --break-system-packages --upgrade mlx-whisper`)
  })

  it('produces a runnable zsh command file that reports its exit status', () => {
    const script = toolInstallScript('yt-dlp', brew)
    expect(script.startsWith('#!/bin/zsh\n')).toBe(true)
    expect(script).toContain('status=$?')
    expect(script).toContain('重新检测')
  })
})
