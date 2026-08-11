import { describe, expect, it } from 'vitest'
import {
  QODER_RESEARCH_TOOL,
  buildResearchProviderInvocation,
  researchCapability,
  researchProducer,
  researchToolId
} from '../src/main/providers/research-adapters'
import { inspectQoderResearchStream } from '../src/main/providers/research-stream'

const SESSION = '93b6dac7-14a1-4d0a-bea5-cc417af1b586'

// 下面两段是 2026-08 用真实 qodercli 1.1.17 抓到的流，只截短了文本内容。
const SEARCHED_STREAM = [
  { type: 'system', subtype: 'init', session_id: SESSION },
  { type: 'assistant', session_id: SESSION, message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'zig official site' } }] } },
  { type: 'user', session_id: SESSION, message: { content: [{ type: 'tool_result', content: 'Web search results for query: ...' }] } },
  { type: 'result', subtype: 'success', is_error: false, session_id: SESSION, result: '{"schemaVersion":1,"claims":[]}' }
].map((event) => JSON.stringify(event)).join('\n')

// 插件带进来的 MCP 工具即使被 dont_ask 拒绝执行，也在流里留下了一次 tool_use。
const MCP_ATTEMPT_STREAM = [
  { type: 'system', subtype: 'init', session_id: SESSION },
  { type: 'assistant', session_id: SESSION, message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'x' } }] } },
  {
    type: 'assistant',
    session_id: SESSION,
    message: { content: [{ type: 'tool_use', name: 'mcp__plugin_clarify-requirements_clarification-reporter__clarify_run_info', input: {} }] }
  },
  { type: 'result', subtype: 'success', is_error: false, session_id: SESSION, result: '{"schemaVersion":1,"claims":[]}' }
].map((event) => JSON.stringify(event)).join('\n')

describe('外部核验 Provider 白名单', () => {
  it('Codex 与 Qoder 都已验证，其余 Provider 给出可读原因', () => {
    expect(researchCapability('codex')).toEqual({ available: true })
    expect(researchCapability('qoder')).toEqual({ available: true })
    for (const provider of ['claude', 'opencode'] as const) {
      const capability = researchCapability(provider)
      expect(capability.available).toBe(false)
      expect(capability.available === false && capability.reason).toContain('codex、qoder')
    }
  })

  it('按 Provider 选对 CLI 与产物 producer', () => {
    expect(researchToolId('qoder')).toBe('qoder')
    expect(researchToolId('codex')).toBe('codex')
    expect(researchProducer('qoder')).toBe('qoder-web-search-v1')
    expect(researchProducer('codex')).toBe('codex-web-search-v1')
  })
})

describe('Qoder 外部核验隔离档', () => {
  const invocation = buildResearchProviderInvocation('qoder', '/mock/qodercli', { source: 'cli-default' }, '核验提示词')

  it('只放行 WebSearch，并保留纯文本档的其余加固', () => {
    const args = invocation.args
    expect(invocation.stdin).toBe('核验提示词')
    expect(args).toContain('--bare')
    expect(args).toContain('--disable-builtin-skills')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args[args.indexOf('--tools') + 1]).toBe(QODER_RESEARCH_TOOL)
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dont_ask')
    // Etch 实际解析到 QoderWork 内置的 qodercli 1.0.45，它不认 --no-session-persistence，
    // 传了会整个打印 help 退出（实测过），所以绝不能加。
    expect(args).not.toContain('--no-session-persistence')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  // 实测踩过的坑：只给 --tools 而不给 --allowed-tools 时，dont_ask 会把 WebSearch 也拒掉，
  // 模型于是退回记忆作答，把「未核验」当成核验结果交上来。
  it('必须显式放行 WebSearch，否则搜索会被权限模式拒绝', () => {
    expect(invocation.args[invocation.args.indexOf('--allowed-tools') + 1]).toBe(QODER_RESEARCH_TOOL)
  })

  it('指定模型时透传 --model，默认模型不传', () => {
    expect(invocation.args).not.toContain('--model')
    const pinned = buildResearchProviderInvocation('qoder', '/mock/qodercli', { source: 'user-entered', modelId: 'ultimate' }, 'x')
    expect(pinned.args[pinned.args.indexOf('--model') + 1]).toBe('ultimate')
  })

  it('Codex 档保持原样，仍然只解禁 standalone_web_search', () => {
    const codex = buildResearchProviderInvocation('codex', '/mock/codex', { source: 'cli-default' }, 'x')
    expect(codex.args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(codex.args[codex.args.indexOf('-c') + 1]).toBe('web_search="live"')
    expect(codex.args).toContain('read-only')
    expect(codex.args).not.toContain('standalone_web_search')
  })
})

describe('Qoder 外部核验流观测', () => {
  it('数出真实搜索次数并取出收口文本', () => {
    const inspection = inspectQoderResearchStream(SEARCHED_STREAM)
    expect(inspection).toMatchObject({
      sessionId: SESSION,
      webSearches: 1,
      unexpectedTools: [],
      errors: []
    })
    expect(inspection.text).toBe('{"schemaVersion":1,"claims":[]}')
  })

  // 第三层防御：权限层拒绝执行还不够，出现过就得让阶段失败，不能悄悄放过。
  it('非 WebSearch 的 tool_use 即使被拒绝执行也算污染', () => {
    const inspection = inspectQoderResearchStream(MCP_ATTEMPT_STREAM)
    expect(inspection.webSearches).toBe(1)
    expect(inspection.unexpectedTools).toEqual([
      'mcp__plugin_clarify-requirements_clarification-reporter__clarify_run_info'
    ])
  })

  it('is_error 结果与非 JSON 输出都被记下来', () => {
    const failed = inspectQoderResearchStream([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION }),
      JSON.stringify({ type: 'assistant', session_id: SESSION, message: { content: [{ type: 'tool_use', name: 'WebSearch', input: {} }] } }),
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, session_id: SESSION, result: 'quota exceeded' })
    ].join('\n'))
    expect(failed.errors).toEqual(['quota exceeded'])

    const noisy = inspectQoderResearchStream(`not json\n${SEARCHED_STREAM}`)
    expect(noisy.unexpectedTools).toContain('non-json-output')
  })

  it('session 数不为 1 或 ID 非法时直接拒收', () => {
    expect(() => inspectQoderResearchStream(JSON.stringify({ type: 'result', is_error: false, result: 'x' })))
      .toThrow('必须且只能产生一个 Qoder session')
    expect(() => inspectQoderResearchStream([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION }),
      JSON.stringify({ type: 'assistant', session_id: 'another-session', message: { content: [] } })
    ].join('\n'))).toThrow('必须且只能产生一个 Qoder session')
    expect(() => inspectQoderResearchStream(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'not-a-uuid' })))
      .toThrow('Qoder session ID 无效')
  })
})
