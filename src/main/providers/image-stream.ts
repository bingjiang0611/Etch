import { IMAGE_TOOL_NAME } from './image-adapters'
import { parseProviderLine } from './jsonl'

export interface ImageStreamInspection {
  sessionIds: string[]
  text: string
  errors: string[]
  tools: string[]
  unexpectedTools: string[]
}

// 配图阶段允许工具调用，所以不能复用纯文本审计器；这里只做「只准调 ImageGen」这一条裁决。
export class ImageStreamReader {
  readonly #sessionIds = new Set<string>()
  readonly #errors: string[] = []
  readonly #tools = new Set<string>()
  #text = ''
  #buffer = ''

  push(chunk: string): void {
    this.#buffer += chunk
    const lines = this.#buffer.split(/\r?\n/u)
    this.#buffer = lines.pop() ?? ''
    for (const line of lines) this.#inspect(line)
  }

  finish(): void {
    if (this.#buffer.trim()) this.#inspect(this.#buffer)
    this.#buffer = ''
  }

  inspection(): ImageStreamInspection {
    const tools = [...this.#tools]
    return {
      sessionIds: [...this.#sessionIds],
      text: this.#text.trim(),
      errors: [...this.#errors],
      tools,
      unexpectedTools: tools.filter((tool) => tool !== IMAGE_TOOL_NAME)
    }
  }

  #inspect(line: string): void {
    if (!line.trim()) return
    for (const tool of toolNames(line)) {
      if (this.#tools.size < 32) this.#tools.add(tool)
    }
    this.#record(parseProviderLine(line))
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
}

function toolNames(line: string): string[] {
  let value: unknown
  try { value = JSON.parse(line) } catch { return [] }
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
