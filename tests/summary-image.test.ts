import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CODEX_TEXT_ONLY_DISABLED_FEATURES, buildProviderInvocation } from '../src/main/providers/adapters'
import {
  IMAGE_GENERATION_SIZE,
  IMAGE_TOOL_NAME,
  buildImageProviderInvocation,
  imageCapability,
  imageCapableProviders,
  imageGenerationPrompt
} from '../src/main/providers/image-adapters'
import { ImageStreamReader } from '../src/main/providers/image-stream'
import { assertImageUsable, imageIssues, pngDimensions } from '../src/core/png'

const SESSION = '9f3f1f1e-0000-4000-8000-000000000000'

function png(width: number, height: number, padding = 0): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length, 0)
    return Buffer.concat([length, Buffer.from(type, 'ascii'), body, Buffer.alloc(4)])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(padding ? randomBytes(padding) : Buffer.alloc(0))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

describe('配图能力白名单', () => {
  it('只有实测通过的 Provider 可用，其余给出原因而不是假能力', () => {
    expect(imageCapableProviders()).toEqual(['qoder'])
    for (const provider of ['claude', 'codex', 'opencode'] as const) {
      const capability = imageCapability(provider)
      expect(capability.available).toBe(false)
      if (!capability.available) expect(capability.reason.length).toBeGreaterThan(0)
    }
  })

  it('对不具备配图能力的 Provider 直接拒绝构造调用', () => {
    for (const provider of ['claude', 'codex', 'opencode'] as const) {
      expect(() => buildImageProviderInvocation(
        { provider, model: { source: 'cli-default' }, prompt: 'x', sessionId: SESSION },
        '/usr/local/bin/cli'
      )).toThrow('不具备配图能力')
    }
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
    const prompt = imageGenerationPrompt('00-cover', '画一张封面')
    expect(prompt).toContain(`name 必须是 "00-cover"`)
    expect(prompt).toContain(IMAGE_GENERATION_SIZE)
    expect(prompt).toContain('不要调用任何其他工具')
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
    expect(reader.inspection().unexpectedTools).toEqual(['Bash'])
  })
})

describe('配图文件验收', () => {
  it('读出 PNG 尺寸并接受实测的 1792×1024 与 1376×768', () => {
    expect(pngDimensions(png(1792, 1024, 20_000))).toEqual({ width: 1792, height: 1024 })
    expect(imageIssues(png(1792, 1024, 20_000))).toEqual([])
    expect(imageIssues(png(1376, 768, 20_000))).toEqual([])
  })

  it('拒绝非 PNG、过小与非 16:9 的产物', () => {
    expect(imageIssues(Buffer.alloc(20_000)).join('；')).toContain('不是合法 PNG')
    expect(imageIssues(png(1792, 1024)).join('；')).toContain('小于 10 KB')
    expect(imageIssues(png(1024, 1024, 20_000)).join('；')).toContain('不是 16:9')
    expect(() => assertImageUsable('00-cover.png', png(1024, 1024, 20_000))).toThrow('未通过配图验收')
  })
})
