import { InstallableToolSchema, type InstallableTool } from '../../shared/ipc'
import type { ToolId } from '../../shared/settings-schema'

export const INSTALLABLE_TOOLS: readonly InstallableTool[] = InstallableToolSchema.options

export function isInstallableTool(tool: ToolId): tool is InstallableTool {
  return (INSTALLABLE_TOOLS as readonly string[]).includes(tool)
}

const BREW_FORMULA: Record<InstallableTool, string> = {
  'yt-dlp': 'yt-dlp',
  ffmpeg: 'ffmpeg-full',
  ffprobe: 'ffmpeg-full',
  python: 'python@3.12',
  mlx_whisper: 'python@3.12'
}

// Builds a self-contained zsh script for a `.command` file that Terminal runs on open.
// `brew` is the absolute path to the detected Homebrew binary; mlx_whisper additionally
// installs the PyPI package with that formula's python so the console script lands on PATH.
export function toolInstallScript(tool: InstallableTool, brew: string): string {
  const base = `"${brew}" install ${BREW_FORMULA[tool]}`
  const command = tool === 'mlx_whisper'
    ? `${base} && "$("${brew}" --prefix python@3.12)/bin/python3.12" -m pip install --break-system-packages --upgrade mlx-whisper`
    : base
  return [
    '#!/bin/zsh',
    `echo "正在为 Etch 安装 ${tool} …"`,
    command,
    'status=$?',
    'echo',
    'if [ $status -eq 0 ]; then echo "安装完成，回到 Etch 点击“重新检测”。"; else echo "安装失败（退出码 $status），请检查上方输出。"; fi',
    ''
  ].join('\n')
}
