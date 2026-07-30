import { runProcess, type ProcessResult, type ProcessSpec } from './process-runner'
import type { ProviderId } from '../../shared/task-schema'

const POLLUTED = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'OPENCODE_SERVER', 'QODER_SESSION_ID']
const OPERATIONAL_KEYS = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
])
const OPERATIONAL_PREFIXES = ['LC_', 'XDG_']
const PROVIDER_PREFIXES: Record<ProviderId, readonly string[]> = {
  claude: ['ANTHROPIC_', 'CLAUDE_', 'AWS_', 'GOOGLE_', 'VERTEX_', 'CLOUD_ML_'],
  codex: ['OPENAI_', 'CODEX_', 'AZURE_'],
  qoder: ['QODER_'],
  opencode: [
    'OPENCODE_',
    'ANTHROPIC_',
    'OPENAI_',
    'GOOGLE_',
    'GEMINI_',
    'AWS_',
    'AZURE_',
    'OPENROUTER_',
    'GROQ_',
    'MISTRAL_',
    'COHERE_',
    'DEEPSEEK_',
    'XAI_',
    'OLLAMA_'
  ]
}
const loggedEnvironmentScopes = new Set<string>()
let cachedDiscoveredEnvironment: NodeJS.ProcessEnv | undefined
let discoveryInFlight: Promise<NodeJS.ProcessEnv> | undefined
export type ExternalProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>

function withoutPolluted(full: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...full }
  for (const key of POLLUTED) delete result[key]
  return result
}

function legacyEnvironment(full: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  return full.ETCH_LEGACY_FULL_CHILD_ENV === '1' ? withoutPolluted(full) : undefined
}

function pickEnvironment(full: NodeJS.ProcessEnv, prefixes: readonly string[] = []): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(full)) {
    if (value !== undefined && (OPERATIONAL_KEYS.has(key)
      || OPERATIONAL_PREFIXES.some((prefix) => key.startsWith(prefix))
      || prefixes.some((prefix) => key.startsWith(prefix)))) {
      result[key] = value
    }
  }
  return result
}

export function operationalEnvironment(full: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return legacyEnvironment(full) ?? pickEnvironment(full)
}

export function providerEnvironment(provider: ProviderId, full: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = withoutPolluted(full)
  return legacyEnvironment(clean) ?? pickEnvironment(clean, PROVIDER_PREFIXES[provider])
}

export function logChildEnvironmentKeys(scope: string, env: NodeJS.ProcessEnv): void {
  if (loggedEnvironmentScopes.has(scope)) return
  loggedEnvironmentScopes.add(scope)
  console.info(`[child-env:${scope}] keys=${Object.keys(env).sort().join(',')}`)
}

async function discoverLoginShellEnvironment(runner: ExternalProcessRunner): Promise<NodeJS.ProcessEnv> {
  if (cachedDiscoveredEnvironment) return cachedDiscoveredEnvironment
  discoveryInFlight ??= (async () => {
    try {
      const result = await runner({ command: '/bin/zsh', args: ['-lc', 'env -0'], cwd: process.cwd(), timeoutMs: 5_000 })
      if (result.exitCode !== 0 || result.timedOut || result.cancelled
        || result.stdoutTruncated || result.stderrTruncated) {
        throw new Error('无法读取 login-shell 环境')
      }
      const discovered = Object.fromEntries(result.stdout.split('\0').filter(Boolean).map((line) => {
        const split = line.indexOf('=')
        return [line.slice(0, split), line.slice(split + 1)]
      }))
      if (Object.keys(discovered).length) cachedDiscoveredEnvironment = discovered
      return discovered
    } catch {
      cachedDiscoveredEnvironment = {}
      return cachedDiscoveredEnvironment
    } finally {
      discoveryInFlight = undefined
    }
  })()
  return discoveryInFlight
}

export async function loginShellEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  runner: ExternalProcessRunner = runProcess
): Promise<NodeJS.ProcessEnv> {
  const discovered = base.ETCH_E2E_HERMETIC === '1'
    ? {}
    : await discoverLoginShellEnvironment(runner)
  return withoutPolluted({ ...base, ...discovered })
}
