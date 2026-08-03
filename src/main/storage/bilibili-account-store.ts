import { readFile, rm } from 'node:fs/promises'
import { z } from 'zod'
import { BilibiliAccountSchema, type BilibiliAccount } from '../../shared/bilibili'
import { writeJsonAtomic } from './atomic-json'

export const BiliupLoginInfoSchema = z.object({
  cookie_info: z.object({
    cookies: z.array(z.object({
      name: z.string().min(1),
      value: z.string(),
      http_only: z.number().optional(),
      expires: z.number().optional(),
      secure: z.number().optional()
    })).min(1),
    domains: z.array(z.string()).optional()
  }).passthrough(),
  sso: z.array(z.string()).default([]),
  token_info: z.object({
    access_token: z.string().min(1),
    expires_in: z.number().int(),
    mid: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/u)]),
    refresh_token: z.string()
  }),
  platform: z.string().nullable().optional()
}).passthrough()
export type BiliupLoginInfo = z.infer<typeof BiliupLoginInfoSchema>

const StoredAccountSchema = z.object({
  schemaVersion: z.literal(1),
  encryptedLoginInfo: z.string().min(1),
  account: BilibiliAccountSchema
})

export interface BilibiliSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class BilibiliAccountStore {
  constructor(readonly path: string, private readonly safeStorage: BilibiliSafeStorage) {}

  async account(): Promise<BilibiliAccount> {
    try {
      return (await this.#load()).account
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'disconnected' }
      throw error
    }
  }

  async loginInfo(): Promise<BiliupLoginInfo> {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('macOS 安全存储当前不可用，无法读取 B站登录信息')
    const stored = await this.#load()
    try {
      return BiliupLoginInfoSchema.parse(JSON.parse(this.safeStorage.decryptString(Buffer.from(stored.encryptedLoginInfo, 'base64'))))
    } catch {
      throw new Error('B站登录信息无法解密，请重新扫码登录')
    }
  }

  async save(loginInfo: BiliupLoginInfo, account: BilibiliAccount): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('macOS 安全存储当前不可用，无法保存 B站登录信息')
    const validated = BiliupLoginInfoSchema.parse(loginInfo)
    const connected = BilibiliAccountSchema.parse({ ...account, status: 'connected' })
    const encryptedLoginInfo = this.safeStorage.encryptString(JSON.stringify(validated)).toString('base64')
    await writeJsonAtomic(this.path, { schemaVersion: 1, encryptedLoginInfo, account: connected })
  }

  async markExpired(message: string): Promise<BilibiliAccount> {
    const stored = await this.#load()
    const account = BilibiliAccountSchema.parse({ ...stored.account, status: 'expired', message: message.slice(0, 300) })
    await writeJsonAtomic(this.path, { ...stored, account })
    return account
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
  }

  async #load(): Promise<z.infer<typeof StoredAccountSchema>> {
    return StoredAccountSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
  }
}

export function biliupCookieHeader(loginInfo: BiliupLoginInfo): string {
  return loginInfo.cookie_info.cookies.map(({ name, value }) => `${name}=${value}`).join('; ')
}
