import { parseProviderLine } from './jsonl'
import { QODER_RESEARCH_TOOL } from './research-adapters'
import { codexSessionIdIsValid } from './session-id'

export interface ResearchStreamInspection {
  sessionId: string
  text: string
  errors: string[]
  unexpectedTools: string[]
  webSearches: number
}

// Qoder 的 stream-json 形状（2026-08 实测）：system/init 带 session_id，assistant 的
// message.content 里出现 tool_use，user 里回 tool_result，最后 result/success 带 result 文本。
// spawn 层已把内建工具收窄到只剩 WebSearch、权限层会拒掉插件 MCP，这里是第三层：
// 只要出现过非 WebSearch 的 tool_use，即使被拒绝执行也算会话污染，直接让阶段失败。
export function inspectQoderResearchStream(stdout: string): ResearchStreamInspection {
  const sessions = new Set<string>()
  const errors: string[] = []
  const texts: string[] = []
  const unexpectedTools = new Set<string>()
  let webSearches = 0
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    let envelope: unknown
    try { envelope = JSON.parse(line) } catch {
      unexpectedTools.add('non-json-output')
      continue
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      unexpectedTools.add('non-object-output')
      continue
    }
    const record = envelope as Record<string, unknown>
    if (typeof record.session_id === 'string') sessions.add(record.session_id)
    const message = record.message && typeof record.message === 'object' && !Array.isArray(record.message)
      ? record.message as Record<string, unknown>
      : undefined
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue
      const nested = block as Record<string, unknown>
      if (nested.type !== 'tool_use') continue
      const name = typeof nested.name === 'string' ? nested.name : 'unnamed-tool'
      if (name === QODER_RESEARCH_TOOL) webSearches += 1
      else unexpectedTools.add(name)
    }
    if (record.type === 'result') {
      if (record.is_error === true) errors.push(String(record.result ?? 'Qoder Web Search 失败').slice(0, 500))
      else if (typeof record.result === 'string') texts.push(record.result)
      continue
    }
    const event = parseProviderLine(line)
    if (event.type === 'error') errors.push(event.message.slice(0, 500))
  }
  if (sessions.size !== 1) throw new Error(`外部核验必须且只能产生一个 Qoder session，实际 ${sessions.size}`)
  const sessionId = [...sessions][0]
  if (!codexSessionIdIsValid(sessionId)) throw new Error('外部核验 Qoder session ID 无效')
  return { sessionId, text: texts.join('\n').trim(), errors, unexpectedTools: [...unexpectedTools], webSearches }
}

export function inspectResearchStream(stdout: string): ResearchStreamInspection {
  const sessions = new Set<string>()
  const errors: string[] = []
  const texts: string[] = []
  const unexpectedTools = new Set<string>()
  let webSearches = 0
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    let envelope: unknown
    try { envelope = JSON.parse(line) } catch {
      unexpectedTools.add('non-json-output')
      continue
    }
    webSearches += inspectEnvelope(envelope, unexpectedTools)
    const event = parseProviderLine(line)
    if (event.type === 'session') sessions.add(event.sessionId)
    else if (event.type === 'error') errors.push(event.message.slice(0, 500))
    else if (event.type === 'text') texts.push(event.text)
    else if (event.type === 'result' && event.text) texts.push(event.text)
  }
  if (sessions.size !== 1) throw new Error(`外部核验必须且只能产生一个 Codex thread，实际 ${sessions.size}`)
  const sessionId = [...sessions][0]
  if (!codexSessionIdIsValid(sessionId)) throw new Error('外部核验 Codex thread ID 无效')
  return { sessionId, text: texts.join('\n').trim(), errors, unexpectedTools: [...unexpectedTools], webSearches }
}

function inspectEnvelope(value: unknown, unexpected: Set<string>): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const record = value as Record<string, unknown>
  const nested = record.item && typeof record.item === 'object' && !Array.isArray(record.item)
    ? record.item as Record<string, unknown>
    : undefined
  const itemType = typeof nested?.type === 'string' ? nested.type : ''
  const isWebSearch = /^web_search(?:_call)?$/u.test(itemType)
  if (itemType
    && !['agent_message', 'reasoning', 'error'].includes(itemType)
    && !isWebSearch) {
    unexpected.add(itemType)
  }
  const forbiddenKey = /^(command|command_execution|file_change|apply_patch|shell|mcp|browser|computer|image_generation)$/iu
  for (const [key, nestedValue] of Object.entries(record)) {
    if (forbiddenKey.test(key) && nestedValue !== undefined && nestedValue !== null && nestedValue !== false) unexpected.add(key)
  }
  return record.type === 'item.started' && isWebSearch ? 1 : 0
}
