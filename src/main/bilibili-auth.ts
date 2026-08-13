import { createHash, randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import { BilibiliAccountSchema, BilibiliPartitionSchema, BilibiliQrStateSchema, type BilibiliAccount, type BilibiliPartition, type BilibiliQrState } from '../shared/bilibili'
import { BiliupLoginInfoSchema, biliupCookieHeader, type BiliupLoginInfo, type BilibiliAccountStore } from './storage/bilibili-account-store'

const BILITV_APP_KEY = '4409e2ce8ffd12b8'
const BILITV_APP_SECRET = '59b43e04ad6965f34319062b478f83dd'
const BILIBILI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36 Etch/0.1'
const QR_LIFETIME_MS = 5 * 60_000
const NETWORK_ATTEMPTS = 3
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

interface QrSession {
  state: BilibiliQrState
  abortController: AbortController
}

type Fetch = typeof fetch

export class BilibiliAuthService {
  readonly #sessions = new Map<string, QrSession>()

  constructor(
    private readonly store: Pick<BilibiliAccountStore, 'account' | 'save' | 'clear' | 'loginInfo' | 'markExpiredIfCurrent'>,
    private readonly fetcher: Fetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {}

  async account(): Promise<BilibiliAccount> {
    return BilibiliAccountSchema.parse(await this.store.account())
  }

  async startQrLogin(): Promise<BilibiliQrState> {
    this.disposeQrSessions()
    const response = await this.#postSigned('https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code', {
      appkey: BILITV_APP_KEY,
      local_id: '0',
      ts: String(Math.floor(Date.now() / 1000))
    })
    const data = this.#responseData(response)
    const url = typeof data.url === 'string' ? data.url : ''
    const authCode = typeof data.auth_code === 'string' ? data.auth_code : ''
    if (!url || !authCode) throw new Error('B站没有返回可用的登录二维码')
    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + QR_LIFETIME_MS).toISOString()
    const state = BilibiliQrStateSchema.parse({
      sessionId,
      status: 'waiting',
      qrDataUrl: await QRCode.toDataURL(url, { width: 248, margin: 1, errorCorrectionLevel: 'M' }),
      expiresAt,
      message: '请使用哔哩哔哩 App 扫码并确认登录'
    })
    const session = { state, abortController: new AbortController() }
    this.#sessions.set(sessionId, session)
    void this.#poll(sessionId, authCode).catch((error) => {
      const current = this.#sessions.get(sessionId)
      if (!current || current.abortController.signal.aborted) return
      current.state = BilibiliQrStateSchema.parse({
        ...current.state,
        status: 'failed',
        qrDataUrl: undefined,
        message: error instanceof Error ? error.message.slice(0, 300) : '扫码登录失败'
      })
    })
    return state
  }

  qrState(sessionId: string): BilibiliQrState {
    const session = this.#sessions.get(sessionId)
    if (!session) throw new Error('登录二维码已失效，请重新获取')
    return BilibiliQrStateSchema.parse(session.state)
  }

  async disconnect(): Promise<BilibiliAccount> {
    this.disposeQrSessions()
    await this.store.clear()
    return { status: 'disconnected' }
  }

  async partitions(): Promise<BilibiliPartition[]> {
    const loginInfo = await this.store.loginInfo()
    const response = await this.fetcher('https://member.bilibili.com/x/vupre/web/archive/pre', {
      headers: this.#accountHeaders(loginInfo),
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error(`B站分区读取失败（HTTP ${response.status}）`)
    const payload = await response.json() as Record<string, unknown>
    const code = Number(payload.code)
    if (code !== 0) {
      if (code === -101) await this.store.markExpiredIfCurrent(loginInfo, '登录已失效，请重新扫码')
      throw new Error(code === -101 ? 'B站登录已失效，请重新扫码' : `B站分区读取失败（code ${code}）`)
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {}
    const roots = Array.isArray(data.typelist) ? data.typelist : []
    const partitions: BilibiliPartition[] = []
    for (const root of roots) {
      if (!root || typeof root !== 'object') continue
      const parent = root as Record<string, unknown>
      const parentName = String(parent.name ?? '')
      const children = Array.isArray(parent.children) ? parent.children : []
      if (!children.length) this.#appendPartition(partitions, parent, '')
      else for (const child of children) this.#appendPartition(partitions, child as Record<string, unknown>, parentName)
    }
    if (!partitions.length) throw new Error('B站没有返回可用投稿分区')
    return zUniquePartitions(partitions)
  }

  disposeQrSessions(): void {
    for (const session of this.#sessions.values()) session.abortController.abort()
    this.#sessions.clear()
  }

  async #poll(sessionId: string, authCode: string): Promise<void> {
    const session = this.#sessions.get(sessionId)
    if (!session) return
    while (!session.abortController.signal.aborted && Date.now() < Date.parse(session.state.expiresAt)) {
      await this.sleep(1_000)
      const response = await this.#postSigned('https://passport.bilibili.com/x/passport-tv-login/qrcode/poll', {
        appkey: BILITV_APP_KEY,
        auth_code: authCode,
        local_id: '0',
        ts: String(Math.floor(Date.now() / 1000))
      }, session.abortController.signal)
      const code = Number((response as Record<string, unknown>).code)
      if (code === 86039) {
        session.state = BilibiliQrStateSchema.parse({ ...session.state, status: 'waiting' })
        continue
      }
      if (code !== 0) throw new Error(`B站扫码登录失败（code ${code}）`)
      const loginInfo = BiliupLoginInfoSchema.parse(this.#responseData(response))
      const account = await this.#accountFromLogin(loginInfo, session.abortController.signal)
      await this.store.save(loginInfo, account)
      session.state = BilibiliQrStateSchema.parse({
        ...session.state,
        status: 'complete',
        qrDataUrl: undefined,
        account,
        message: `已连接 ${account.name ?? 'B站账号'}`
      })
      return
    }
    if (!session.abortController.signal.aborted) {
      session.state = BilibiliQrStateSchema.parse({ ...session.state, status: 'expired', qrDataUrl: undefined, message: '二维码已过期，请刷新' })
    }
  }

  async #accountFromLogin(loginInfo: BiliupLoginInfo, signal: AbortSignal): Promise<BilibiliAccount> {
    const response = await this.fetcher('https://api.bilibili.com/x/space/myinfo', {
      headers: this.#accountHeaders(loginInfo),
      signal
    })
    if (!response.ok) throw new Error(`B站账号信息读取失败（HTTP ${response.status}）`)
    const payload = await response.json() as Record<string, unknown>
    const data = this.#responseData(payload)
    const mid = String(data.mid ?? loginInfo.token_info.mid)
    const avatarDataUrl = typeof data.face === 'string' ? await this.#avatarDataUrl(data.face, signal) : undefined
    return BilibiliAccountSchema.parse({
      status: 'connected',
      mid,
      name: String(data.name ?? data.uname ?? `UID ${mid}`),
      avatarDataUrl,
      connectedAt: new Date().toISOString()
    })
  }

  async #avatarDataUrl(url: string, signal: AbortSignal): Promise<string | undefined> {
    if (!/^https:\/\//u.test(url)) return undefined
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]
      if (!response.ok || !contentType?.startsWith('image/')) return undefined
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || bytes.length > 1_000_000) return undefined
      return `data:${contentType};base64,${bytes.toString('base64')}`
    } catch {
      return undefined
    }
  }

  async #postSigned(url: string, values: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const form = new URLSearchParams(values)
    const sign = createHash('md5').update(`${form.toString()}${BILITV_APP_SECRET}`).digest('hex')
    form.set('sign', sign)
    const response = await this.#fetchLoginWithRetry(url, form, signal)
    if (!response.ok) throw new Error(`B站登录服务不可用（HTTP ${response.status}）`)
    return response.json()
  }

  async #fetchLoginWithRetry(url: string, form: URLSearchParams, signal?: AbortSignal): Promise<Response> {
    let lastFailure: unknown
    for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetcher(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': BILIBILI_USER_AGENT },
          body: form,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
        })
        if (!TRANSIENT_HTTP_STATUSES.has(response.status) || attempt === NETWORK_ATTEMPTS) return response
        lastFailure = new Error(`HTTP ${response.status}`)
      } catch (error) {
        if (signal?.aborted) throw error
        lastFailure = error
      }
      await this.sleep(250 * 2 ** (attempt - 1))
    }
    const timeout = lastFailure instanceof Error && (lastFailure.name === 'TimeoutError' || String(lastFailure.cause ?? '').includes('ETIMEDOUT'))
    throw new Error(timeout
      ? '连接 B站登录服务超时，已自动重试 3 次。请检查网络或代理后重试。'
      : '暂时无法连接 B站登录服务，已自动重试 3 次。请检查网络或代理后重试。')
  }

  #responseData(payload: unknown): Record<string, unknown> {
    if (!payload || typeof payload !== 'object') throw new Error('B站返回了无法识别的响应')
    const object = payload as Record<string, unknown>
    if (Number(object.code) !== 0 || !object.data || typeof object.data !== 'object') {
      throw new Error(typeof object.message === 'string' ? object.message : `B站请求失败（code ${String(object.code)}）`)
    }
    return object.data as Record<string, unknown>
  }

  #accountHeaders(loginInfo: BiliupLoginInfo): Record<string, string> {
    return {
      Cookie: biliupCookieHeader(loginInfo),
      Referer: 'https://member.bilibili.com/',
      'User-Agent': BILIBILI_USER_AGENT
    }
  }

  #appendPartition(target: BilibiliPartition[], value: Record<string, unknown>, parentName: string): void {
    const tid = Number(value.id ?? value.tid)
    const name = String(value.name ?? '').trim()
    if (!Number.isSafeInteger(tid) || tid <= 0 || !name) return
    target.push(BilibiliPartitionSchema.parse({ tid, name, parentName }))
  }
}

function zUniquePartitions(partitions: BilibiliPartition[]): BilibiliPartition[] {
  return [...new Map(partitions.map((partition) => [partition.tid, partition])).values()]
}
