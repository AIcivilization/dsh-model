import { describe, expect, it } from 'vitest'
import { windowsAppDirs } from '../../src/dsh/cli.js'
import { assetFileName, platformTarget } from '../../src/engine/install.js'
import { renderSupervise, renderVbs } from '../../src/service/windows.js'
import { quoteWinArg } from '../../src/util/exec.js'
import { parseWindowsProxy } from '../../src/util/proxy.js'

describe('windows: engine assets', () => {
  it('maps node platform/arch to the upstream asset names', () => {
    expect(platformTarget('win32', 'x64')).toBe('windows-amd64')
    expect(platformTarget('win32', 'arm64')).toBe('windows-aarch64')
    expect(platformTarget('darwin', 'arm64')).toBe('darwin-aarch64')
    expect(assetFileName('8.0.13', 'windows-amd64')).toBe('CLIProxyAPI_8.0.13_windows_amd64.zip')
    expect(assetFileName('8.0.13', 'linux-amd64')).toBe('CLIProxyAPI_8.0.13_linux_amd64.tar.gz')
  })
})

describe('windows: system proxy from the registry', () => {
  const on = '\r\nHKEY_CURRENT_USER\\...\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n'
  const off = '    ProxyEnable    REG_DWORD    0x0\r\n'
  const srv = (v: string) => `    ProxyServer    REG_SZ    ${v}\r\n`
  it('reads a single proxy for all protocols', () => {
    expect(parseWindowsProxy(on, srv('127.0.0.1:7890'))).toBe('http://127.0.0.1:7890')
  })
  it('prefers https, then http, then socks in per-protocol form', () => {
    expect(parseWindowsProxy(on, srv('http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892'))).toBe('http://127.0.0.1:7891')
    expect(parseWindowsProxy(on, srv('socks=127.0.0.1:7892'))).toBe('socks5://127.0.0.1:7892')
  })
  it('ignores a disabled proxy', () => {
    expect(parseWindowsProxy(off, srv('127.0.0.1:7890'))).toBeNull()
  })
})

describe('windows: quoting for cmd.exe', () => {
  it('leaves simple args alone and quotes the rest', () => {
    expect(quoteWinArg('--profile')).toBe('--profile')
    expect(quoteWinArg('C:\\Users\\张三\\AppData')).toBe('"C:\\Users\\张三\\AppData"')
    expect(quoteWinArg('a "b"')).toBe('"a ""b"""')
  })
})

describe('windows: hidden launcher script', () => {
  const spec = { label: 'dsh-model-engine', file: 'C:\\Users\\张 三\\.dsh-model\\services\\dsh-model-engine.json', program: ['C:\\x\\cli-proxy-api.exe', '-config', 'C:\\x\\engine.yaml'], workingDirectory: 'C:\\x', stdoutPath: 'C:\\x\\engine.stdout.log', home: 'C:\\x' }
  it('runs the supervisor hidden (style 0) with every path quoted', () => {
    const vbs = renderVbs(spec, 'C:\\Program Files\\nodejs\\node.exe', false)
    expect(vbs).toContain('sh.Run """C:\\Program Files\\nodejs\\node.exe"" ')
    expect(vbs).toContain('""service"" ""supervise"" ""C:\\Users\\张 三\\.dsh-model\\services\\dsh-model-engine.json""", 0, False')
    expect(vbs).not.toContain('ELECTRON_RUN_AS_NODE')
  })
  it('sets ELECTRON_RUN_AS_NODE when the node is the dsh desktop app', () => {
    expect(renderVbs(spec, 'C:\\Apps\\DeepSeek Harness.exe', true)).toContain('sh.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"')
  })
  it('writes the pid next to the spec', () => {
    expect(renderSupervise(spec).pidFile).toBe('C:\\Users\\张 三\\.dsh-model\\services\\dsh-model-engine.pid')
  })
})

describe('windows: where the dsh desktop app lives', () => {
  it('prefers the running app, then the usual install folders', () => {
    const dirs = windowsAppDirs({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, 'D:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe', true)
    expect(dirs[0]).toMatch(/DeepSeek Harness$/)
    expect(dirs).toHaveLength(3)
  })
})
