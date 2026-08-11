import {
  MODEL_CATALOG_MAX,
  ProviderModelCatalogSchema,
  normalizeModelId,
  type ModelCatalogEntry,
  type ProviderModelCatalog
} from '../../shared/model-catalog'
import type { ProviderId } from '../../shared/task-schema'
import { runProcess, type ProcessResult, type ProcessSpec } from './process-runner'

export type ExternalProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>

// `qodercli --list-models` resolves the current user's entitlements against the remote, so it needs
// the same budget as the login probe. Both commands are read-only listings, never a model prompt.
export const MODEL_CATALOG_PROBE_TIMEOUT_MS = 30_000
export const MODEL_CATALOG_CAPTURE_LIMIT_BYTES = 256 * 1024
export const MODEL_CATALOG_TTL_MS = 5 * 60_000

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu')

interface CatalogProbe {
  args: readonly string[]
  parse: (output: string) => ModelCatalogEntry[]
}

function plainLines(output: string): string[] {
  return output
    .replace(ANSI_ESCAPE, '')
    .replace(/\r/gu, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function pushEntry(entries: ModelCatalogEntry[], modelId: string, label: string): void {
  const normalized = normalizeModelId(modelId)
  if (!normalized || entries.some((entry) => entry.modelId === normalized)) return
  entries.push({ modelId: normalized, label: label.trim().slice(0, 200) || normalized })
}

// `qodercli --list-models` prints a `MODEL` header then one model per line. Entries whose display
// name differs from the id append it in parentheses (`Peach-07-17-DogFooding (qwen3.8-v116-...)`);
// `-m` takes the id in that case, so the parenthesised value wins when present.
function parseQoderModels(output: string): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = []
  for (const line of plainLines(output)) {
    if (/^MODEL$/iu.test(line) || line.startsWith('-')) continue
    const parenthesised = line.match(/^(.+?)\s+\(([^()]+)\)$/u)
    if (parenthesised) pushEntry(entries, parenthesised[2], parenthesised[1])
    else pushEntry(entries, line, line)
    if (entries.length >= MODEL_CATALOG_MAX) break
  }
  return entries
}

// `opencode models` prints one `provider/model` pair per line, which is exactly the value its
// `--model` flag expects. Anything without that shape (banner art, warnings) is not a model.
function parseOpenCodeModels(output: string): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = []
  for (const line of plainLines(output)) {
    if (!line.includes('/') || !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/u.test(line)) continue
    pushEntry(entries, line, line)
    if (entries.length >= MODEL_CATALOG_MAX) break
  }
  return entries
}

const PROBES: Partial<Record<ProviderId, CatalogProbe>> = {
  qoder: { args: ['--list-models'], parse: parseQoderModels },
  opencode: { args: ['models'], parse: parseOpenCodeModels }
}

// Neither CLI exposes a listing command (`claude --help` only gives `--model` examples, `codex`
// only has the app-server route Etch is not allowed to use), so these degrade instead of guessing.
const UNSUPPORTED_REASONS: Partial<Record<ProviderId, string>> = {
  claude: 'claude CLI 没有列出模型的命令，请手动填写模型 ID',
  codex: 'codex CLI 没有列出模型的命令，请手动填写模型 ID'
}

export function providerSupportsModelListing(provider: ProviderId): boolean {
  return Boolean(PROBES[provider])
}

function catalog(
  provider: ProviderId,
  status: ProviderModelCatalog['status'],
  entries: ModelCatalogEntry[],
  reasonZh: string
): ProviderModelCatalog {
  return ProviderModelCatalogSchema.parse({
    provider,
    status,
    entries,
    reasonZh,
    checkedAt: new Date().toISOString()
  })
}

export async function probeModelCatalog(
  provider: ProviderId,
  executable: string | undefined,
  env: NodeJS.ProcessEnv,
  runner: ExternalProcessRunner = runProcess
): Promise<ProviderModelCatalog> {
  const probe = PROBES[provider]
  if (!probe) return catalog(provider, 'unsupported', [], UNSUPPORTED_REASONS[provider] ?? '该 CLI 无法自动列出模型，请手动填写模型 ID')
  if (!executable) return catalog(provider, 'failed', [], `未找到 ${provider} CLI，无法读取模型列表`)
  let result: ProcessResult
  try {
    result = await runner({
      command: executable,
      args: [...probe.args],
      cwd: process.cwd(),
      env,
      timeoutMs: MODEL_CATALOG_PROBE_TIMEOUT_MS,
      captureLimitBytes: MODEL_CATALOG_CAPTURE_LIMIT_BYTES
    })
  } catch (error) {
    return catalog(provider, 'failed', [], `读取 ${provider} 模型列表失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
  if (result.cancelled) return catalog(provider, 'failed', [], `${provider} 模型列表读取被中断`)
  if (result.timedOut) return catalog(provider, 'failed', [], `${provider} 模型列表读取超时`)
  if (result.exitCode !== 0) return catalog(provider, 'failed', [], `${provider} 模型列表命令返回错误，可能需要重新登录`)
  // A truncated listing looks like a short catalog, which would silently hide models.
  if (result.stdoutTruncated || result.stderrTruncated) {
    return catalog(provider, 'failed', [], `${provider} 模型列表输出超过安全上限`)
  }
  const entries = probe.parse(result.stdout)
  if (!entries.length) return catalog(provider, 'failed', [], `${provider} 模型列表无法解析，可能是 CLI 输出格式已变化`)
  return catalog(provider, 'ready', entries, `${provider} CLI 报告 ${entries.length} 个可用模型`)
}

interface CacheEntry {
  key: string
  expiresAt: number
  catalog: ProviderModelCatalog
}

// Per-provider and short-lived. The caller-supplied key invalidates on a changed path override; a
// swapped binary is covered by the TTL instead. Failed probes are cached too, otherwise every dialog
// open would re-pay a 30s timeout.
export class ModelCatalogCache {
  readonly #entries = new Map<ProviderId, CacheEntry>()
  readonly #inFlight = new Map<string, Promise<ProviderModelCatalog>>()
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? MODEL_CATALOG_TTL_MS
    this.#now = options.now ?? (() => Date.now())
  }

  async read(
    provider: ProviderId,
    key: string,
    load: () => Promise<ProviderModelCatalog>
  ): Promise<ProviderModelCatalog> {
    const cached = this.#entries.get(provider)
    if (cached && cached.key === key && cached.expiresAt > this.#now()) return cached.catalog
    const flightKey = `${provider}\0${key}`
    const pending = this.#inFlight.get(flightKey)
    if (pending) return pending
    const request = load().then((result) => {
      this.#entries.set(provider, { key, expiresAt: this.#now() + this.#ttlMs, catalog: result })
      return result
    }).finally(() => {
      this.#inFlight.delete(flightKey)
    })
    this.#inFlight.set(flightKey, request)
    return request
  }
}
