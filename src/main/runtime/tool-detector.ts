import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { ToolId } from '../../shared/settings-schema'
import { runProcess, type ProcessResult, type ProcessSpec } from './process-runner'

const COMMANDS: Record<ToolId, { names: string[]; versionArgs: string[] }> = {
  'yt-dlp': { names: ['yt-dlp'], versionArgs: ['--version'] },
  ffmpeg: { names: ['ffmpeg'], versionArgs: ['-version'] },
  ffprobe: { names: ['ffprobe'], versionArgs: ['-version'] },
  python: { names: ['python3.12', 'python3'], versionArgs: ['--version'] },
  mlx_whisper: { names: ['mlx_whisper'], versionArgs: ['--help'] },
  claude: { names: ['claude'], versionArgs: ['--version'] },
  codex: { names: ['codex'], versionArgs: ['--version'] },
  qoder: { names: ['qodercli'], versionArgs: ['--version'] },
  opencode: { names: ['opencode'], versionArgs: ['--version'] }
}

const FALLBACKS: Partial<Record<ToolId, string[]>> = {
  'yt-dlp': ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp'],
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  ffprobe: ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'],
  python: ['/opt/homebrew/bin/python3.12', '/opt/homebrew/bin/python3', '/usr/local/bin/python3.12', '/usr/local/bin/python3'],
  mlx_whisper: ['/opt/homebrew/bin/mlx_whisper', '/usr/local/bin/mlx_whisper'],
  claude: [join(homedir(), '.local/bin/claude')],
  codex: ['/Applications/ChatGPT.app/Contents/Resources/codex'],
  qoder: ['/Applications/QoderWork.app/Contents/Resources/bin/qodercli'],
  opencode: [join(homedir(), '.opencode/bin/opencode'), '/Applications/OpenCode.app/Contents/MacOS/opencode']
}

const PROVIDER_AUTH_PROBES: Partial<Record<ToolId, string[]>> = {
  claude: ['auth', 'status', '--json'],
  codex: ['login', 'status'],
  qoder: ['status']
}
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu')

export interface ToolHealth {
  tool: ToolId
  status: 'ready' | 'missing' | 'invalid' | 'timeout'
  executable?: string
  identity?: string
  version?: string
  summaryZh: string
  checkedAt: string
  // True when a probe was killed mid-flight, which makes this failure untrustworthy: stopping a
  // task terminates the probe and looks identical to a genuinely broken executable.
  probeCancelled?: boolean
}

export function toolCacheKey(tool: ToolId, override?: string): string {
  return `${tool}\0${override ?? ''}`
}

function providerIsLoggedIn(tool: ToolId, output: string): boolean | undefined {
  const plain = output.replace(ANSI_ESCAPE, '').replace(/\r/gu, '').trim()
  if (tool === 'claude') {
    try {
      const loggedIn = (JSON.parse(plain) as { loggedIn?: unknown }).loggedIn
      return typeof loggedIn === 'boolean' ? loggedIn : undefined
    } catch { return undefined }
  }
  if (tool === 'codex') {
    if (/^Logged in\b/mu.test(plain)) return true
    if (/^Not logged in\b/imu.test(plain)) return false
    return undefined
  }
  if (tool === 'qoder') {
    const account = plain.match(/^Account:\s*(.+)$/mu)?.[1]?.trim()
    if (account) return !/^Not logged in\b/iu.test(account)
    if (/^Username:\s*\S+/mu.test(plain) && /^Email:\s*\S+@\S+/mu.test(plain)) return true
    return undefined
  }
  return undefined
}

function loginCommand(tool: ToolId): string {
  if (tool === 'claude') return 'claude auth login'
  if (tool === 'codex') return 'codex login'
  return 'qodercli login'
}

async function executablesFromPath(name: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const found: string[] = []
  for (const part of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(part, name)
    try { await access(candidate, constants.X_OK); found.push(candidate) } catch { /* keep searching */ }
  }
  return found
}

export async function detectTool(
  tool: ToolId,
  env: NodeJS.ProcessEnv,
  override?: string,
  runner: (spec: ProcessSpec) => Promise<ProcessResult> = runProcess
): Promise<ToolHealth> {
  const checkedAt = new Date().toISOString()
  let probeCancelled = false
  const runProbe = async (spec: ProcessSpec): Promise<ProcessResult> => {
    const result = await runner(spec)
    if (result.cancelled) probeCancelled = true
    return result
  }
  const candidates: string[] = []
  if (override) {
    if (!isAbsolute(override)) return { tool, status: 'invalid', summaryZh: '手动路径必须是绝对路径', checkedAt }
    candidates.push(override)
  } else {
    const fullBuilds = tool === 'ffmpeg' || tool === 'ffprobe'
      ? [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local']
        .filter((prefix): prefix is string => typeof prefix === 'string' && isAbsolute(prefix))
        .map((prefix) => join(prefix, 'opt/ffmpeg-full/bin', tool))
      : []
    for (const fallback of new Set(fullBuilds)) {
      try { await access(fallback, constants.X_OK); candidates.push(fallback) } catch { /* keep searching */ }
    }
    for (const name of COMMANDS[tool].names) {
      candidates.push(...await executablesFromPath(name, env))
    }
    for (const fallback of FALLBACKS[tool] ?? []) {
      try { await access(fallback, constants.X_OK); candidates.push(fallback) } catch { /* keep searching */ }
    }
  }
  if (!candidates.length) return { tool, status: 'missing', summaryZh: `未找到 ${tool}`, checkedAt }
  let failure: ToolHealth | undefined
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK)
      const path = await realpath(candidate)
      const file = await stat(path)
      const providerProbe = ['claude', 'codex', 'qoder', 'opencode'].includes(tool)
      const probe = await runProbe({ command: path, args: COMMANDS[tool].versionArgs, cwd: process.cwd(), env, timeoutMs: providerProbe ? 60_000 : 30_000 })
      if (probe.timedOut) {
        failure = { tool, status: 'timeout', executable: path, summaryZh: `${tool} 版本探测超时`, checkedAt }
        continue
      }
      if (probe.exitCode !== 0) {
        failure = { tool, status: 'invalid', executable: path, summaryZh: `${tool} 无法正常执行`, checkedAt }
        continue
      }
      if (probe.stdoutTruncated || probe.stderrTruncated) {
        failure = { tool, status: 'invalid', executable: path, summaryZh: `${tool} 版本输出超过安全上限`, checkedAt }
        continue
      }
      if (tool === 'ffmpeg') {
        const filters = await runProbe({
          command: path,
          args: ['-hide_banner', '-filters'],
          cwd: process.cwd(),
          env,
          timeoutMs: 30_000
        })
        const filterOutput = `${filters.stdout}\n${filters.stderr}`
        if (filters.exitCode !== 0 || filters.timedOut || filters.cancelled
          || filters.stdoutTruncated || filters.stderrTruncated
          || !/^\s*[.A-Z|]+\s+subtitles\s+/mu.test(filterOutput)) {
          failure = {
            tool,
            status: 'invalid',
            executable: path,
            summaryZh: 'ffmpeg 缺少 libass subtitles filter',
            checkedAt
          }
          continue
        }
      }
      const authArgs = PROVIDER_AUTH_PROBES[tool]
      if (authArgs) {
        const auth = await runProbe({ command: path, args: authArgs, cwd: process.cwd(), env, timeoutMs: 15_000 })
        if (auth.timedOut) {
          failure = { tool, status: 'timeout', executable: path, summaryZh: `${tool} 登录状态探测超时`, checkedAt }
          continue
        }
        if (auth.exitCode !== 0) {
          failure = { tool, status: 'invalid', executable: path, summaryZh: `${tool} 登录状态探测失败`, checkedAt }
          continue
        }
        if (auth.stdoutTruncated || auth.stderrTruncated) {
          failure = { tool, status: 'invalid', executable: path, summaryZh: `${tool} 登录状态输出超过安全上限`, checkedAt }
          continue
        }
        const authOutput = tool === 'claude' ? auth.stdout.trim() : `${auth.stdout}\n${auth.stderr}`.trim()
        const loggedIn = providerIsLoggedIn(tool, authOutput)
        if (loggedIn !== true) {
          failure = {
            tool,
            status: 'invalid',
            executable: path,
            version: `${probe.stdout}\n${probe.stderr}`.trim().split('\n')[0],
            summaryZh: loggedIn === false ? `${tool} 未登录，请先运行 ${loginCommand(tool)}` : `${tool} 登录状态无法确认`,
            checkedAt
          }
          continue
        }
      }
      return {
        tool,
        status: 'ready',
        executable: path,
        identity: `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`,
        version: `${probe.stdout}\n${probe.stderr}`.trim().split('\n')[0],
        summaryZh: authArgs ? `${tool} CLI 已登录` : providerProbe ? `${tool} CLI 可启动；登录态运行时校验` : `${tool} 可用`,
        checkedAt
      }
    } catch {
      failure = { tool, status: 'invalid', executable: candidate, summaryZh: `${tool} 路径不可执行`, checkedAt }
    }
  }
  if (failure) return probeCancelled ? { ...failure, probeCancelled: true } : failure
  return { tool, status: 'missing', summaryZh: `未找到 ${tool}`, checkedAt }
}

export async function identityStillMatches(health: ToolHealth): Promise<boolean> {
  if (health.status !== 'ready' || !health.executable || !health.identity) return false
  try {
    const file = await stat(await realpath(health.executable))
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}` === health.identity
  } catch { return false }
}
