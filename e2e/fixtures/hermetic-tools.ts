import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import type { AppSettings, ToolId } from '../../src/shared/settings-schema'

const TOOL_IDS: readonly ToolId[] = [
  'yt-dlp',
  'ffmpeg',
  'ffprobe',
  'python',
  'mlx_whisper',
  'claude',
  'codex',
  'qoder',
  'opencode'
]

const SEEKABLE_VIDEO_BASE64 = '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'

export interface HermeticToolFixture {
  binDirectory: string
  invocationLog: string
  toolOverrides: Record<ToolId, string>
}

const fixtures = new Map<string, Promise<HermeticToolFixture>>()

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function script(tool: ToolId, invocationLog: string): string {
  const prelude = `#!/bin/sh
if [ -n "\${GH_TOKEN:-}" ] || [ -n "\${OPENAI_API_KEY:-}" ] || [ -n "\${ANTHROPIC_API_KEY:-}" ] || [ -n "\${AWS_SECRET_ACCESS_KEY:-}" ] || [ -n "\${ETCH_E2E_SECRET_CANARY:-}" ]; then
  echo "hermetic environment violation" >&2
  exit 97
fi
/usr/bin/printf '%s\\t%s\\n' ${shellQuote(tool)} "$*" >> ${shellQuote(invocationLog)}
`
  if (tool === 'yt-dlp') return `${prelude}
if [ "\${1:-}" = "--version" ]; then echo "2026.07.28"; exit 0; fi
echo "hermetic yt-dlp does not access the network" >&2
exit 2
`
  if (tool === 'ffmpeg') return `${prelude}
for argument in "$@"; do
  if [ "$argument" = "-version" ]; then echo "ffmpeg version 8.0-hermetic"; exit 0; fi
  if [ "$argument" = "-filters" ]; then echo " T.. subtitles          V->V       Render text subtitles using libass"; exit 0; fi
done
for output; do :; done
if [ "$output" != "-" ]; then /usr/bin/touch "$output"; fi
exit 0
`
  if (tool === 'ffprobe') return `${prelude}
if [ "\${1:-}" = "-version" ]; then echo "ffprobe version 8.0-hermetic"; exit 0; fi
echo '{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"12"}}'
exit 0
`
  if (tool === 'python') return `${prelude}
echo "Python 3.12.0"
`
  if (tool === 'mlx_whisper') return `${prelude}
echo "mlx_whisper hermetic help"
`
  if (tool === 'claude') return `${prelude}
if [ "\${1:-}" = "auth" ]; then echo '{"loggedIn":true}'; else echo "claude 1.0.0"; fi
`
  if (tool === 'codex') return `${prelude}
if [ "\${1:-}" = "login" ]; then echo "Logged in using hermetic fixture"; else echo "codex-cli 1.0.0"; fi
`
  if (tool === 'qoder') return `${prelude}
if [ "\${1:-}" = "status" ]; then echo "Username: Hermetic"; echo "Email: hermetic@example.com"; else echo "qodercli 1.0.0"; fi
`
  return `${prelude}
echo "opencode 1.0.0"
`
}

export function ensureHermeticTools(userData: string): Promise<HermeticToolFixture> {
  let pending = fixtures.get(userData)
  if (pending) return pending
  pending = (async () => {
    const binDirectory = join(userData, 'hermetic-tools')
    const invocationLog = join(userData, 'hermetic-tool-invocations.log')
    await mkdir(binDirectory, { recursive: true })
    const toolOverrides = {} as Record<ToolId, string>
    for (const tool of TOOL_IDS) {
      const executable = join(binDirectory, tool)
      await writeFile(executable, script(tool, invocationLog), 'utf8')
      await chmod(executable, 0o755)
      toolOverrides[tool] = executable
    }
    return { binDirectory, invocationLog, toolOverrides }
  })()
  fixtures.set(userData, pending)
  return pending
}

export async function writeHermeticSettings(userData: string, settings: AppSettings): Promise<HermeticToolFixture> {
  const fixture = await ensureHermeticTools(userData)
  await writeFile(join(userData, 'settings.json'), `${JSON.stringify({
    ...settings,
    toolOverrides: { ...fixture.toolOverrides, ...settings.toolOverrides }
  }, null, 2)}\n`, 'utf8')
  return fixture
}

export async function launchHermeticEtch(userData: string, executablePath?: string): Promise<ElectronApplication> {
  const fixture = await ensureHermeticTools(userData)
  const home = join(userData, 'home')
  const temporary = join(userData, 'tmp')
  const xdg = join(home, '.config')
  await Promise.all([mkdir(home, { recursive: true }), mkdir(temporary, { recursive: true }), mkdir(xdg, { recursive: true })])
  return electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'], cwd: process.cwd() }),
    env: {
      PATH: `${fixture.binDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      TMPDIR: temporary,
      SHELL: '/bin/zsh',
      USER: 'etch-e2e',
      LOGNAME: 'etch-e2e',
      LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: xdg,
      ETCH_USER_DATA_DIR: userData,
      ETCH_E2E_HERMETIC: '1',
      ETCH_E2E_ALLOW_MULTIPLE_INSTANCES: '1'
    }
  })
}

export async function writeSeekableVideoFixture(path: string): Promise<void> {
  await writeFile(path, Buffer.from(SEEKABLE_VIDEO_BASE64, 'base64'))
}
