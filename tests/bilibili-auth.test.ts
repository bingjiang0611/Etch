import { describe, expect, it, vi } from 'vitest'
import { BilibiliAuthService } from '../src/main/bilibili-auth'
import type { BilibiliAccountStore, BiliupLoginInfo } from '../src/main/storage/bilibili-account-store'

const loginInfo: BiliupLoginInfo = {
  cookie_info: { cookies: [{ name: 'SESSDATA', value: 'session' }, { name: 'bili_jct', value: 'csrf' }] },
  sso: [],
  token_info: { access_token: 'access', expires_in: 3600, mid: 123, refresh_token: 'refresh' },
  platform: 'BiliTV'
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('BilibiliAuthService', () => {
  it('completes QR login and stores the native biliup credential without exposing it in state', async () => {
    let saved: BiliupLoginInfo | undefined
    const store: Pick<BilibiliAccountStore, 'account' | 'save' | 'clear' | 'loginInfo' | 'markExpired'> = {
      account: async () => ({ status: 'disconnected' }),
      save: async (info) => { saved = info },
      clear: async () => undefined,
      loginInfo: async () => loginInfo,
      markExpired: async (message) => ({ status: 'expired', message })
    }
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes('auth_code')) return json({ code: 0, data: { url: 'https://example.com/qr', auth_code: 'auth-code' } })
      if (url.includes('/poll')) return json({ code: 0, data: loginInfo })
      if (url.includes('/myinfo')) return json({ code: 0, data: { mid: 123, name: 'Etch Test', face: 'https://example.com/avatar.jpg' } })
      if (url.includes('/avatar.jpg')) return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
      throw new Error(`unexpected URL ${url}`)
    })
    const service = new BilibiliAuthService(store, fetcher, async () => undefined)

    const started = await service.startQrLogin()
    expect(started.qrDataUrl).toMatch(/^data:image\/png;base64,/u)
    for (let attempt = 0; attempt < 20 && service.qrState(started.sessionId).status !== 'complete'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const completed = service.qrState(started.sessionId)

    expect(completed).toMatchObject({ status: 'complete', account: { status: 'connected', mid: '123', name: 'Etch Test', avatarDataUrl: 'data:image/jpeg;base64,AQID' } })
    expect(JSON.stringify(completed)).not.toContain('cookie_info')
    expect(JSON.stringify(completed)).not.toContain('access_token')
    expect(saved).toEqual(loginInfo)
  })

  it('flattens the authenticated archive partition tree', async () => {
    const store: Pick<BilibiliAccountStore, 'account' | 'save' | 'clear' | 'loginInfo' | 'markExpired'> = {
      account: async () => ({ status: 'connected', mid: '123', name: 'Etch Test' }),
      save: async () => undefined,
      clear: async () => undefined,
      loginInfo: async () => loginInfo,
      markExpired: async (message) => ({ status: 'expired', message })
    }
    const service = new BilibiliAuthService(store, vi.fn<typeof fetch>(async () => json({
      code: 0,
      data: { typelist: [{ id: 160, name: '生活', children: [{ id: 21, name: '日常' }, { id: 138, name: '搞笑' }] }] }
    })))

    await expect(service.partitions()).resolves.toEqual([
      { tid: 21, name: '日常', parentName: '生活' },
      { tid: 138, name: '搞笑', parentName: '生活' }
    ])
  })

  it('retries transient QR connection failures before returning the login state', async () => {
    let attempts = 0
    const store: Pick<BilibiliAccountStore, 'account' | 'save' | 'clear' | 'loginInfo' | 'markExpired'> = {
      account: async () => ({ status: 'disconnected' }),
      save: async () => undefined,
      clear: async () => undefined,
      loginInfo: async () => loginInfo,
      markExpired: async (message) => ({ status: 'expired', message })
    }
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).includes('auth_code')) return json({ code: 86039 })
      attempts += 1
      if (attempts < 3) throw new TypeError('fetch failed')
      return json({ code: 0, data: { url: 'https://example.com/qr', auth_code: 'auth-code' } })
    })
    const service = new BilibiliAuthService(store, fetcher, async () => undefined)

    await expect(service.startQrLogin()).resolves.toMatchObject({ status: 'waiting' })
    expect(attempts).toBe(3)
    service.disposeQrSessions()
  })

  it('returns an actionable Chinese error after QR connection retries are exhausted', async () => {
    const store: Pick<BilibiliAccountStore, 'account' | 'save' | 'clear' | 'loginInfo' | 'markExpired'> = {
      account: async () => ({ status: 'disconnected' }),
      save: async () => undefined,
      clear: async () => undefined,
      loginInfo: async () => loginInfo,
      markExpired: async (message) => ({ status: 'expired', message })
    }
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed') })
    const service = new BilibiliAuthService(store, fetcher, async () => undefined)

    await expect(service.startQrLogin()).rejects.toThrow('暂时无法连接 B站登录服务，已自动重试 3 次。请检查网络或代理后重试。')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
