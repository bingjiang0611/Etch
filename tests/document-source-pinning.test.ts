import { EventEmitter } from 'node:events'
import type { ClientRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())
const agentMock = vi.hoisted(() => vi.fn(function MockAgent(this: { options?: unknown }, options: unknown) {
  this.options = options
}))
const lookupMock = vi.hoisted(() => vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]))

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }))
vi.mock('node:https', () => ({ Agent: agentMock, request: requestMock }))

import { fetchDocumentSource } from '../src/main/content/document-source'

describe('document source DNS pinning', () => {
  it('connects to the validated address while preserving Host and TLS server name', async () => {
    requestMock.mockImplementation(() => {
      const request = new EventEmitter() as EventEmitter & { end: () => void }
      request.end = () => {
        request.emit('error', new Error('synthetic connection failure'))
      }
      return request as unknown as ClientRequest
    })

    await expect(fetchDocumentSource('https://example.com/article')).rejects.toMatchObject({ code: 'http-error' })

    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requestMock.mock.calls[0][0]).toMatchObject({
      hostname: '8.8.8.8',
      family: 4,
      servername: 'example.com',
      headers: { Host: 'example.com' }
    })
  })

  it('routes the validated address through Electron\'s resolved HTTP proxy', async () => {
    requestMock.mockImplementation(() => {
      const request = new EventEmitter() as EventEmitter & { end: () => void }
      request.end = () => {
        request.emit('error', new Error('synthetic connection failure'))
      }
      return request as unknown as ClientRequest
    })

    await expect(fetchDocumentSource('https://example.com/article', {
      resolveProxy: async () => 'PROXY 127.0.0.1:10808; DIRECT'
    })).rejects.toMatchObject({ code: 'http-error' })

    expect(agentMock).toHaveBeenCalledWith({
      keepAlive: false,
      proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:10808/' }
    })
    expect(requestMock.mock.calls.at(-1)?.[0]).toMatchObject({
      hostname: '8.8.8.8',
      servername: 'example.com',
      headers: { Host: 'example.com' },
      agent: expect.any(agentMock)
    })
  })
})
