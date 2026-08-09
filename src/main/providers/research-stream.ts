import { parseProviderLine } from './jsonl'
import { codexSessionIdIsValid } from './session-id'

export interface ResearchStreamInspection {
  sessionId: string
  text: string
  errors: string[]
  unexpectedTools: string[]
  webSearches: number
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
