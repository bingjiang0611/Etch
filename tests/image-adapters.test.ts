import { describe, expect, it } from 'vitest'
import { CODEX_TEXT_ONLY_DISABLED_FEATURES, buildProviderInvocation } from '../src/main/providers/adapters'
import {
  CODEX_IMAGE_ALLOWED_FEATURES,
  IMAGE_GENERATION_SIZE,
  IMAGE_OUTPUT_SUBDIRECTORY,
  IMAGE_TOOL_NAME,
  PROVIDER_IDS_FOR_IMAGES,
  buildImageProviderInvocation,
  codexGeneratedImageThreadRoot,
  imageCapability,
  imageCapableProviders,
  imageGenerationPrompt,
  imageOutputRoots
} from '../src/main/providers/image-adapters'
import { ImageStreamReader } from '../src/main/providers/image-stream'

const SESSION = '9f3f1f1e-0000-4000-8000-000000000000'

describe('配图能力白名单', () => {
  it('只展示有内置图像生成能力的 Qoder 与 Codex', () => {
    expect([...PROVIDER_IDS_FOR_IMAGES]).toEqual(['qoder', 'codex'])
    expect(imageCapableProviders()).toEqual(['qoder', 'codex'])
  })

  it('Claude 与 OpenCode 不具备配图能力并给出原因', () => {
    for (const provider of ['claude', 'opencode'] as const) {
      const capability = imageCapability(provider)
      expect(capability.available).toBe(false)
      if (!capability.available) expect(capability.reason.length).toBeGreaterThan(0)
    }
  })

  it('对不具备配图能力的 Provider 直接拒绝构造调用', () => {
    for (const provider of ['claude', 'opencode'] as const) {
      expect(() => buildImageProviderInvocation(
        { provider, model: { source: 'cli-default' }, prompt: 'x', sessionId: SESSION },
        '/usr/local/bin/cli'
      )).toThrow('不具备配图能力')
    }
  })

  it('Qoder 保持扫描 run 目录与 vibe_images', () => {
    expect(imageOutputRoots('qoder', '/run')).toEqual(['/run', `/run/${IMAGE_OUTPUT_SUBDIRECTORY}`])
  })

  it('Codex 只扫描指定 UUID thread，不暴露 generated_images 全局根', () => {
    expect(imageOutputRoots('codex', '/run', SESSION, '/custom/codex')).toEqual([
      '/run',
      `/custom/codex/generated_images/${SESSION}`
    ])
    expect(codexGeneratedImageThreadRoot(SESSION, '/home/.codex'))
      .toBe(`/home/.codex/generated_images/${SESSION}`)
  })

  it('Codex 支持 CODEX_HOME，缺少 session 时不返回全局图片根', () => {
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = '/custom/from-env'
    try {
      expect(codexGeneratedImageThreadRoot(SESSION)).toBe(`/custom/from-env/generated_images/${SESSION}`)
      expect(imageOutputRoots('codex', '/run')).toEqual(['/run'])
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previous
    }
  })

  it.each(['not-a-uuid', '../generated_images', `${SESSION}/../../other`])(
    '拒绝非法或路径穿越 thread ID: %s',
    (threadId) => {
      expect(() => codexGeneratedImageThreadRoot(threadId, '/home/.codex')).toThrow('必须是 UUID')
      expect(() => imageOutputRoots('codex', '/run', threadId, '/home/.codex')).toThrow('必须是 UUID')
    }
  )

  it('Codex roots 不包含 generated_images 全局目录', () => {
    const roots = imageOutputRoots('codex', '/run', SESSION, '/home/.codex')
    expect(roots).not.toContain('/home/.codex/generated_images')
  })
})

describe('配图调用档', () => {
  const invocation = buildImageProviderInvocation(
    { provider: 'qoder', model: { source: 'cli-default' }, prompt: 'prompt', sessionId: SESSION },
    '/usr/local/bin/qodercli'
  )

  it('只放行图像工具，同时保留 hook、skill、MCP 隔离', () => {
    expect(invocation.args).toContain('--tools')
    expect(invocation.args[invocation.args.indexOf('--tools') + 1]).toBe(IMAGE_TOOL_NAME)
    expect(invocation.args).toContain('--strict-mcp-config')
    expect(invocation.args[invocation.args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
    expect(invocation.args).toContain('--disable-builtin-skills')
    expect(invocation.args[invocation.args.indexOf('--settings') + 1]).toContain('"disableAllHooks":true')
    expect(invocation.args).toContain('--session-id')
    expect(invocation.stdin).toBe('prompt')
  })

  it('模型选择为 cli-default 时不传 --model', () => {
    expect(invocation.args).not.toContain('--model')
    const withModel = buildImageProviderInvocation(
      { provider: 'qoder', model: { source: 'user-entered', modelId: 'sonnet' }, prompt: 'p', sessionId: SESSION },
      '/usr/local/bin/qodercli'
    )
    expect(withModel.args.slice(-2)).toEqual(['--model', 'sonnet'])
  })

  it('纯文本翻译路径不受影响，仍然禁用全部工具与图像生成', () => {
    const textOnly = buildProviderInvocation(
      { provider: 'qoder', model: { source: 'cli-default' }, prompt: 'p' },
      '/usr/local/bin/qodercli'
    )
    expect(textOnly.args[textOnly.args.indexOf('--tools') + 1]).toBe('')
    expect(textOnly.args).not.toContain(IMAGE_TOOL_NAME)
    expect(CODEX_TEXT_ONLY_DISABLED_FEATURES).toContain('image_generation')
  })

  it('提示词只要求生成一次，并锁定逻辑名与尺寸', () => {
    const prompt = imageGenerationPrompt('qoder', '00-cover', '画一张封面')
    expect(prompt).toContain(`name 必须是 "00-cover"`)
    expect(prompt).toContain(IMAGE_GENERATION_SIZE)
    expect(prompt).toContain('不要调用任何其他工具')
    const codexPrompt = imageGenerationPrompt('codex', '00-cover', '画一张封面')
    expect(codexPrompt).toContain('00-cover')
    expect(codexPrompt).toContain('不要生成第二张图')
  })
})

describe('Codex 配图调用档', () => {
  const invocation = buildImageProviderInvocation(
    { provider: 'codex', model: { source: 'cli-default' }, prompt: 'prompt', sessionId: SESSION },
    '/usr/local/bin/codex'
  )

  it('只放行图像生成所必需的特性，其余 text-only 禁用项全部保留', () => {
    expect(invocation.args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check'])
    // 实测：Codex 的 image_gen 走 code mode，不放行就会 fail closed。
    expect([...CODEX_IMAGE_ALLOWED_FEATURES]).toEqual(['image_generation', 'code_mode', 'code_mode_host', 'code_mode_only'])
    for (const feature of CODEX_IMAGE_ALLOWED_FEATURES) {
      expect(invocation.args).not.toContain(feature)
    }
    for (const feature of CODEX_TEXT_ONLY_DISABLED_FEATURES) {
      if (CODEX_IMAGE_ALLOWED_FEATURES.includes(feature)) continue
      expect(invocation.args).toContain(feature)
    }
    // shell、browser、plugins、skill 等高风险特性不得因为配图而被放行。
    for (const feature of ['shell_tool', 'browser_use', 'plugins', 'skill_search', 'hooks']) {
      expect(invocation.args).toContain(feature)
    }
    expect(invocation.args).toContain('--ignore-user-config')
    expect(invocation.args).toContain('--strict-config')
    expect(invocation.args[invocation.args.indexOf('-c') + 1]).toBe('web_search="disabled"')
  })

  it('沙箱放宽到可写工作目录，并从 stdin 读 prompt', () => {
    expect(invocation.args[invocation.args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    expect(invocation.args).not.toContain('read-only')
    expect(invocation.args.at(-1)).toBe('-')
    expect(invocation.stdin).toBe('prompt')
  })

  it('指定模型时才传 --model', () => {
    expect(invocation.args).not.toContain('--model')
    const withModel = buildImageProviderInvocation(
      { provider: 'codex', model: { source: 'user-entered', modelId: 'gpt-5' }, prompt: 'p', sessionId: SESSION },
      '/usr/local/bin/codex'
    )
    expect(withModel.args.slice(-3)).toEqual(['--model', 'gpt-5', '-'])
  })
})

describe('配图输出流审计', () => {
  it('收集 session 与结果文本，只调 ImageGen 时不算越界', () => {
    const reader = new ImageStreamReader()
    reader.push(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION })}\n`)
    reader.push(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ImageGen' }] } })}\n`)
    reader.push(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`)
    reader.finish()
    const inspection = reader.inspection()
    expect(inspection.sessionIds).toEqual([SESSION])
    expect(inspection.tools).toEqual([IMAGE_TOOL_NAME])
    expect(inspection.unexpectedTools).toEqual([])
    expect(inspection.text).toBe('done')
  })

  it('出现图像工具以外的工具调用会被记为越界', () => {
    const reader = new ImageStreamReader()
    reader.push(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } })}\n`)
    reader.finish()
    expect(reader.inspection().unexpectedTools).toContain('Bash')
  })

  it('Qoder 必须恰好调用一次 ImageGen', () => {
    const missing = new ImageStreamReader()
    missing.push(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`)
    missing.finish()
    expect(missing.inspection().unexpectedTools).toContain('ImageGen-call-count')

    const duplicate = new ImageStreamReader()
    for (let index = 0; index < 2; index += 1) {
      duplicate.push(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ImageGen' }] } })}\n`)
    }
    duplicate.finish()
    expect(duplicate.inspection().unexpectedTools).toContain('ImageGen-call-count')
  })

  it('接受一次完整的 Codex image_generation 生命周期', () => {
    const reader = new ImageStreamReader()
    for (const event of [
      { type: 'thread.started', thread_id: SESSION },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'image-1', type: 'image_generation' } },
      { type: 'item.completed', item: { id: 'image-1', type: 'image_generation' } },
      { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
    ]) reader.push(`${JSON.stringify(event)}\n`)
    reader.finish()

    expect(reader.inspection()).toMatchObject({
      sessionIds: [SESSION],
      text: 'done',
      tools: ['image_generation'],
      unexpectedTools: []
    })
  })

  it.each(['command_execution', 'file_change', 'apply_patch'])(
    '拒绝 Codex 越权 item：%s',
    (type) => {
      const reader = new ImageStreamReader()
      reader.push(`${JSON.stringify({ type: 'thread.started', thread_id: SESSION })}\n`)
      reader.push(`${JSON.stringify({ type: 'item.started', item: { id: 'bad-1', type } })}\n`)
      reader.finish()
      expect(reader.inspection().unexpectedTools).toContain(type)
    }
  )

  it('拒绝缺失、重复或 ID 不匹配的 Codex image_generation 生命周期', () => {
    const missing = new ImageStreamReader()
    missing.push(`${JSON.stringify({ type: 'thread.started', thread_id: SESSION })}\n`)
    missing.finish()
    expect(missing.inspection().unexpectedTools).toContain('image_generation-lifecycle')

    const mismatched = new ImageStreamReader()
    mismatched.push(`${JSON.stringify({ type: 'thread.started', thread_id: SESSION })}\n`)
    mismatched.push(`${JSON.stringify({ type: 'item.started', item: { id: 'image-1', type: 'image_generation' } })}\n`)
    mismatched.push(`${JSON.stringify({ type: 'item.completed', item: { id: 'image-2', type: 'image_generation' } })}\n`)
    mismatched.finish()
    expect(mismatched.inspection().unexpectedTools).toContain('image_generation-lifecycle')
  })

  it.each([
    ['jsonl-line-bytes-limit', { lineBytes: 8, totalBytes: 100 }, '{"long":true}\n'],
    ['jsonl-event-count-limit', { events: 1, totalBytes: 100 }, '{}\n{}\n'],
    ['jsonl-total-bytes-limit', { totalBytes: 4 }, '{}\n{}\n']
  ] as const)('对 %s fail closed', (marker, limits, stream) => {
    const reader = new ImageStreamReader(limits)
    reader.push(stream)
    reader.finish()
    expect(reader.inspection().unexpectedTools).toContain(marker)
  })
})
