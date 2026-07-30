import type { ProviderInvocation, ProviderRunRequest } from '../../shared/providers'
import { codexSessionIdIsValid } from './session-id'

export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}'
export const QODER_TEXT_ONLY_SETTINGS = {
  disableAllHooks: true,
  skills: { enabled: false, disableShellExecution: true }
} as const
export const OPENCODE_TEXT_ONLY_AGENT = 'etch-text-only'
export const OPENCODE_TEXT_ONLY_CONFIG = {
  autoupdate: false,
  snapshot: false,
  share: 'disabled',
  plugin: [],
  instructions: [],
  mcp: {},
  permission: { '*': 'deny' },
  tools: { '*': false },
  agent: {
    [OPENCODE_TEXT_ONLY_AGENT]: {
      description: 'Etch text-only translation session',
      mode: 'primary',
      permission: { '*': 'deny' },
      tools: { '*': false }
    }
  },
  default_agent: OPENCODE_TEXT_ONLY_AGENT
} as const

export function codexTextOnlyVersionIsSupported(version?: string): boolean {
  return /^codex-cli (?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
    .test(version ?? '')
}

export const CODEX_TEXT_ONLY_DISABLED_FEATURES = [
  'shell_tool',
  'shell_zsh_fork',
  'unified_exec',
  'unified_exec_zsh_fork',
  'shell_snapshot',
  'deferred_executor',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'apps',
  'enable_mcp_apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'computer_use',
  'multi_agent',
  'multi_agent_v2',
  'enable_fanout',
  'plugins',
  'plugin_sharing',
  'remote_plugin',
  'workspace_dependencies',
  'skill_search',
  'skill_mcp_dependency_install',
  'tool_suggest',
  'tool_call_mcp_elicitation',
  'auth_elicitation',
  'image_generation',
  'artifact',
  'hooks',
  'goals',
  'request_permissions_tool',
  'standalone_web_search'
] as const

function modelArgs(request: ProviderRunRequest, flag: string): string[] {
  return request.model.source === 'cli-default' ? [] : [flag, request.model.modelId]
}

function claudeTextOnlyArgs(): string[] {
  return [
    '--safe-mode', '--disable-slash-commands', '--no-chrome',
    '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG, '--tools', '',
    '--permission-mode', 'dontAsk'
  ]
}

function qoderTextOnlyArgs(): string[] {
  return [
    '--bare',
    '--disable-builtin-skills',
    '--setting-sources', '',
    '--settings', JSON.stringify(QODER_TEXT_ONLY_SETTINGS),
    '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG, '--tools', '',
    '--permission-mode', 'dont_ask'
  ]
}

function codexTextOnlyArgs(): string[] {
  return [
    '--sandbox', 'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '-c', 'web_search="disabled"',
    ...CODEX_TEXT_ONLY_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature])
  ]
}

export function buildProviderInvocation(request: ProviderRunRequest, executable: string): ProviderInvocation {
  const session = request.externalSessionId
  const common = { command: executable, stdin: request.prompt, env: {} as Record<string, string> }
  switch (request.provider) {
    case 'claude': return { ...common, args: session
      ? ['-p', '--verbose', '--output-format', 'stream-json', ...claudeTextOnlyArgs(), '--resume', session, ...modelArgs(request, '--model')]
      : ['-p', '--verbose', '--output-format', 'stream-json', ...claudeTextOnlyArgs(), '--session-id', crypto.randomUUID(), ...modelArgs(request, '--model')] }
    case 'codex': {
      if (session && !codexSessionIdIsValid(session)) {
        throw new Error('Codex external session ID 必须是 UUID')
      }
      const isolation = codexTextOnlyArgs()
      return { ...common, args: session
        ? ['exec', ...isolation, 'resume', '--json', '--skip-git-repo-check', ...modelArgs(request, '--model'), session, '-']
        : ['exec', '--json', '--skip-git-repo-check', ...isolation, ...modelArgs(request, '--model'), '-'] }
    }
    case 'qoder': return { ...common, args: session
      ? ['-p', '-o', 'stream-json', ...qoderTextOnlyArgs(), '-r', session, ...modelArgs(request, '--model')]
      : ['-p', '-o', 'stream-json', ...qoderTextOnlyArgs(), '--session-id', crypto.randomUUID(), ...modelArgs(request, '--model')] }
    case 'opencode': {
      return {
        ...common,
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_TEXT_ONLY_CONFIG) },
        args: [
          'run',
          '--pure', '--agent', OPENCODE_TEXT_ONLY_AGENT,
          '--format', 'json',
          ...(session ? ['--session', session] : []),
          ...modelArgs(request, '--model')
        ]
      }
    }
  }
}
