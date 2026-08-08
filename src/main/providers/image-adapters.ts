import type { ModelSelection, ProviderId } from '../../shared/task-schema'

// 配图是 Etch 里唯一允许 Provider 调工具的路径，所以能力必须来自实测而不是推断。
// Qoder：已实测 `--tools ImageGen` 在 headless 下能出图。
// Codex / Claude / OpenCode：Etch 没有验证过可落盘的图像路径，一律标为不可用，不留假能力。
export const IMAGE_TOOL_NAME = 'ImageGen'
export const IMAGE_OUTPUT_SUBDIRECTORY = 'vibe_images'
export const IMAGE_GENERATION_SIZE = '1792x1024'
export const QODER_IMAGE_SETTINGS = {
  disableAllHooks: true,
  skills: { enabled: false, disableShellExecution: true }
} as const
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}'

export type ImageCapability = { available: true } | { available: false; reason: string }

export const PROVIDER_IDS_FOR_IMAGES: readonly ProviderId[] = ['claude', 'codex', 'qoder', 'opencode']

const CAPABILITIES: Record<ProviderId, ImageCapability> = {
  qoder: { available: true },
  claude: { available: false, reason: 'Claude Code 没有内置图像生成工具，需要外部 MCP 图像服务' },
  codex: { available: false, reason: 'Codex 的图像生成落盘行为未在 Etch 中验证' },
  opencode: { available: false, reason: 'OpenCode 在 Etch 中以全量禁用工具的方式运行，没有图像工具' }
}

export function imageCapability(provider: ProviderId): ImageCapability {
  return CAPABILITIES[provider]
}

export function imageCapableProviders(): ProviderId[] {
  return (Object.keys(CAPABILITIES) as ProviderId[]).filter((provider) => CAPABILITIES[provider].available)
}

export interface ImageProviderRunRequest {
  provider: ProviderId
  model: ModelSelection
  prompt: string
  sessionId: string
}

export interface ImageProviderInvocation {
  command: string
  args: string[]
  stdin: string
  env: Record<string, string>
}

export function buildImageProviderInvocation(
  request: ImageProviderRunRequest,
  executable: string
): ImageProviderInvocation {
  const capability = imageCapability(request.provider)
  if (!capability.available) throw new Error(`${request.provider} 不具备配图能力：${capability.reason}`)
  const model = request.model.source === 'cli-default' ? [] : ['--model', request.model.modelId]
  return {
    command: executable,
    stdin: request.prompt,
    env: {},
    args: [
      '-p', '-o', 'stream-json',
      '--bare',
      '--disable-builtin-skills',
      '--setting-sources', '',
      '--settings', JSON.stringify(QODER_IMAGE_SETTINGS),
      '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG,
      '--tools', IMAGE_TOOL_NAME,
      '--permission-mode', 'dont_ask',
      '--session-id', request.sessionId,
      ...model
    ]
  }
}

// ImageGen 忽略绝对路径并自己加时间戳后缀，落在 <cwd>/vibe_images/<name>_<ts>.png，
// 所以 Etch 只给它一个逻辑名，实际改名由主进程完成。
export function imageGenerationPrompt(baseName: string, prompt: string): string {
  return [
    `调用 ${IMAGE_TOOL_NAME} 工具恰好一次，参数 name 必须是 "${baseName}"，size 必须是 "${IMAGE_GENERATION_SIZE}"。`,
    '不要调用任何其他工具，不要生成第二张图，不要询问，也不要试图移动或重命名文件。',
    '生成成功后只回复一行"done"。',
    '图片提示词如下，逐字使用其中的中文标题与标签：',
    prompt
  ].join('\n')
}
