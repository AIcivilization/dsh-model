import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enginePackageName, localEngineBinary } from '../../src/engine/packages.js'

describe('engine npm platform packages', () => {
  it('names packages by Node platform/arch', () => {
    expect(enginePackageName('darwin', 'arm64')).toBe('dsh-model-engine-darwin-arm64')
    expect(enginePackageName('linux', 'x64')).toBe('dsh-model-engine-linux-x64')
    expect(enginePackageName('win32', 'x64')).toBe('dsh-model-engine-win32-x64')
  })

  /** 搭一个假的 node_modules/<平台包>，里面放二进制和 package.json */
  function fakePackage(opts: { engineVersion: string; sha256?: string; bin?: string }): string {
    const root = mkdtempSync(join(tmpdir(), 'dshm-ep-'))
    const base = join(root, 'base.js')
    writeFileSync(base, '')
    const pkgDir = join(root, 'node_modules', 'dsh-model-engine-linux-x64')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'cli-proxy-api'), opts.bin ?? 'BINARY')
    chmodSync(join(pkgDir, 'cli-proxy-api'), 0o755)
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-model-engine-linux-x64', version: opts.engineVersion, engineVersion: opts.engineVersion, ...(opts.sha256 ? { engineSha256: opts.sha256 } : {}) }))
    return base
  }

  it('finds the installed binary when the version matches', () => {
    const base = fakePackage({ engineVersion: '8.0.13', sha256: 'abc' })
    const found = localEngineBinary('8.0.13', 'linux', 'x64', base)
    expect(found?.bin).toMatch(/dsh-model-engine-linux-x64[\\/]cli-proxy-api$/)
    expect(found?.sha256).toBe('abc')
  })

  it('ignores a package whose engine version differs', () => {
    const base = fakePackage({ engineVersion: '8.0.1' })
    expect(localEngineBinary('8.0.13', 'linux', 'x64', base)).toBeNull()
  })

  it('returns null when no package is installed', () => {
    const base = join(mkdtempSync(join(tmpdir(), 'dshm-ep-')), 'base.js')
    writeFileSync(base, '')
    expect(localEngineBinary('8.0.13', 'linux', 'x64', base)).toBeNull()
  })

  it('carries a usable sha256 so install can verify the binary', () => {
    const bin = 'HELLO-ENGINE'
    const sha = createHash('sha256').update(bin).digest('hex')
    const base = fakePackage({ engineVersion: '8.0.13', sha256: sha, bin })
    const found = localEngineBinary('8.0.13', 'linux', 'x64', base)
    expect(found?.sha256).toBe(sha)
  })
})
