import type { ModelSelection, ProviderId } from '../../shared/task-schema'
import type { ToolId } from '../../shared/settings-schema'
import {
  CODEX_TEXT_ONLY_DISABLED_FEATURES,
  EMPTY_MCP_CONFIG,
  QODER_TEXT_ONLY_SETTINGS,
  qoderNoMcpServerName
} from './adapters'

export type ResearchCapability = { available: true } | { available: false; reason: string }

// 外部核验是纯文本隔离的唯一例外：必须只放行 Web Search，其余工具一个都不能留。
// 白名单只收实测验证过的 Provider——2026-08 实测 Codex `exec` 与 Qoder `--tools WebSearch`
// 两个档都满足「只开搜索、其余全按住」。
const RESEARCH_PROVIDERS: readonly ProviderId[] = ['codex', 'qoder']

// Qoder 的内建工具名；`--tools` 收窄可用工具，`--allowed-tools` 决定哪个能真的执行。
// 实测：只给 `--tools WebSearch` 时 Bash/Edit/Write/Agent/ImageGen 这些内建工具直接不存在；
// 插件 MCP 另由 server allowlist 从模型可见集合中移除，观测层再核对 init 白名单。
export const QODER_RESEARCH_TOOL = 'WebSearch'

export function researchCapability(provider: ProviderId): ResearchCapability {
  return RESEARCH_PROVIDERS.includes(provider)
    ? { available: true }
    : { available: false, reason: `当前仅 ${RESEARCH_PROVIDERS.join('、')} 的隔离 Web Search 档已验证` }
}

export function researchToolId(provider: ProviderId): ToolId {
  return provider === 'qoder' ? 'qoder' : 'codex'
}

export function researchProducer(provider: ProviderId): string {
  return `${provider}-web-search-v1`
}

export function buildResearchProviderInvocation(
  provider: ProviderId,
  executable: string,
  model: ModelSelection,
  prompt: string
): { command: string; args: string[]; stdin: string; env: Record<string, string> } {
  const common = { command: executable, stdin: prompt, env: {} as Record<string, string> }
  if (provider === 'qoder') {
    return {
      ...common,
      args: [
        '-p', '-o', 'stream-json',
        // 与纯文本档同源的加固：无 skill、无 hook、不读用户/项目设置、空 MCP。
        '--bare',
        '--disable-builtin-skills',
        '--setting-sources', '',
        '--settings', JSON.stringify(QODER_TEXT_ONLY_SETTINGS),
        '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG,
        '--allowed-mcp-server-names', qoderNoMcpServerName(),
        // 只留 WebSearch 并显式放行；缺了 --allowed-tools 时 dont_ask 会把搜索也拒掉，
        // 模型就会退回记忆作答并把未核验内容当成核验结果。
        '--tools', QODER_RESEARCH_TOOL,
        '--allowed-tools', QODER_RESEARCH_TOOL,
        '--permission-mode', 'dont_ask',
        ...(model.source === 'cli-default' ? [] : ['--model', model.modelId])
      ]
    }
  }
  return {
    ...common,
    args: [
      'exec', '--json', '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--ignore-user-config', '--ignore-rules', '--strict-config',
      '-c', 'web_search="live"',
      ...CODEX_TEXT_ONLY_DISABLED_FEATURES
        .filter((feature) => feature !== 'standalone_web_search')
        .flatMap((feature) => ['--disable', feature]),
      ...(model.source === 'cli-default' ? [] : ['--model', model.modelId]),
      '-'
    ]
  }
}
