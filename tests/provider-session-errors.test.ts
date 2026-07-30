import { describe, expect, it } from 'vitest'
import { providerSessionIsUnavailable } from '../src/main/providers/session-errors'

describe('provider session errors', () => {
  it('recognizes terminal loss without confusing transport failures', () => {
    expect(providerSessionIsUnavailable('codex', 'abc-123', 'No saved session found with id abc-123')).toBe(true)
    expect(providerSessionIsUnavailable('codex', 'abc-123', 'No rollout found for thread id: abc-123')).toBe(true)
    expect(providerSessionIsUnavailable(
      'codex',
      'abc-123',
      'Error: thread/resume: thread/resume failed: no rollout found for thread id abc-123 (code -32600)'
    )).toBe(true)
    expect(providerSessionIsUnavailable('claude', 'abc-123', 'Session not found: abc-123')).toBe(true)
    expect(providerSessionIsUnavailable('claude', 'abc-123', 'No conversation found with session id: abc-123')).toBe(true)
    expect(providerSessionIsUnavailable('qoder', 'abc-123', 'Invalid session identifier "abc-123"')).toBe(true)
    expect(providerSessionIsUnavailable('qoder', 'abc-123', 'Error resuming session: Invalid session identifier "abc-123"')).toBe(true)
    expect(providerSessionIsUnavailable('qoder', 'abc-123', 'Error resuming session: No previous sessions found for this project')).toBe(true)
    expect(providerSessionIsUnavailable('opencode', 'abc-123', 'Session not found')).toBe(true)
    expect(providerSessionIsUnavailable('codex', 'abc-123', 'thread other-id not found')).toBe(false)
    expect(providerSessionIsUnavailable('codex', 'abc-123', 'failed to resume websocket for session abc-123: connection reset')).toBe(false)
    expect(providerSessionIsUnavailable('codex', 'abc-123', 'failed to record rollout items: thread abc-123 not found')).toBe(false)
  })
})
