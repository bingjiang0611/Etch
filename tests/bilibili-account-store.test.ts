import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BilibiliAccountStore, type BilibiliSafeStorage, type BiliupLoginInfo } from '../src/main/storage/bilibili-account-store'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

const loginInfo: BiliupLoginInfo = {
  cookie_info: { cookies: [{ name: 'SESSDATA', value: 'secret-session' }, { name: 'bili_jct', value: 'secret-csrf' }] },
  sso: [],
  token_info: { access_token: 'secret-access', expires_in: 3600, mid: 123, refresh_token: 'secret-refresh' },
  platform: 'BiliTV'
}

const fakeSafeStorage: BilibiliSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
  decryptString: (value) => Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString('utf8')
}

describe('BilibiliAccountStore', () => {
  it('stores login data encrypted in a 0600 atomic file and returns only public account state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-bili-account-'))
    directories.push(directory)
    const path = join(directory, 'account.json')
    const store = new BilibiliAccountStore(path, fakeSafeStorage)

    await store.save(loginInfo, { status: 'connected', mid: '123', name: 'Etch Test', connectedAt: new Date().toISOString() })

    const storedText = await readFile(path, 'utf8')
    expect(storedText).not.toContain('secret-session')
    expect(storedText).not.toContain('secret-access')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await store.loginInfo()).toEqual(loginInfo)
    expect(await store.account()).toMatchObject({ status: 'connected', mid: '123', name: 'Etch Test' })
  })

  it('removes the encrypted account record on disconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-bili-account-'))
    directories.push(directory)
    const store = new BilibiliAccountStore(join(directory, 'account.json'), fakeSafeStorage)
    await store.save(loginInfo, { status: 'connected', mid: '123', name: 'Etch Test' })

    await store.clear()

    expect(await store.account()).toEqual({ status: 'disconnected' })
  })
})
