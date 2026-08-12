import type { ProviderEvent } from '../../shared/providers'
import { CODEX_TEXT_ONLY_DISABLED_FEATURES } from './adapters'
import { codexSessionIdIsValid } from './session-id'

const CAPABILITY_LIKE = /(tool|function[_ -]?call|web[_ -]?search|mcp|command|action|file[_ -]?change|apply[_ -]?patch|collab(?:oration)?|todo|router|capability|shell|read[_ -]?file|write[_ -]?file|browser|computer|image|exec|bash|zsh|terminal|plugin|hook|skill|memory|workspace|permissions?)/iu
const DISABLED_FEATURE_MARKERS = CODEX_TEXT_ONLY_DISABLED_FEATURES.map(normalizeCapabilityMarker)
const FROZEN_CAPABILITY_ALIASES = ['fanout'].map(normalizeCapabilityMarker)
const CODEX_RETRY_MESSAGE = /^Reconnecting\.\.\. [1-5]\/5 \([\s\S]{1,4096}\)$/u
const CODEX_FALLBACK_MESSAGE = /^Falling back from WebSockets to HTTPS transport\. [\s\S]{1,4096}$/u
const CODEX_CODE_MODE_FAIL_CLOSED_MESSAGE = /^Code Mode is unavailable because code-mode host is disabled\. Code mode will fail closed; enable `features\.code_mode_host` and install `codex-code-mode-host`\.$/u
const CODEX_MODEL_METADATA_FALLBACK_MESSAGE = /^Model metadata for `[A-Za-z0-9][A-Za-z0-9._/-]{0,63}` not found\. Defaulting to fallback metadata\.$/u
const CODEX_ALLOWED_STDERR = [
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z (?:ERROR|WARN) codex_api::endpoint::responses_websocket: [^\r\n]{1,4096}, url: wss:\/\/chatgpt\.com\/backend-api\/codex\/responses$/u,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z (?:ERROR|WARN) codex_models_manager::manager: failed to refresh available models: [^\r\n]{1,4096}$/u
]
const STDERR_SUMMARY_LIMIT = 200
const NON_TOOL_EVENT_MARKERS = new Set(['error_during_execution'])
const DEFAULT_LINE_LIMIT_BYTES = 1024 * 1024
const DEFAULT_RESULT_LIMIT_BYTES = 5 * 1024 * 1024
const MAX_RECORDED_VIOLATIONS = 64

type CodexLifecycleState = 'expect-thread' | 'expect-turn' | 'turn-preamble' | 'agent-messages' | 'completed' | 'failed'
type CodexStreamMessage = { line: number; message: string }
type CodexLifecycle = {
  state: CodexLifecycleState
  thread: number
  turnStarted: number
  turnCompleted: number
  turnFailed: number
  agentMessage: number
  deferredErrors: CodexStreamMessage[]
  turnFailures: CodexStreamMessage[]
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
    turnFailed: 0,
    agentMessage: 0,
    deferredErrors: [],
    turnFailures: []
  }
  readonly #sessionIds = new Set<string>()
  readonly #errors: string[] = []
  readonly #tools = new Set<string>()
  readonly #securityViolations: string[] = []
  readonly #protocolViolations: string[] = []
  readonly #qoderToolUseIds = new Set<string>()
  #text = ''
  #textBytes = 0
  #stdoutLine = 0
  #stderrLine = 0
  #qoderInitCount = 0
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
      for (const violation of unconfirmedCodexTopLevelErrors(this.#lifecycle)) this.#record(this.#protocolViolations, violation)
      if (this.#lifecycle.thread !== 1) this.#record(this.#protocolViolations, `lifecycle: expected 1 thread.started, observed ${this.#lifecycle.thread}`)
      if (this.#lifecycle.turnStarted !== 1) this.#record(this.#protocolViolations, `lifecycle: expected 1 turn.started, observed ${this.#lifecycle.turnStarted}`)
      if (this.#lifecycle.turnFailed > 0) {
        // turn.failed 是合法终态：真实调用失败（例如模型不可用）不该按缺 turn.completed / agent_message 记成协议违规，
        // 失败详情已经进了 errors，让上层报可读失败。但终态必须唯一、与 turn.completed 互斥，
        // 且不能把这条流上已经记下的违规洗掉。
        if (this.#lifecycle.turnFailed !== 1) this.#record(this.#protocolViolations, `lifecycle: expected 1 turn.failed, observed ${this.#lifecycle.turnFailed}`)
        if (this.#lifecycle.turnCompleted !== 0) this.#record(this.#protocolViolations, `lifecycle: turn.failed and turn.completed are mutually exclusive, observed ${this.#lifecycle.turnCompleted} turn.completed`)
        if (this.#lifecycle.state !== 'failed') this.#record(this.#protocolViolations, `lifecycle: expected terminal state failed, observed ${this.#lifecycle.state}`)
      } else {
        if (this.#lifecycle.turnCompleted !== 1) this.#record(this.#protocolViolations, `lifecycle: expected 1 turn.completed, observed ${this.#lifecycle.turnCompleted}`)
        if (this.#lifecycle.agentMessage < 1) this.#record(this.#protocolViolations, 'lifecycle: expected at least 1 agent_message')
      }
    }
    if (this.#provider === 'qoder' && this.#qoderInitCount !== 1) {
      this.#record(this.#securityViolations, `Qoder 纯文本调用必须且只能报告一次 init，实际 ${this.#qoderInitCount}`)
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
    if (this.#provider === 'qoder') {
      if (isQoderInit(value)) this.#qoderInitCount += 1
      for (const violation of qoderTextOnlyInitViolations(value)) {
        this.#record(this.#securityViolations, violation)
      }
      for (const violation of qoderToolResultViolations(value, this.#qoderToolUseIds)) {
        this.#record(this.#securityViolations, violation)
      }
    }
    const ignoreToolResults = this.#provider === 'qoder'
    for (const tool of toolNamesInEnvelope(value, ignoreToolResults)) this.#recordTool(tool)
    const event = parseProviderLine(line)
    for (const tool of observedProviderToolEvents([event], ignoreToolResults)) this.#recordTool(tool)
    if (this.#provider === 'codex') {
      const violation = validateCodexTextOnlyEnvelope(value, this.#lifecycle, this.#stdoutLine)
      if (violation) this.#record(this.#protocolViolations, `line ${this.#stdoutLine}: ${violation}`)
    }
  }

  #inspectStderrLine(line: string): void {
    if (!line) return
    this.#stderrLine += 1
    for (const tool of observedProviderToolDiagnostics(line)) this.#recordTool(tool)
    if (this.#provider === 'codex'
      && (!CODEX_ALLOWED_STDERR.some((pattern) => pattern.test(line)) || containsCapabilityMarker(line))) {
      this.#record(
        this.#protocolViolations,
        `stderr line ${this.#stderrLine}: unapproved stderr diagnostic: ${safeStderrSummary(line)}`
      )
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
    const bounded = tool.slice(0, 200)
    if (this.#tools.size < MAX_RECORDED_VIOLATIONS || this.#tools.has(bounded)) this.#tools.add(bounded)
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

export function parseProviderLine(line: string): ProviderEvent {
  let value: unknown
  try { value = JSON.parse(line) } catch { return { type: 'raw', value: line } }
  if (!value || typeof value !== 'object') return { type: 'raw', value }
  const item = value as Record<string, unknown>
  if (item.type === 'turn.failed') {
    const failure = isRecord(item.error) ? item.error.message : item.error
    return { type: 'error', message: String(failure ?? 'Provider turn failed') }
  }
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

function observedProviderToolEvents(events: readonly ProviderEvent[], ignoreToolResults = false): string[] {
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
    for (const tool of toolNamesInEnvelope(value, ignoreToolResults)) found.add(tool)
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
  lifecycle: CodexLifecycle,
  line: number
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
      if (isCodexCodeModeFailClosedItem(value.item)) {
        return lifecycle.state === 'expect-turn'
          ? undefined
          : `code mode fail-closed diagnostic is not allowed in state ${lifecycle.state}`
      }
      if (isCodexModelMetadataFallbackItem(value.item)) {
        return lifecycle.state === 'expect-turn'
          ? undefined
          : `model metadata fallback diagnostic is not allowed in state ${lifecycle.state}`
      }
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
    case 'turn.failed': {
      const keysError = exactKeys(value, ['type', 'error'])
        ?? validateCodexTurnFailure(value.error)
      if (keysError) return keysError
      lifecycle.turnFailed += 1
      if (lifecycle.state !== 'turn-preamble' && lifecycle.state !== 'agent-messages') {
        return `turn.failed is not allowed in state ${lifecycle.state}`
      }
      lifecycle.state = 'failed'
      recordCodexTurnFailure(lifecycle, line, value.error)
      return undefined
    }
    case 'error': {
      const keysError = exactKeys(value, ['type', 'message'])
      if (keysError) return keysError
      if (!allowedCodexTransportMessage(value.message, 'retry')) {
        // Codex 会在 turn.failed 之前把同一条失败详情先发一遍顶层 error。判违规要等终态：
        // 只有随后唯一一条合法 turn.failed 逐字复述同一条 message 才算这条预告，否则仍是协议违规。
        return lifecycle.state === 'turn-preamble' && nonEmptyString(value.message)
          ? deferCodexTopLevelError(lifecycle, line, value.message)
          : 'unapproved error message'
      }
      return lifecycle.state === 'turn-preamble'
        ? undefined
        : `error is not allowed in state ${lifecycle.state}`
    }
    default:
      return `unknown event type ${type}`
  }
}

function validateCodexTurnFailure(value: unknown): string | undefined {
  if (!isRecord(value)) return 'turn.failed error must be an object'
  const keysError = exactKeys(value, ['message'])
  if (keysError) return keysError
  return nonEmptyString(value.message) ? undefined : 'turn.failed error message must be a non-empty string'
}

function deferCodexTopLevelError(lifecycle: CodexLifecycle, line: number, message: string): string | undefined {
  if (lifecycle.deferredErrors.length >= MAX_RECORDED_VIOLATIONS) return 'unapproved error message'
  lifecycle.deferredErrors.push({ line, message })
  return undefined
}

function recordCodexTurnFailure(lifecycle: CodexLifecycle, line: number, error: unknown): void {
  if (lifecycle.turnFailures.length >= MAX_RECORDED_VIOLATIONS) return
  const message = isRecord(error) && typeof error.message === 'string' ? error.message : ''
  lifecycle.turnFailures.push({ line, message })
}

function unconfirmedCodexTopLevelErrors(lifecycle: CodexLifecycle): string[] {
  const [deferred] = lifecycle.deferredErrors
  const [failure] = lifecycle.turnFailures
  const confirmed = lifecycle.deferredErrors.length === 1
    && lifecycle.turnFailed === 1
    && lifecycle.turnFailures.length === 1
    && failure.line > deferred.line
    && failure.message === deferred.message
  return confirmed ? [] : lifecycle.deferredErrors.map(({ line }) => `line ${line}: unapproved error message`)
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
    return isCodexCodeModeFailClosedItem(value)
      || isCodexModelMetadataFallbackItem(value)
      || allowedCodexTransportMessage(value.message, 'fallback')
      ? undefined
      : 'unapproved error item message'
  }
  return `unknown item type ${type}`
}

function isCodexModelMetadataFallbackItem(value: unknown): boolean {
  return isRecord(value)
    && value.type === 'error'
    && nonEmptyString(value.id)
    && typeof value.message === 'string'
    && !containsCapabilityMarker(value.message)
    && CODEX_MODEL_METADATA_FALLBACK_MESSAGE.test(value.message)
}

function isCodexCodeModeFailClosedItem(value: unknown): boolean {
  return isRecord(value)
    && value.type === 'error'
    && nonEmptyString(value.id)
    && typeof value.message === 'string'
    && CODEX_CODE_MODE_FAIL_CLOSED_MESSAGE.test(value.message)
}

function allowedCodexTransportMessage(message: unknown, kind: 'retry' | 'fallback'): boolean {
  if (typeof message !== 'string' || containsCapabilityMarker(message)) return false
  return kind === 'retry' ? CODEX_RETRY_MESSAGE.test(message) : CODEX_FALLBACK_MESSAGE.test(message)
}

function safeStderrSummary(line: string): string {
  const truncated = line.slice(0, STDERR_SUMMARY_LIMIT)
  const sanitized = truncated.replace(/\p{C}/gu, '?')
  return line.length > STDERR_SUMMARY_LIMIT ? `${sanitized}…` : sanitized
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

function toolNamesInEnvelope(root: unknown, ignoreToolResults = false): string[] {
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
      if (key === 'type' && nested === 'tool_use') {
        const name = (value as Record<string, unknown>).name
        found.add(typeof name === 'string' && name ? name : 'unnamed-tool')
      } else if (key === 'type' && nested === 'tool_result' && ignoreToolResults) {
        // tool_result 是调用回执，不是第二个工具；实际调用已经由配对的 tool_use 记录。
      } else if (['type', 'subtype', 'kind'].includes(key) && typeof nested === 'string' && isToolEventMarker(nested)) {
        found.add(nested)
      }
      if (toolKey.test(key) && nested !== undefined && nested !== null && nested !== false && nested !== '') found.add(key)
      inspect(nested, depth + 1)
    }
  }
  inspect(root)
  return [...found]
}

function qoderToolResultViolations(value: unknown, observedToolUseIds: Set<string>): string[] {
  if (!isRecord(value) || !isRecord(value.message) || !Array.isArray(value.message.content)) return []
  const violations: string[] = []
  for (const block of value.message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'tool_use') {
      if (typeof block.id === 'string' && block.id) {
        if (observedToolUseIds.size < MAX_RECORDED_VIOLATIONS || observedToolUseIds.has(block.id)) {
          observedToolUseIds.add(block.id)
        } else {
          violations.push('Qoder tool_use ID 过多')
        }
      }
      continue
    }
    if (block.type !== 'tool_result') continue
    if (typeof block.tool_use_id !== 'string' || !observedToolUseIds.has(block.tool_use_id)) {
      violations.push('Qoder tool_result 缺少已观测的 tool_use')
    }
  }
  return violations
}

function qoderTextOnlyInitViolations(value: unknown): string[] {
  if (!isQoderInit(value)) return []
  const violations: string[] = []
  if (!Array.isArray(value.tools)) {
    violations.push('Qoder init tools 必须是数组')
  } else {
    const tools = value.tools.map((tool) => typeof tool === 'string' && tool ? tool.slice(0, 200) : 'invalid-init-tool')
    if (tools.length) violations.push(`Qoder 纯文本 init 暴露工具：${tools.slice(0, MAX_RECORDED_VIOLATIONS).join(', ')}`)
  }
  if (!Array.isArray(value.mcp_servers)) {
    violations.push('Qoder init mcp_servers 必须是数组')
  } else {
    const active = value.mcp_servers.flatMap((server) => {
      if (!isRecord(server)) return ['invalid-mcp-server']
      if (server.status === 'disconnected') return []
      const name = typeof server.name === 'string' && server.name ? server.name.slice(0, 200) : 'unnamed-mcp-server'
      return [`${name}(${typeof server.status === 'string' ? server.status.slice(0, 40) : 'invalid-status'})`]
    })
    if (active.length) violations.push(`Qoder 纯文本 init 存在未隔离 MCP：${active.slice(0, MAX_RECORDED_VIOLATIONS).join(', ')}`)
  }
  return violations
}

function isQoderInit(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'system' && value.subtype === 'init'
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 ? value : undefined
}
