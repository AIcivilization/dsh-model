import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decryptCookie, findDoubaoLogins, readDoubaoCookie } from '../../src/checkin/browser-cookies.js'
import { cookieValue } from '../../src/checkin/accounts.js'

const macKey = pbkdf2Sync('pw', 'saltysalt', 1003, 16, 'sha1')

/** 照 Chromium（macOS，库版本 24）加密：v10 + AES-128-CBC，明文前面是 host 的 sha256 */
function macEncrypt(host: string, value: string): Buffer {
  const c = createCipheriv('aes-128-cbc', macKey, Buffer.alloc(16, 0x20))
  const plain = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
  return Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()])
}

/** 微秒（1601 年起） */
const chromeTime = (ms: number) => BigInt(ms + 11_644_473_600_000) * 1000n

async function fakeDoubaoApp(home: string, rows: { host: string; name: string; value: string; expires: number }[]) {
  const dir = join(home, 'Library', 'Application Support', 'DoubaoWork', 'Default')
  await mkdir(dir, { recursive: true })
  const mod = 'node:sqlite'
  const { DatabaseSync } = (await import(mod)) as { DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void } }
  const db = new DatabaseSync(join(dir, 'Cookies'))
  db.exec(`create table meta(key text, value text); insert into meta values ('version', '24');
    create table cookies(host_key text, name text, value text, encrypted_value blob, expires_utc integer)`)
  const ins = db.prepare('insert into cookies values (?, ?, ?, ?, ?)')
  for (const r of rows) ins.run(r.host, r.name, '', macEncrypt(r.host, r.value), r.expires)
  db.close()
}

describe('reading the Doubao sign-in from a local Chromium app', () => {
  it('decrypts macOS v10 cookies and drops the host hash on db version 24', () => {
    expect(decryptCookie(macEncrypt('.doubao.com', 'abc'), macKey, 'darwin', 24)).toBe('abc')
  })

  it('decrypts Windows v10 (AES-GCM) cookies and skips v20', () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, nonce)
    const body = Buffer.concat([c.update('xyz'), c.final()])
    const enc = Buffer.concat([Buffer.from('v10'), nonce, body, c.getAuthTag()])
    expect(decryptCookie(enc, key, 'win32', 18)).toBe('xyz')
    expect(decryptCookie(Buffer.from('v20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), key, 'win32', 24)).toBeNull()
  })

  it('finds a signed-in app without decrypting, and reads the cookie string', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshm-bc-'))
    const later = chromeTime(Date.now() + 86_400_000)
    await fakeDoubaoApp(home, [
      { host: '.doubao.com', name: 'sessionid', value: 's1', expires: Number(later) },
      { host: '.doubao.com', name: 'uid_tt', value: 'u1', expires: Number(later) },
      { host: 'www.doubao.com', name: 'i18next', value: 'zh', expires: Number(later) },
      { host: '.doubao.com', name: 'old', value: 'x', expires: Number(chromeTime(Date.now() - 1000)) },
      { host: 'example.com', name: 'sessionid', value: 'other', expires: Number(later) },
    ])
    const logins = await findDoubaoLogins(home, 'darwin')
    expect(logins.map((l) => l.label)).toEqual(['豆包电脑版'])
    const cookie = await readDoubaoCookie(logins[0]!, 'darwin', Date.now(), macKey)
    expect(cookieValue(cookie, 'sessionid')).toBe('s1')
    expect(cookieValue(cookie, 'uid_tt')).toBe('u1')
    expect(cookieValue(cookie, 'i18next')).toBe('zh')
    expect(cookie).not.toMatch(/old=|other/)
  })

  it('reports nothing when the app is not signed in', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshm-bc-'))
    await fakeDoubaoApp(home, [{ host: '.doubao.com', name: 'i18next', value: 'zh', expires: 0 }])
    expect(await findDoubaoLogins(home, 'darwin')).toEqual([])
    expect(await findDoubaoLogins(home, 'linux')).toEqual([])
  })
})
