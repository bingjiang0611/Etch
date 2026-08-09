import { IMAGE_TOOL_NAME } from './image-adapters'
import { parseProviderLine } from './jsonl'

export interface ImageStreamInspection {
  sessionIds: string[]
  text: string
  errors: string[]
  tools: string[]
  unexpectedTools: string[]
}

export interface ImageStreamLimits {
  lineBytes: number
  events: number
  totalBytes: number
}

const DEFAULT_LIMITS: ImageStreamLimits = {
  lineBytes: 1024 * 1024,
  events: 10_000,
  totalBytes: 5 * 1024 * 1024
}
const ALLOWED_IMAGE_TOOLS = new Set([IMAGE_TOOL_NAME, 'image_generation'])
const CODEX_NON_TOOL_ITEMS = new Set(['agent_message', 'reasoning', 'error'])

// 配图阶段允许工具调用，所以不能复用纯文本审计器；这里只做「只准调 ImageGen」这一条裁决。
export class ImageStreamReader {
  readonly #limits: ImageStreamLimits
  readonly #sessionIds = new Set<string>()
  readonly #errors: string[] = []
  readonly #tools = new Set<string>()
  readonly #violations = new Set<string>()
  readonly #codexImageStarted = new Set<string>()
  readonly #codexImageCompleted = new Set<string>()
  #text = ''
  #buffer = ''
  #totalBytes = 0
  #events = 0
  #qoderImageCalls = 0
  #codexObserved = false
  #blocked = false
  #finished = false

  constructor(limits: Partial<ImageStreamLimits> = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits }
  }

  push(chunk: string): void {
    if (this.#finished || this.#blocked) return
    this.#totalBytes += Buffer.byteLength(chunk)
    if (this.#totalBytes > this.#limits.totalBytes) {
      this.#violate('jsonl-total-bytes-limit')
      return
    }
    this.#buffer += chunk
    const lines = this.#buffer.split(/\r?\n/u)
    this.#buffer = lines.pop() ?? ''
    for (const line of lines) {
      this.#inspect(line)
      if (this.#blocked) return
    }
    if (Buffer.byteLength(this.#buffer) > this.#limits.lineBytes) this.#violate('jsonl-line-bytes-limit')
  }

  finish(): void {
    if (this.#finished) return
    if (!this.#blocked && this.#buffer.trim()) this.#inspect(this.#buffer)
    this.#buffer = ''
    this.#finished = true
    if (this.#codexObserved
      && (this.#codexImageStarted.size !== 1
        || this.#codexImageCompleted.size !== 1
        || [...this.#codexImageStarted].some((id) => !this.#codexImageCompleted.has(id)))) {
      this.#violations.add('image_generation-lifecycle')
    }
    if (!this.#codexObserved && this.#qoderImageCalls !== 1) this.#violations.add('ImageGen-call-count')
  }

  inspection(): ImageStreamInspection {
    const tools = [...this.#tools]
    return {
      sessionIds: [...this.#sessionIds],
      text: this.#text.trim(),
      errors: [...this.#errors],
      tools,
      unexpectedTools: [...new Set([
        ...tools.filter((tool) => !ALLOWED_IMAGE_TOOLS.has(tool)),
        ...this.#violations
      ])]
    }
  }

  #inspect(line: string): void {
    if (!line.trim()) return
    if (Buffer.byteLength(line) > this.#limits.lineBytes) {
      this.#violate('jsonl-line-bytes-limit')
      return
    }
    this.#events += 1
    if (this.#events > this.#limits.events) {
      this.#violate('jsonl-event-count-limit')
      return
    }
    let envelope: unknown
    try { envelope = JSON.parse(line) } catch { envelope = undefined }
    for (const tool of toolNames(envelope)) {
      if (tool === IMAGE_TOOL_NAME) this.#qoderImageCalls += 1
      this.#recordTool(tool)
    }
    this.#inspectCodexEnvelope(envelope)
    this.#record(parseProviderLine(line))
  }

  #inspectCodexEnvelope(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const envelope = value as Record<string, unknown>
    const type = typeof envelope.type === 'string' ? envelope.type : ''
    if (type === 'thread.started' || type === 'turn.started' || type === 'turn.completed' || type.startsWith('item.')) {
      this.#codexObserved = true
    }
    if (type !== 'item.started' && type !== 'item.completed') return
    if (!envelope.item || typeof envelope.item !== 'object' || Array.isArray(envelope.item)) {
      this.#violations.add('codex-item-envelope')
      return
    }
    const item = envelope.item as Record<string, unknown>
    const itemType = typeof item.type === 'string' ? item.type : ''
    if (itemType === 'image_generation') {
      this.#recordTool(itemType)
      const id = typeof item.id === 'string' && item.id ? item.id : undefined
      if (!id) {
        this.#violations.add('image_generation-lifecycle')
        return
      }
      if (type === 'item.started') {
        if (this.#codexImageStarted.size || this.#codexImageCompleted.has(id)) this.#violations.add('image_generation-lifecycle')
        this.#codexImageStarted.add(id)
      } else {
        if (!this.#codexImageStarted.has(id) || this.#codexImageCompleted.has(id)) this.#violations.add('image_generation-lifecycle')
        this.#codexImageCompleted.add(id)
      }
      return
    }
    if (!CODEX_NON_TOOL_ITEMS.has(itemType)) this.#recordTool(itemType || 'codex-item-without-type')
  }

  #record(event: ReturnType<typeof parseProviderLine>): void {
    if (event.type === 'session') {
      if (this.#sessionIds.size < 3) this.#sessionIds.add(event.sessionId)
      return
    }
    if (event.type === 'error') {
      if (this.#errors.length < 32) this.#errors.push(event.message.slice(0, 500))
      return
    }
    if (event.type !== 'text' && event.type !== 'result') return
    const value = event.type === 'text' ? event.text : event.text ?? ''
    if (!value || this.#text.length > 100_000) return
    this.#text += `${this.#text ? '\n' : ''}${value}`
  }

  #violate(marker: string): void {
    this.#violations.add(marker)
    this.#buffer = ''
    this.#blocked = true
  }

  #recordTool(tool: string): void {
    const bounded = tool.slice(0, 100)
    if (this.#tools.size < 32 || this.#tools.has(bounded)) this.#tools.add(bounded)
    else this.#violations.add('tool-count-limit')
  }
}

function toolNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const message = (value as Record<string, unknown>).message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return []
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return []
  return content
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .filter((item) => item.type === 'tool_use' && typeof item.name === 'string')
    .map((item) => String(item.name).slice(0, 100))
}
