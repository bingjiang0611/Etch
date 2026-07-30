import type { ModelSelection, ProviderId } from './task-schema'

export type ProviderEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'result'; text?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'error'; message: string }
  | { type: 'raw'; value: unknown }

export interface ProviderRunRequest {
  provider: ProviderId
  model: ModelSelection
  prompt: string
  externalSessionId?: string
}

export interface ProviderInvocation {
  command: string
  args: string[]
  stdin: string
  env: Record<string, string>
}
