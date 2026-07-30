import type { ProviderEvent } from '../../shared/providers'
import { CODEX_TEXT_ONLY_DISABLED_FEATURES } from './adapters'
import { codexSessionIdIsValid } from './session-id'

const CAPABILITY_LIKE = /(tool|function[_ -]?call|web[_ -]?search|mcp|command|action|file[_ -]?change|apply[_ -]?patch|collab(?:oration)?|todo|router|capability|shell|read[_ -]?file|write[_ -]?file|browser|computer|image|exec|bash|zsh|terminal|plugin|hook|skill|memory|workspace|permissions?)/iu
const DISABLED_FEATURE_MARKERS = CODEX_TEXT_ONLY_DISABLED_FEATURES.map(normalizeCapabilityMarker)
const FROZEN_CAPABILITY_ALIASES = ['fanout'].map(normalizeCapabilityMarker)
const CODEX_RETRY_MESSAGE = /^Reconnecting\.\.\. [1-5]\/5 \([\s\S]{1,4096}\)$/u
const CODEX_FALLBACK_MESSAGE = /^Falling back from WebSockets to HTTPS transport\. [\s\S]{1,4096}$/u
const CODEX_ALLOWED_STDERR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z (?:ERROR|WARN) codex_api::endpoint::responses_websocket: [^\r\n]{1,4096}, url: wss:\/\/chatgpt\.com\/backend-api\/codex\/responses$/u
const NON_TOOL_EVENT_MARKERS = new Set(['error_during_execution'])
const DEFAULT_LINE_LIMIT_BYTES = 1024 * 1024
const DEFAULT_RESULT_LIMIT_BYTES = 5 * 1024 * 1024
const MAX_RECORDED_VIOLATIONS = 64

type CodexLifecycleState = 'expect-thread' | 'expect-turn' | 'turn-preamble' | 'agent-messages' | 'completed'
type CodexLifecycle = {
  state: CodexLifecycleState
  thread: number
  turnStarted: number
  turnCompleted: number
  agentMessage: number
}

export class JsonlEventParser {
  #buffer = ''

  constructor(readonly lineLimitBytes = DEFAULT_LINE_LIMIT_BYTES) {}

  push(chunk: string): ProviderEvent[] {
    this.#buffer += chunk
    const lines = this.#buffer.split(/\r?\n/)
    this.#buffer = lines.pop() ?? ''
    for (const line of lines) this.#assertBounded(line)
    this.#assertBounded(this.#buffer)
    return lines.filter(Boolean).map(parseProviderLine)
  }

  finish(): ProviderEvent[] {
    if (!this.#buffer.trim()) return []
    this.#assertBounded(this.#buffer)
    const event = parseProviderLine(this.#buffer)
    this.#buffer = ''
    return [event]
  }

  #assertBounded(line: string): void {
    if (Buffer.byteLength(line) > this.lineLimitBytes) {
      this.#buffer = ''
      throw new Error(`Provider JSONL 单行超过 ${this.lineLimitBytes} bytes`)
    }
  }
}

type ProviderStreamInspection = {
  sessionIds: string[]
  text: string
  errors: string[]
  tools: string[]
  securityViolations: string[]
  protocolViolations: string[]
}

export class ProviderStreamInspector {
  readonly #stdoutParser: JsonlEventParser
  readonly #stdoutLines: LineParser
  readonly #stderrParser: LineParser
  readonly #provider: string
  readonly #lifecycle: CodexLifecycle = {
    state: 'expect-thread',
    thread: 0,
    turnStarted: 0,
    turnCompleted: 0,
    agentMessage: 0
  }
  readonly #sessionIds = new Set<string>()
  readonly #errors: string[] = []
  readonly #tools = new Set<string>()
  readonly #securityViolations: string[] = []
  readonly #protocolViolations: string[] = []
  #text = ''
  #textBytes = 0
  #stdoutLine = 0
  #stderrLine = 0
  #finished = false
  #inspection?: ProviderStreamInspection

  constructor(
    provider: string,
    lineLimitBytes = DEFAULT_LINE_LIMIT_BYTES,
    readonly resultLimitBytes = DEFAULT_RESULT_LIMIT_BYTES
  ) {
    this.#provider = provider
    this.#stdoutParser = new JsonlEventParser(lineLimitBytes)
    this.#stdoutLines = new LineParser(lineLimitBytes)
    this.#stderrParser = new LineParser(lineLimitBytes)
  }

  pushStdout(chunk: string): ProviderEvent[] {
    if (this.#finished) return []
    let events: ProviderEvent[] = []
    try {
      events = this.#stdoutParser.push(chunk)
      for (const line of this.#stdoutLines.push(chunk)) this.#inspectStdoutLine(line)
    } catch (error) {
      this.#record(this.#securityViolations, error instanceof Error ? error.message : String(error))
    }
    for (const event of events) this.#recordEvent(event)
    return events
  }

  pushStderr(chunk: string): void {
    if (this.#finished) return
    try {
      for (const line of this.#stderrParser.push(chunk)) this.#inspectStderrLine(line)
    } catch (error) {
      this.#record(this.#securityViolations, error instanceof Error ? error.message : String(error))
    }
  }

  finish(): ProviderEvent[] {
    if (this.#finished) return []
    this.#finished = true
    let events: ProviderEvent[] = []
    try {
      const buffered = this.#stdoutParser.finish()
      events = buffered
      for (const event of buffered) this.#recordEvent(event)
      for (const line of this.#stdoutLines.finish()) this.#inspectStdoutLine(line)
    } catch (error) {
      this.#record(this.#securityViolations, error instanceof Error ? error.message : String(error))
    }
    try {
      for (const line of this.#stderrParser.finish()) this.#inspectStderrLine(line)
    } catch (error) {
      this.#record(this.#securityViolations, error instanceof Error ? error.message : String(error))
    }
    if (this.#provider === 'codex') {
      if (this.#lifecycle.thread !== 1) this.#record(this.#protocolViolations, `lifecycle: expected 1 thread.started, observed ${this.#lifecycle.thread}`)
      if (this.#lifecycle.turnStarted !== 1) this.#record(this.#protocolViolations, `lifecycle: expected 1 turn.started, observed ${this.#lifecycle.turnStarted}`)
      if (this.#lifecycle.turnCompleted !== 1) this.#record(this.#protocolViolations, `lifecycle: expected 1 turn.completed, observed ${this.#lifecycle.turnCompleted}`)
      if (this.#lifecycle.agentMessage < 1) this.#record(this.#protocolViolations, 'lifecycle: expected at least 1 agent_message')
    }
    return events
  }

  inspection(): ProviderStreamInspection {
    if (!this.#finished) this.finish()
    this.#inspection ??= {
      sessionIds: [...this.#sessionIds],
      text: this.#text.trim(),
      errors: [...this.#errors],
      tools: [...this.#tools],
      securityViolations: [...this.#securityViolations],
      protocolViolations: [...this.#protocolViolations]
    }
    return this.#inspection
  }

  #inspectStdoutLine(line: string): void {
    if (!line.trim()) return
    this.#stdoutLine += 1
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      if (this.#provider === 'codex') {
        this.#record(this.#protocolViolations, `line ${this.#stdoutLine}: non-json stdout`)
      }
      return
    }
    for (const tool of toolNamesInEnvelope(value)) this.#recordTool(tool)
    const event = parseProviderLine(line)
    for (const tool of observedProviderToolEvents([event])) this.#recordTool(tool)
    if (this.#provider === 'codex') {
      const violation = validateCodexTextOnlyEnvelope(value, this.#lifecycle)
      if (violation) this.#record(this.#protocolViolations, `line ${this.#stdoutLine}: ${violation}`)
    }
  }

  #inspectStderrLine(line: string): void {
    if (!line) return
    this.#stderrLine += 1
    for (const tool of observedProviderToolDiagnostics(line)) this.#recordTool(tool)
    if (this.#provider === 'codex'
      && (!CODEX_ALLOWED_STDERR.test(line) || containsCapabilityMarker(line))) {
      this.#record(this.#protocolViolations, `stderr line ${this.#stderrLine}: unapproved stderr diagnostic`)
    }
  }

  #recordEvent(event: ProviderEvent): void {
    if (event.type === 'session') {
      if (this.#sessionIds.size < 3 || this.#sessionIds.has(event.sessionId)) this.#sessionIds.add(event.sessionId)
      else this.#record(this.#securityViolations, 'Provider 输出报告了过多 session ID')
      return
    }
    if (event.type === 'error') {
      this.#record(this.#errors, event.message)
      return
    }
    if (event.type !== 'text' && event.type !== 'result') return
    const value = event.type === 'text' ? event.text : event.text ?? ''
    if (!value) return
    const separator = this.#text ? '\n' : ''
    const size = Buffer.byteLength(separator) + Buffer.byteLength(value)
    if (this.#textBytes + size > this.resultLimitBytes) {
      this.#record(this.#securityViolations, `Provider result text 超过 ${this.resultLimitBytes} bytes`)
      return
    }
    this.#textBytes += size
    this.#text += `${separator}${value}`
  }

  #record(target: string[], value: string): void {
    if (target.length < MAX_RECORDED_VIOLATIONS) target.push(value)
  }

  #recordTool(tool: string): void {
    if (this.#tools.size < MAX_RECORDED_VIOLATIONS || this.#tools.has(tool)) this.#tools.add(tool)
    else this.#record(this.#securityViolations, 'Provider 输出包含过多不同工具标记')
  }
}

class LineParser {
  #buffer = ''
  constructor(readonly lineLimitBytes: number) {}

  push(chunk: string): string[] {
    this.#buffer += chunk
    const lines = this.#buffer.split(/\r?\n/u)
    this.#buffer = lines.pop() ?? ''
    for (const line of lines) this.#assertBounded(line)
    this.#assertBounded(this.#buffer)
    return lines
  }

  finish(): string[] {
    if (!this.#buffer) return []
    this.#assertBounded(this.#buffer)
    const line = this.#buffer
    this.#buffer = ''
    return [line]
  }

  #assertBounded(line: string): void {
    if (Buffer.byteLength(line) > this.lineLimitBytes) {
      this.#buffer = ''
      throw new Error(`Provider diagnostic 单行超过 ${this.lineLimitBytes} bytes`)
    }
  }
}

function parseProviderLine(line: string): ProviderEvent {
  let value: unknown
  try { value = JSON.parse(line) } catch { return { type: 'raw', value: line } }
  if (!value || typeof value !== 'object') return { type: 'raw', value }
  const item = value as Record<string, unknown>
  if (item.type === 'error' || item.error) return { type: 'error', message: String(item.message ?? item.error) }
  if (item.type === 'thread.started' && typeof item.thread_id === 'string') return { type: 'session', sessionId: item.thread_id }
  if ((item.type === 'init' || (item.type === 'system' && item.subtype === 'init')) && typeof item.session_id === 'string') {
    return { type: 'session', sessionId: item.session_id }
  }
  if (item.type === 'step_start' && typeof item.sessionID === 'string') return { type: 'session', sessionId: item.sessionID }
  if (item.type === 'result') return { type: 'result', text: typeof item.result === 'string' ? item.result : undefined }
  if (item.type === 'item.completed' && item.item && typeof item.item === 'object') {
    const nested = item.item as Record<string, unknown>
    if (nested.type === 'agent_message' && typeof nested.text === 'string') return { type: 'text', text: nested.text }
    if (nested.type === 'error') return { type: 'error', message: String(nested.message ?? 'Provider error') }
  }
  const part = item.part && typeof item.part === 'object' ? item.part as Record<string, unknown> : undefined
  if (item.type === 'text' && typeof part?.text === 'string') return { type: 'text', text: part.text }
  const text = item.text ?? item.content ?? item.delta
  if (typeof text === 'string') return { type: 'text', text }
  const usage = (item.usage ?? part?.tokens ?? (item.type === 'turn.completed' ? item.usage : undefined)) as Record<string, unknown> | undefined
  if (usage) return {
    type: 'usage',
    inputTokens: numberOrUndefined(usage.input_tokens ?? usage.input),
    outputTokens: numberOrUndefined(usage.output_tokens ?? usage.output)
  }
  return { type: 'raw', value }
}

function observedProviderToolEvents(events: readonly ProviderEvent[]): string[] {
  const found = new Set<string>()
  for (const event of events) {
    if (event.type !== 'raw' || !event.value || typeof event.value !== 'object') continue
    const value = event.value as Record<string, unknown>
    const type = typeof value.type === 'string' ? value.type : ''
    const nested = value.item && typeof value.item === 'object' ? value.item as Record<string, unknown> : undefined
    const nestedType = typeof nested?.type === 'string' ? nested.type : ''
    if (type.startsWith('item.') && nestedType && !['agent_message', 'reasoning'].includes(nestedType)) {
      found.add(nestedType)
      continue
    }
    if (isToolEventMarker(type)) found.add(type)
    if (nestedType && isToolEventMarker(nestedType)) found.add(nestedType)
    for (const tool of toolNamesInEnvelope(value)) found.add(tool)
  }
  return [...found]
}

function observedProviderToolDiagnostics(stderr: string): string[] {
  const found = new Set<string>()
  for (const line of stderr.split(/\r?\n/u)) {
    if (!line.includes('codex_core::tools::router:')) continue
    const tool = line.match(/\b(?:error|tool(?:_name)?)=([a-z][a-z0-9_-]*)\b/iu)?.[1]
    found.add(tool ?? 'tool-router')
  }
  return [...found]
}

function validateCodexTextOnlyEnvelope(
  value: unknown,
  lifecycle: CodexLifecycle
): string | undefined {
  if (!isRecord(value)) return 'envelope must be an object'
  const type = value.type
  if (typeof type !== 'string') return 'envelope type must be a string'
  switch (type) {
    case 'thread.started': {
      const error = exactKeys(value, ['type', 'thread_id'])
        ?? (typeof value.thread_id === 'string' && codexSessionIdIsValid(value.thread_id)
          ? undefined
          : 'thread_id must be a UUID')
      if (error) return error
      lifecycle.thread += 1
      if (lifecycle.state !== 'expect-thread') return `thread.started is not allowed in state ${lifecycle.state}`
      lifecycle.state = 'expect-turn'
      return undefined
    }
    case 'turn.started': {
      const error = exactKeys(value, ['type'])
      if (error) return error
      lifecycle.turnStarted += 1
      if (lifecycle.state !== 'expect-turn') return `turn.started is not allowed in state ${lifecycle.state}`
      lifecycle.state = 'turn-preamble'
      return undefined
    }
    case 'turn.completed': {
      const topError = exactKeys(value, ['type', 'usage'])
      if (topError) return topError
      const usageError = validateCodexUsage(value.usage)
      if (usageError) return usageError
      lifecycle.turnCompleted += 1
      if (lifecycle.state !== 'agent-messages') return `turn.completed is not allowed in state ${lifecycle.state}`
      lifecycle.state = 'completed'
      return undefined
    }
    case 'item.completed': {
      const topError = exactKeys(value, ['type', 'item'])
      if (topError) return topError
      const itemError = validateCodexTextItem(value.item)
      if (itemError) return itemError
      if (!isRecord(value.item)) return 'item.completed item must be an object'
      if (value.item.type === 'agent_message') {
        lifecycle.agentMessage += 1
        if (lifecycle.state !== 'turn-preamble' && lifecycle.state !== 'agent-messages') {
          return `agent_message is not allowed in state ${lifecycle.state}`
        }
        lifecycle.state = 'agent-messages'
        return undefined
      }
      if (lifecycle.state !== 'turn-preamble') return `${String(value.item.type)} is not allowed in state ${lifecycle.state}`
      return undefined
    }
    case 'error': {
      const error = exactKeys(value, ['type', 'message'])
        ?? (allowedCodexTransportMessage(value.message, 'retry') ? undefined : 'unapproved error message')
      if (error) return error
      return lifecycle.state === 'turn-preamble'
        ? undefined
        : `error is not allowed in state ${lifecycle.state}`
    }
    default:
      return `unknown event type ${type}`
  }
}

function validateCodexTextItem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'item.completed item must be an object'
  const type = value.type
  if (typeof type !== 'string') return 'item.completed item type must be a string'
  if (type === 'agent_message' || type === 'reasoning') {
    const keysError = exactKeys(value, ['id', 'type', 'text'])
    if (keysError) return keysError
    if (!nonEmptyString(value.id)) return `${type} id must be a non-empty string`
    return typeof value.text === 'string' ? undefined : `${type} text must be a string`
  }
  if (type === 'error') {
    const keysError = exactKeys(value, ['id', 'type', 'message'])
    if (keysError) return keysError
    if (!nonEmptyString(value.id)) return 'error item id must be a non-empty string'
    return allowedCodexTransportMessage(value.message, 'fallback') ? undefined : 'unapproved error item message'
  }
  return `unknown item type ${type}`
}

function allowedCodexTransportMessage(message: unknown, kind: 'retry' | 'fallback'): boolean {
  if (typeof message !== 'string' || containsCapabilityMarker(message)) return false
  return kind === 'retry' ? CODEX_RETRY_MESSAGE.test(message) : CODEX_FALLBACK_MESSAGE.test(message)
}

function containsCapabilityMarker(value: string): boolean {
  const normalized = normalizeCapabilityMarker(value)
  return CAPABILITY_LIKE.test(value)
    || DISABLED_FEATURE_MARKERS.some((feature) => normalized.includes(feature))
    || FROZEN_CAPABILITY_ALIASES.some((alias) => normalized.includes(alias))
}

function isToolEventMarker(value: string): boolean {
  return !NON_TOOL_EVENT_MARKERS.has(value) && containsCapabilityMarker(value)
}

function normalizeCapabilityMarker(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[\s.-]+/gu, '_')
}

function validateCodexUsage(value: unknown): string | undefined {
  if (!isRecord(value)) return 'turn.completed usage must be an object'
  const keys = [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens'
  ]
  const keysError = exactKeys(value, keys)
  if (keysError) return keysError
  return keys.every((key) => nonNegativeInteger(value[key]))
    ? undefined
    : 'turn.completed usage values must be non-negative integers'
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): string | undefined {
  const allowed = new Set([...required, ...optional])
  const missing = required.filter((key) => !(key in value))
  const extra = Object.keys(value).filter((key) => !allowed.has(key))
  if (missing.length) return `missing field ${missing.join(', ')}`
  if (extra.length) return `unexpected field ${extra.join(', ')}`
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function toolNamesInEnvelope(root: unknown): string[] {
  const found = new Set<string>()
  const toolKey = /^(tool(?:_name|_call|_calls)?|function_call|web_search|mcp|command_execution|file_change|apply_patch)$/iu
  const visited = new WeakSet<object>()
  let inspected = 0
  const inspect = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) return
    if (depth > 12 || inspected >= 5_000) {
      found.add('tool-envelope-inspection-limit')
      return
    }
    visited.add(value)
    inspected += 1
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1)
      return
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (['type', 'subtype', 'kind'].includes(key) && typeof nested === 'string' && isToolEventMarker(nested)) found.add(nested)
      if (toolKey.test(key) && nested !== undefined && nested !== null && nested !== false && nested !== '') found.add(key)
      inspect(nested, depth + 1)
    }
  }
  inspect(root)
  return [...found]
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 ? value : undefined
}
