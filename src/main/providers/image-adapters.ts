import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ModelSelection, ProviderId } from '../../shared/task-schema'
import { CODEX_TEXT_ONLY_DISABLED_FEATURES, qoderNoMcpServerName } from './adapters'
import { codexSessionIdIsValid } from './session-id'

// 配图是 Etch 里唯一允许 Provider 调工具的路径。只有真的有内置图像生成能力的 Provider 才出现在选择器里：
// Qoder 走 `--tools ImageGen`，Codex 走自己的 image_generation 特性。
// Claude Code 需要外部 MCP 图像服务、OpenCode 在 Etch 中全量禁用工具，两者都不进入配图候选。
export const IMAGE_TOOL_NAME = 'ImageGen'
export const IMAGE_OUTPUT_SUBDIRECTORY = 'vibe_images'
export const IMAGE_GENERATION_SIZE = '1792x1024'
export const CODEX_IMAGE_FEATURE = 'image_generation'
// 实测：Codex 的 image_gen 走 code mode 路由，只放行 image_generation 会直接 fail closed
// （"Code Mode is unavailable because code-mode host is disabled"），所以配图档必须一并放行 code mode。
// 其余禁用项（shell、browser、plugins、skill、hooks…）全部保留。
export const CODEX_IMAGE_ALLOWED_FEATURES: readonly string[] = [
  CODEX_IMAGE_FEATURE,
  'code_mode',
  'code_mode_host',
  'code_mode_only'
]
export const QODER_IMAGE_SETTINGS = {
  disableAllHooks: true,
  skills: { enabled: false, disableShellExecution: true }
} as const
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}'

export type ImageCapability = { available: true } | { available: false; reason: string }

// 只有这两个 Provider 具备内置图像生成能力，配图选择器也只展示它们。
export const PROVIDER_IDS_FOR_IMAGES: readonly ProviderId[] = ['qoder', 'codex']

const CAPABILITIES: Record<ProviderId, ImageCapability> = {
  qoder: { available: true },
  codex: { available: true },
  claude: { available: false, reason: 'Claude Code 没有内置图像生成工具，需要外部 MCP 图像服务' },
  opencode: { available: false, reason: 'OpenCode 在 Etch 中以全量禁用工具的方式运行，没有图像工具' }
}

export function imageCapability(provider: ProviderId): ImageCapability {
  return CAPABILITIES[provider]
}

export function imageCapableProviders(): ProviderId[] {
  return PROVIDER_IDS_FOR_IMAGES.filter((provider) => CAPABILITIES[provider].available)
}

// 只允许认领当前 Codex thread 的产物，绝不能扫描包含其他会话图片的 generated_images 全局目录。
export function codexGeneratedImageThreadRoot(
  threadId: string,
  codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
): string {
  if (!codexSessionIdIsValid(threadId)) throw new Error('Codex image thread ID 必须是 UUID')
  const generatedImagesRoot = resolve(codexHome, 'generated_images')
  const threadRoot = resolve(generatedImagesRoot, threadId)
  const contained = relative(generatedImagesRoot, threadRoot)
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) {
    throw new Error('Codex image thread 目录越界')
  }
  return threadRoot
}

export function imageOutputRoots(
  provider: ProviderId,
  runDirectory: string,
  sessionId?: string,
  codexHome?: string
): string[] {
  if (provider === 'codex') {
    return sessionId ? [runDirectory, codexGeneratedImageThreadRoot(sessionId, codexHome)] : [runDirectory]
  }
  return [runDirectory, join(runDirectory, IMAGE_OUTPUT_SUBDIRECTORY)]
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

function codexImageArgs(): string[] {
  // 保留 text-only 的其余隔离，只放行图像生成所必需的特性，并把沙箱放宽到可写工作目录。
  return [
    '--sandbox', 'workspace-write',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '-c', 'web_search="disabled"',
    ...CODEX_TEXT_ONLY_DISABLED_FEATURES
      .filter((feature) => !CODEX_IMAGE_ALLOWED_FEATURES.includes(feature))
      .flatMap((feature) => ['--disable', feature])
  ]
}

export function buildImageProviderInvocation(
  request: ImageProviderRunRequest,
  executable: string
): ImageProviderInvocation {
  const capability = imageCapability(request.provider)
  if (!capability.available) throw new Error(`${request.provider} 不具备配图能力：${capability.reason}`)
  const common = { command: executable, stdin: request.prompt, env: {} as Record<string, string> }
  if (request.provider === 'codex') {
    return {
      ...common,
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        ...codexImageArgs(),
        ...(request.model.source === 'cli-default' ? [] : ['--model', request.model.modelId]),
        '-'
      ]
    }
  }
  return {
    ...common,
    args: [
      '-p', '-o', 'stream-json',
      '--bare',
      '--disable-builtin-skills',
      '--setting-sources', '',
      '--settings', JSON.stringify(QODER_IMAGE_SETTINGS),
      '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG,
      '--allowed-mcp-server-names', qoderNoMcpServerName(),
      '--tools', IMAGE_TOOL_NAME,
      '--allowed-tools', IMAGE_TOOL_NAME,
      '--permission-mode', 'dont_ask',
      '--session-id', request.sessionId,
      ...(request.model.source === 'cli-default' ? [] : ['--model', request.model.modelId])
    ]
  }
}

// 两家都自己决定文件名：Qoder 落 <cwd>/vibe_images/<name>_<ts>.png，Codex 落
// ~/.codex/generated_images/<thread>/exec-<uuid>.png（实测，cwd 里不留文件）。
// Etch 只给逻辑名，改名一律由主进程完成。
export function imageGenerationPrompt(provider: ProviderId, baseName: string, prompt: string): string {
  const call = provider === 'codex'
    ? `使用你的图像生成能力恰好生成一张图片，命名参考 "${baseName}"，尺寸 16:9（约 ${IMAGE_GENERATION_SIZE}）。`
    : `调用 ${IMAGE_TOOL_NAME} 工具恰好一次，参数 name 必须是 "${baseName}"，size 必须是 "${IMAGE_GENERATION_SIZE}"。`
  return [
    call,
    '不要调用任何其他工具，不要生成第二张图，不要询问，也不要试图移动或重命名文件。',
    '生成成功后只回复一行"done"。',
    '图片提示词如下，逐字使用其中的中文标题与标签：',
    prompt
  ].join('\n')
}
