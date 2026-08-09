import { describe, expect, it } from 'vitest'
import {
  buildProviderInvocation,
  CODEX_TEXT_ONLY_DISABLED_FEATURES,
  codexTextOnlyVersionIsSupported,
  EMPTY_MCP_CONFIG,
  OPENCODE_TEXT_ONLY_AGENT,
  OPENCODE_TEXT_ONLY_CONFIG,
  QODER_TEXT_ONLY_SETTINGS
} from '../src/main/providers/adapters'
import { codexTextOnlyExecutableIsSupported } from '../src/main/providers/codex-capability'
import {
  JsonlEventParser,
  ProviderStreamInspector
} from '../src/main/providers/jsonl'

const request = { provider: 'codex' as const, model: { source: 'cli-default' as const }, prompt: 'hello' }
const CODEX_SESSION_ID = '019f7e34-385f-7de3-9fac-40271f7a3b89'

function inspect(provider: string, stdout = '', stderr = '') {
  const inspector = new ProviderStreamInspector(provider)
  if (stdout) inspector.pushStdout(stdout)
  if (stderr) inspector.pushStderr(stderr)
  inspector.finish()
  return inspector.inspection()
}

function codexTextOnlyProtocolViolations(stdout: string): string[] {
  return inspect('codex', stdout).protocolViolations
}

function codexTextOnlyStderrViolations(stderr: string): string[] {
  return inspect('codex', '', stderr).protocolViolations
    .filter((violation) => violation.startsWith('stderr '))
    .map((violation) => violation.slice('stderr '.length))
}

function observedProviderToolEnvelopes(stdout: string): string[] {
  return inspect('claude', stdout).tools
}

function observedProviderToolDiagnostics(stderr: string): string[] {
  return inspect('claude', '', stderr).tools
}

describe('provider adapters', () => {
  it('uses pure CLI resume syntax for Codex', () => {
    const args = buildProviderInvocation({ ...request, externalSessionId: CODEX_SESSION_ID }, '/bin/codex').args
    expect(args).toContain('--ignore-user-config')
    expect(args.slice(args.indexOf('resume'))).toEqual([
      'resume', '--json', '--skip-git-repo-check', CODEX_SESSION_ID, '-'
    ])
  })
  it.each(['--last', 'thread-1', ' '])('never passes a non-UUID Codex resume value to the CLI: %j', (externalSessionId) => {
    expect(() => buildProviderInvocation({ ...request, externalSessionId }, '/bin/codex'))
      .toThrow('必须是 UUID')
  })
  it('uses the exact Claude text-only boundary for fresh and resumed sessions', () => {
    const fresh = buildProviderInvocation({ ...request, provider: 'claude' }, '/bin/claude')
    expect(fresh).toEqual({
      command: '/bin/claude',
      stdin: 'hello',
      env: {},
      args: [
        '-p', '--verbose', '--output-format', 'stream-json',
        '--safe-mode', '--disable-slash-commands', '--no-chrome',
        '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG, '--tools', '',
        '--permission-mode', 'dontAsk', '--session-id', expect.stringMatching(/^[0-9a-f-]{36}$/u)
      ]
    })

    const resumed = buildProviderInvocation({
      ...request,
      provider: 'claude',
      externalSessionId: 'claude-session'
    }, '/bin/claude')
    expect(resumed.args).toEqual([
      '-p', '--verbose', '--output-format', 'stream-json',
      '--safe-mode', '--disable-slash-commands', '--no-chrome',
      '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG, '--tools', '',
      '--permission-mode', 'dontAsk', '--resume', 'claude-session'
    ])
  })

  it('uses the exact Qoder text-only boundary for fresh and resumed sessions', () => {
    const fresh = buildProviderInvocation({ ...request, provider: 'qoder' }, '/bin/qodercli')
    expect(fresh).toEqual({
      command: '/bin/qodercli',
      stdin: 'hello',
      env: {},
      args: [
        '-p', '-o', 'stream-json', '--bare', '--disable-builtin-skills',
        '--setting-sources', '', '--settings', JSON.stringify(QODER_TEXT_ONLY_SETTINGS),
        '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG, '--tools', '',
        '--permission-mode', 'dont_ask', '--session-id', expect.stringMatching(/^[0-9a-f-]{36}$/u)
      ]
    })

    const resumed = buildProviderInvocation({
      ...request,
      provider: 'qoder',
      externalSessionId: 'qoder-session'
    }, '/bin/qodercli')
    expect(resumed.args).toEqual([
      '-p', '-o', 'stream-json', '--bare', '--disable-builtin-skills',
      '--setting-sources', '', '--settings', JSON.stringify(QODER_TEXT_ONLY_SETTINGS),
      '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG, '--tools', '',
      '--permission-mode', 'dont_ask', '-r', 'qoder-session'
    ])
  })

  it('uses the exact OpenCode text-only config for fresh and resumed sessions', () => {
    const fresh = buildProviderInvocation({ ...request, provider: 'opencode' }, '/bin/opencode')
    expect(fresh).toEqual({
      command: '/bin/opencode',
      stdin: 'hello',
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_TEXT_ONLY_CONFIG) },
      args: ['run', '--pure', '--agent', OPENCODE_TEXT_ONLY_AGENT, '--format', 'json']
    })
    expect(JSON.parse(fresh.env.OPENCODE_CONFIG_CONTENT ?? '')).toEqual(OPENCODE_TEXT_ONLY_CONFIG)

    const resumed = buildProviderInvocation({
      ...request,
      provider: 'opencode',
      externalSessionId: 'ses_existing'
    }, '/bin/opencode')
    expect(resumed.args).toEqual([
      'run', '--pure', '--agent', OPENCODE_TEXT_ONLY_AGENT, '--format', 'json', '--session', 'ses_existing'
    ])
    expect(resumed.env).toEqual({ OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_TEXT_ONLY_CONFIG) })
  })

  it('mechanically removes Codex local tools in text-only mode', () => {
    const invocation = buildProviderInvocation(request, '/bin/codex')
    expect(invocation.args).toContain('--ignore-user-config')
    expect(invocation.args).toContain('--ignore-rules')
    expect(invocation.args).toContain('--strict-config')
    expect(invocation.args.slice(invocation.args.indexOf('-c'), invocation.args.indexOf('-c') + 2)).toEqual([
      '-c',
      'web_search="disabled"'
    ])
    expect(invocation.args).toContain('standalone_web_search')
    expect(invocation.args).toContain('shell_tool')
    expect(invocation.args).toContain('unified_exec')
    expect(invocation.args).toContain('code_mode_host')
    expect(invocation.args).toContain('multi_agent')
    expect(invocation.args).toContain('read-only')
    expect(invocation.args.flatMap((arg, index) => arg === '--disable' ? [invocation.args[index + 1]] : []))
      .toEqual([...CODEX_TEXT_ONLY_DISABLED_FEATURES])
  })
  it('accepts future Codex CLI semver identities without a release allowlist', () => {
    expect(codexTextOnlyVersionIsSupported('codex-cli 0.145.0-alpha.18')).toBe(true)
    expect(codexTextOnlyVersionIsSupported('codex-cli 0.146.0-alpha.3.1')).toBe(true)
    expect(codexTextOnlyVersionIsSupported('codex-cli 0.146.0')).toBe(true)
    expect(codexTextOnlyVersionIsSupported('codex-cli 0.146.0-alpha.3.2')).toBe(true)
    expect(codexTextOnlyVersionIsSupported('codex-cli 1.2.3-beta.4+build.9')).toBe(true)
    expect(codexTextOnlyVersionIsSupported('1.2026.189 (app)')).toBe(false)
    expect(codexTextOnlyVersionIsSupported('codex-cli latest')).toBe(false)
    expect(codexTextOnlyVersionIsSupported('codex-cli 01.2.3')).toBe(false)
    expect(codexTextOnlyVersionIsSupported()).toBe(false)
    expect(codexTextOnlyExecutableIsSupported(
      'codex-cli 9.8.7',
      'a'.repeat(64)
    )).toBe(true)
    expect(codexTextOnlyExecutableIsSupported('codex-cli 9.8.7', 'a'.repeat(63))).toBe(false)
    expect(codexTextOnlyExecutableIsSupported('codex-cli 9.8.7', 'A'.repeat(64))).toBe(false)
    expect(codexTextOnlyExecutableIsSupported('codex-cli latest', 'a'.repeat(64))).toBe(false)
  })
  it('uses verbose stream-json for Claude', () => {
    const invocation = buildProviderInvocation({ ...request, provider: 'claude' }, '/bin/claude')
    expect(invocation.args).toContain('--verbose')
  })
  it('buffers partial JSONL and preserves unknown values', () => {
    const parser = new JsonlEventParser()
    expect(parser.push('{"type":"init","session_id":"abc"}\n{"mystery":')).toEqual([{ type: 'session', sessionId: 'abc' }])
    expect(parser.push('true}\n')).toEqual([{ type: 'raw', value: { mystery: true } }])
  })
  it('extracts Codex nested agent messages', () => {
    const parser = new JsonlEventParser()
    expect(parser.push('{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n')).toEqual([{ type: 'text', text: 'OK' }])
  })
  it('extracts Qoder results when every event carries the session ID', () => {
    const parser = new JsonlEventParser()
    expect(parser.push([
      '{"type":"init","session_id":"qoder-session"}',
      '{"type":"result","subtype":"success","result":"1\\t译文","session_id":"qoder-session"}'
    ].join('\n') + '\n')).toEqual([
      { type: 'session', sessionId: 'qoder-session' },
      { type: 'result', text: '1\t译文' }
    ])
  })
  it('ignores non-authoritative Claude hook session IDs around the real init event', () => {
    const parser = new JsonlEventParser()
    const events = parser.push([
      '{"type":"system","subtype":"hook_started","session_id":"temporary-hook"}',
      '{"type":"system","subtype":"hook_response","session_id":"temporary-hook"}',
      '{"type":"system","subtype":"init","session_id":"real-session"}',
      '{"type":"result","subtype":"success","result":"OK","session_id":"real-session"}'
    ].join('\n') + '\n')
    expect(events.filter((event) => event.type === 'session')).toEqual([
      { type: 'session', sessionId: 'real-session' }
    ])
  })
  it('extracts OpenCode session, text and usage from its installed JSONL shape', () => {
    const parser = new JsonlEventParser()
    const events = parser.push([
      '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}',
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"OK"}}',
      '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","tokens":{"input":2,"output":4}}}'
    ].join('\n') + '\n')
    expect(events).toEqual([
      { type: 'session', sessionId: 'ses_1' },
      { type: 'text', text: 'OK' },
      { type: 'usage', inputTokens: 2, outputTokens: 4 }
    ])
    expect(events).toContainEqual({ type: 'session', sessionId: 'ses_1' })
  })
  it('reports exact observed session evidence without inventing a requested-session fallback', () => {
    expect(inspect('claude', '{"type":"result","result":"OK"}\n').sessionIds).toEqual([])
    expect(inspect('claude', [
      '{"type":"system","subtype":"init","session_id":"one"}',
      '{"type":"system","subtype":"init","session_id":"two"}'
    ].join('\n')).sessionIds).toEqual(['one', 'two'])
  })
  it('detects tool attempts while allowing ordinary Codex reasoning and messages', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
      '{"type":"item.started","item":{"type":"web_search","query":"file:///private"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"NO_TOOL"}}',
      '{"type":"item.started","item":{"type":"apply_patch","path":"/tmp/secret"}}'
    ].join('\n') + '\n'
    expect(inspect('claude', jsonl).tools).toEqual(['web_search', 'apply_patch'])
  })
  it('detects deeply nested raw tool envelopes without scanning ordinary result text', () => {
    expect(observedProviderToolEnvelopes(JSON.stringify({
      response: { blocks: [{ kind: 'function_call', function_call: { name: 'lookup' } }] }
    }))).toEqual(['function_call'])
    expect(observedProviderToolEnvelopes(JSON.stringify({
      type: 'result_metadata', result: 'The phrase tool call is ordinary translated text.'
    }))).toEqual([])
  })
  it('detects a tool sibling even when the primary JSONL event parses as a result', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'ordinary provider text',
      metadata: { tool_call: { name: 'lookup' } }
    })
    const parser = new JsonlEventParser()
    expect(parser.push(`${line}\n`)).toEqual([{ type: 'result', text: 'ordinary provider text' }])
    expect(observedProviderToolEnvelopes(line)).toEqual(['tool_call'])
    expect(observedProviderToolEnvelopes(JSON.stringify({ type: 'result', result: 'tool_call is plain text' }))).toEqual([])
  })
  it('does not treat a Claude execution failure result as a tool attempt', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      permission_denials: []
    })
    expect(observedProviderToolEnvelopes(line)).toEqual([])
    expect(observedProviderToolEnvelopes(JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      metadata: { tool_call: { name: 'lookup' } }
    }))).toEqual(['tool_call'])
  })
  it('fails closed when a raw envelope exceeds the bounded inspection depth', () => {
    let nested: Record<string, unknown> = { value: true }
    for (let depth = 0; depth < 14; depth += 1) nested = { nested }
    expect(observedProviderToolEnvelopes(JSON.stringify(nested))).toContain('tool-envelope-inspection-limit')
  })
  it('detects Codex tool-router attempts reported only on stderr', () => {
    expect(observedProviderToolDiagnostics([
      '2026-07-20T00:00:00Z ERROR codex_core::tools::router: error=apply_patch verification failed',
      '2026-07-20T00:00:01Z WARN codex_core::tools::router: invocation rejected'
    ].join('\n'))).toEqual(['apply_patch', 'tool-router'])
    expect(observedProviderToolDiagnostics('ordinary provider diagnostic')).toEqual([])
  })
  it('fails closed on Codex text-only stderr except for frozen WebSocket transport diagnostics', () => {
    expect(codexTextOnlyStderrViolations('')).toEqual([])
    expect(codexTextOnlyStderrViolations(
      '2026-07-20T00:00:00.000000Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses\n'
    )).toEqual([])
    expect(codexTextOnlyStderrViolations(
      '2026-07-23T02:33:33.313351Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: Connection reset by peer (os error 54), url: wss://chatgpt.com/backend-api/codex/responses\n'
    )).toEqual([])
    expect(codexTextOnlyStderrViolations(
      '2026-07-23T02:33:33.313351Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: Connection reset by peer (os error 55), url: wss://chatgpt.com/backend-api/codex/responses'
    )).toEqual([])
    expect(codexTextOnlyStderrViolations(
      '2026-07-23T02:33:33.313351Z WARN codex_api::endpoint::responses_websocket: retry delayed: DNS lookup timed out, url: wss://chatgpt.com/backend-api/codex/responses'
    )).toEqual([])
    expect(codexTextOnlyStderrViolations(
      'WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)'
    )).toEqual(['line 1: unapproved stderr diagnostic'])
    expect(codexTextOnlyStderrViolations('ordinary provider diagnostic')).toEqual([
      'line 1: unapproved stderr diagnostic'
    ])
    expect(codexTextOnlyStderrViolations('WARNING shell read_file browser computer image exec function_call mcp file_change collab todo'))
      .toEqual(['line 1: unapproved stderr diagnostic'])
  })
  it('accepts the stable Codex text-only lifecycle envelope shapes', () => {
    const jsonl = [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'turn.started' },
      {
        type: 'error',
        message: 'Reconnecting... 2/5 (unexpected status 403 Forbidden: blocked, url: wss://chatgpt.com/backend-api/codex/responses)'
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'error',
          message: 'Falling back from WebSockets to HTTPS transport. unexpected status 403 Forbidden: blocked, url: wss://chatgpt.com/backend-api/codex/responses'
        }
      },
      { type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'Reasoning summary' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'OK' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 12,
          cached_input_tokens: 3,
          cache_write_input_tokens: 0,
          output_tokens: 4,
          reasoning_output_tokens: 1
        }
      }
    ].map((item) => JSON.stringify(item)).join('\n')
    expect(codexTextOnlyProtocolViolations(jsonl)).toEqual([])
  })
  it('accepts only the exact pre-turn Codex code-mode fail-closed diagnostic', () => {
    const diagnostic = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'
    const lifecycle = (message: string, afterTurn = false) => [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      ...(afterTurn
        ? [
            { type: 'turn.started' },
            { type: 'item.completed', item: { id: 'item_0', type: 'error', message } }
          ]
        : [
            { type: 'item.completed', item: { id: 'item_0', type: 'error', message } },
            { type: 'turn.started' }
          ]),
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0
        }
      }
    ].map((item) => JSON.stringify(item)).join('\n')

    const accepted = inspect('codex', lifecycle(diagnostic))
    expect(accepted).toMatchObject({
      text: 'OK',
      errors: [diagnostic],
      tools: [],
      securityViolations: [],
      protocolViolations: []
    })
    expect(codexTextOnlyProtocolViolations(lifecycle(`${diagnostic} unexpected`)))
      .toContain('line 2: unapproved error item message')
    expect(codexTextOnlyProtocolViolations(lifecycle(diagnostic, true)))
      .toContain('line 3: code mode fail-closed diagnostic is not allowed in state turn-preamble')
  })
  it('accepts a bounded multiline Cloudflare 403 retry from Codex', () => {
    const jsonl = [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'turn.started' },
      {
        type: 'error',
        message: [
          'Reconnecting... 2/5 (unexpected status 403 Forbidden: 19e9\r',
          '<html>',
          '  <head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>',
          '</html>, url: wss://chatgpt.com/backend-api/codex/responses, cf-ray: a21ac1855b1d0a9d-SIN)'
        ].join('\n')
      },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 12,
          cached_input_tokens: 3,
          cache_write_input_tokens: 0,
          output_tokens: 4,
          reasoning_output_tokens: 1
        }
      }
    ].map((item) => JSON.stringify(item)).join('\n')
    expect(codexTextOnlyProtocolViolations(jsonl)).toEqual([])
  })
  it('accepts Codex connection-reset, timeout retry, and HTTPS fallback lifecycle', () => {
    const jsonl = [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'turn.started' },
      {
        type: 'error',
        message: 'Reconnecting... 2/5 (stream disconnected before completion: Connection reset by peer (os error 54))'
      },
      {
        type: 'error',
        message: 'Reconnecting... 4/5 (request timed out)'
      },
      {
        type: 'error',
        message: 'Reconnecting... 5/5 (stream disconnected before completion: Connection reset by peer (os error 54))'
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'error',
          message: 'Falling back from WebSockets to HTTPS transport. stream disconnected before completion: Connection reset by peer (os error 54)'
        }
      },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '{"patches":[]}' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 13645,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 9,
          reasoning_output_tokens: 0
        }
      }
    ].map((item) => JSON.stringify(item)).join('\n')
    expect(codexTextOnlyProtocolViolations(jsonl)).toEqual([])
  })
  it('accepts bounded future fallback diagnostics only inside the transport envelope', () => {
    const ordinaryError = JSON.stringify({ type: 'error', message: 'request timed out' })
    const timeoutFallback = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'error',
        message: 'Falling back from WebSockets to HTTPS transport. request timed out'
      }
    })
    expect(codexTextOnlyProtocolViolations(ordinaryError)).toContain('line 1: unapproved error message')
    expect(codexTextOnlyProtocolViolations(timeoutFallback)).not.toContain('line 1: unapproved error item message')
  })
  it('accepts a future bounded network diagnostic inside the retry envelope', () => {
    const stdout = JSON.stringify({
      type: 'error',
      message: 'Reconnecting... 1/5 (TLS handshake interrupted by peer)'
    })
    expect(codexTextOnlyProtocolViolations(stdout)).not.toContain('line 1: unapproved error message')
  })
  it('accepts multiple contiguous agent messages before the single turn terminal', () => {
    const jsonl = [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'second' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0
        }
      }
    ].map((item) => JSON.stringify(item)).join('\n')
    expect(codexTextOnlyProtocolViolations(jsonl)).toEqual([])
  })
  it.each([
    ['agent message before turn', [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } },
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
      }
    ]],
    ['reasoning after agent message', [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'reasoning', text: 'late' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
      }
    ]],
    ['transport error after agent message', [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } },
      {
        type: 'error',
        message: 'Reconnecting... 2/5 (unexpected status 403 Forbidden: blocked, url: wss://chatgpt.com/backend-api/codex/responses)'
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
      }
    ]],
    ['duplicate turn terminal', [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
      }
    ]],
    ['fractional usage', [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1.5, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
      }
    ]]
  ])('rejects an invalid ordered lifecycle: %s', (_label, events) => {
    expect(codexTextOnlyProtocolViolations(events.map((item) => JSON.stringify(item)).join('\n'))).not.toEqual([])
  })
  it.each([
    ['non-JSON stdout', 'ordinary diagnostic text'],
    ['unknown top-level event', JSON.stringify({ type: 'browser_action', url: 'https://example.com' })],
    ['unknown item type', JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'capability_used', name: 'browser' } })],
    ['deep capability sibling', JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: 'OK', metadata: { TOOL_CALL: 'read_file' } }
    })],
    ['unobserved result envelope', JSON.stringify({ type: 'result', result: 'OK' })],
    ['unobserved usage envelope', JSON.stringify({ type: 'usage', input_tokens: 1, output_tokens: 1 })],
    ['unobserved turn failure', JSON.stringify({ type: 'turn.failed', error: { message: 'failed' } })],
    ['non-UUID thread', JSON.stringify({ type: 'thread.started', thread_id: '--last' })],
    ['unapproved error', JSON.stringify({ type: 'error', message: 'ordinary provider failure' })],
    ['tool-like transport error', JSON.stringify({
      type: 'error',
      message: 'Reconnecting... 2/5 (unexpected status 403 Forbidden: tool router capability, url: wss://chatgpt.com/backend-api/codex/responses)'
    })]
  ])('fails closed for %s', (_label, stdout) => {
    expect(codexTextOnlyProtocolViolations(stdout)).not.toEqual([])
  })
  it.each([
    'tool',
    'function_call',
    'web_search',
    'mcp',
    'command_execution',
    'file_change',
    'apply_patch',
    'collab',
    'todo',
    'router',
    'capability',
    'shell',
    'read_file',
    'browser',
    'computer',
    'image',
    'exec',
    'code_mode',
    'apps',
    'multi_agent',
    'fanout',
    'auth_elicitation',
    'artifact',
    'goals',
    'command',
    'action',
    'permissions'
  ])('rejects a transport fallback error containing capability marker %s', (marker) => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'error',
        message: `Falling back from WebSockets to HTTPS transport. unexpected status 403 Forbidden: ${marker}, url: wss://chatgpt.com/backend-api/codex/responses`
      }
    })
    expect(codexTextOnlyProtocolViolations(stdout)).toContain('line 1: unapproved error item message')
  })
  it.each(CODEX_TEXT_ONLY_DISABLED_FEATURES)(
    'rejects a transport fallback error containing disabled Codex feature %s',
    (feature) => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'error',
          message: `Falling back from WebSockets to HTTPS transport. unexpected status 403 Forbidden: ${feature}, url: wss://chatgpt.com/backend-api/codex/responses`
        }
      })
      expect(codexTextOnlyProtocolViolations(stdout)).toContain('line 1: unapproved error item message')
    }
  )
  it('rejects an unbounded transport fallback detail', () => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'error',
        message: `Falling back from WebSockets to HTTPS transport. ${'x'.repeat(4097)}`
      }
    })
    expect(codexTextOnlyProtocolViolations(stdout)).toContain('line 1: unapproved error item message')
  })
  it('does not pin incidental Cloudflare diagnostic fields', () => {
    const stdout = JSON.stringify({
      type: 'error',
      message: 'Reconnecting... 2/5 (unexpected status 403 Forbidden: blocked, url: wss://chatgpt.com/backend-api/codex/responses, cf-ray: not-a-ray)'
    })
    expect(codexTextOnlyProtocolViolations(stdout)).not.toContain('line 1: unapproved error message')
  })

  it('retains an early raw tool violation after much later valid output', () => {
    const inspector = new ProviderStreamInspector('codex')
    const events = [
      { type: 'thread.started', thread_id: CODEX_SESSION_ID },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'bad', type: 'browser_action', url: 'https://example.com' } },
      ...Array.from({ length: 12_000 }, (_, index) => ({
        type: 'item.completed',
        item: { id: `reasoning-${index}`, type: 'reasoning', text: 'x'.repeat(512) }
      })),
      { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'OK' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0
        }
      }
    ].map((item) => `${JSON.stringify(item)}\n`).join('')

    for (let offset = 0; offset < events.length; offset += 777) {
      inspector.pushStdout(events.slice(offset, offset + 777))
    }
    inspector.finish()
    const result = inspector.inspection()

    expect(result.tools).toContain('browser_action')
    expect(result.protocolViolations.some((item) => item.includes('unknown item type browser_action'))).toBe(true)
    expect(result.text).toBe('OK')
    expect(result.sessionIds).toEqual([CODEX_SESSION_ID])
  })

  it('fails closed when a JSONL line or accumulated result exceeds its bound', () => {
    const lineInspector = new ProviderStreamInspector('claude', 64, 1024)
    lineInspector.pushStdout(`${JSON.stringify({ type: 'result', result: 'x'.repeat(256) })}\n`)
    lineInspector.finish()
    expect(lineInspector.inspection().securityViolations).toContain('Provider JSONL 单行超过 64 bytes')

    const resultInspector = new ProviderStreamInspector('claude', 1024, 8)
    resultInspector.pushStdout(`${JSON.stringify({ type: 'result', result: '123456789' })}\n`)
    resultInspector.finish()
    expect(resultInspector.inspection().securityViolations).toContain('Provider result text 超过 8 bytes')
  })
})
