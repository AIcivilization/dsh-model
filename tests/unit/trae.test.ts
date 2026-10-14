import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decryptStorageValue, findTraeCredential, tokenDaysLeft } from '../../src/checkin/trae.js'

// 用假数据按 Trae 的格式造一个加密信封：头 6 字节 + 32 字节随机数 + AES-128-CBC(sha512(明文) + 明文)
const SALT_A = [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37]
const SALT_B = [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125]
function envelope(plain: string): string {
  const random = randomBytes(32)
  const salt = Buffer.from(SALT_A.map((v, i) => v ^ SALT_B[i]!))
  const derived = createHash('sha512').update(Buffer.concat([createHash('sha512').update(random).digest(), salt])).digest()
  const body = Buffer.concat([createHash('sha512').update(plain).digest(), Buffer.from(plain)])
  const c = createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  return Buffer.concat([Buffer.from([116, 99, 5, 16, 0, 0]), random, c.update(body), c.final()]).toString('base64')
}
const fakeJwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`

describe('Trae check-in', () => {
  it('opens the storage.json envelope and rejects an unknown format', () => {
    const v = envelope('{"token":"fake","userId":"1"}')
    expect(decryptStorageValue(v)).toBe('{"token":"fake","userId":"1"}')
    const bad = Buffer.from(v, 'base64')
    bad[0] = 0
    expect(() => decryptStorageValue(bad.toString('base64'))).toThrow(/加密格式/)
  })

  it('finds the desktop login (with device id) before the CLI token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-model-trae-'))
    const root = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : process.platform === 'win32' ? join(home, 'AppData', 'Roaming') : join(home, '.config')
    const dir = join(root, 'Trae CN', 'User', 'globalStorage')
    await mkdir(dir, { recursive: true })
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 9 * 86400 + 60)
    await writeFile(join(dir, 'storage.json'), JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': envelope(JSON.stringify({ token })), 'iCubeAuthInfo://icube-dc:123456': 'x' }))
    await mkdir(join(home, '.trae-cn'), { recursive: true })
    await writeFile(join(home, '.trae-cn', 'trae-jwt-token'), fakeJwt(1))
    const saved = { xdg: process.env.XDG_CONFIG_HOME, appdata: process.env.APPDATA }
    delete process.env.XDG_CONFIG_HOME
    delete process.env.APPDATA
    try {
      expect(await findTraeCredential(home)).toMatchObject({ token, deviceId: '123456', source: 'Trae CN' })
    } finally {
      if (saved.xdg) process.env.XDG_CONFIG_HOME = saved.xdg
      if (saved.appdata) process.env.APPDATA = saved.appdata
    }
    expect(tokenDaysLeft(token)).toBe(9)
  })

  it('falls back to the CLI token file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-model-trae-'))
    await mkdir(join(home, '.trae-cn'), { recursive: true })
    await writeFile(join(home, '.trae-cn', 'trae-jwt-token'), fakeJwt(2000000000))
    const saved = { xdg: process.env.XDG_CONFIG_HOME, appdata: process.env.APPDATA }
    delete process.env.XDG_CONFIG_HOME
    delete process.env.APPDATA
    try {
      expect(await findTraeCredential(home)).toMatchObject({ source: '~/.trae-cn', deviceId: '' })
    } finally {
      if (saved.xdg) process.env.XDG_CONFIG_HOME = saved.xdg
      if (saved.appdata) process.env.APPDATA = saved.appdata
    }
  })
})
