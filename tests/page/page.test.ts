// @vitest-environment jsdom
// 页面测试：在浏览器环境（jsdom）里渲染真实的 plugin/client.js，后台用假数据。
// 0.14.1–0.18.0 的"没装服务只显示一行红字"就是因为从没渲染过页面才漏掉的。

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as React from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

type Handler = (call: { method: string; path: string; body?: unknown }) => [number, unknown]
let handler: Handler = () => [404, {}]
let hostInfo: unknown = { running: '1.0.0', installed: '1.0.0', restart: 'desktop' }
let setupReplies: unknown[] = []
let Section: React.ComponentType
let Overlay: React.ComponentType
let CheckinOverlay: React.ComponentType
let root: Root | undefined
let container: HTMLElement

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  document.documentElement.lang = 'zh-CN'
  const w = window as unknown as Record<string, unknown>
  w.__DSH_MODEL_TOKEN__ = 't'
  w.fetch = async (url: string, opts: { body: string }) => {
    if (url === '/api-dsh-model/token') return reply(200, { token: 't' })
    if (url === '/api-dsh-model/host') return reply(200, hostInfo)
    if (url === '/api-dsh-model/setup') return reply(200, setupReplies.length > 1 ? setupReplies.shift() : setupReplies[0])
    const [status, body] = handler(JSON.parse(opts.body))
    return reply(status, body)
  }
  globalThis.fetch = w.fetch as typeof fetch
  w.__ModuleLoader__ = {
    load({ factory }: { factory: (req: (n: string) => unknown) => { apply: (ctx: unknown) => void } }) {
      const mod = factory((n) => (n === 'react' ? React : null))
      mod.apply({ slots: { inject: (_n: string, fn: () => void) => fn(), register: (d: { name: string; id: string }, C: React.ComponentType) => (d.id === 'dsh-model-checkin' ? (CheckinOverlay = C) : d.name === 'shell.overlay' ? (Overlay = C) : (Section = C)) } })
    },
  }
  await import('../../plugin/client.js')
  expect(Section).toBeTruthy()
})

afterEach(async () => {
  hostInfo = { running: '1.0.0', installed: '1.0.0', restart: 'desktop' }
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
})

async function render(C: React.ComponentType = Section): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(C))
  })
}

async function waitText(text: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!container.textContent?.includes(text)) {
    if (Date.now() > deadline) throw new Error(`没等到「${text}」；页面是：${container.textContent?.slice(0, 300)}`)
    await act(async () => new Promise((r) => setTimeout(r, 20)))
  }
}

async function click(text: string): Promise<void> {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!btn) throw new Error(`没有按钮「${text}」`)
  await act(async () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

const workbuddy = { id: 'workbuddy', label: 'WorkBuddy', kind: 'workbuddy', login: 'link', riskAck: false, risky: false, pricing: { tier: 'free', zh: '免费', en: 'free' }, loggedIn: true, enabled: true, account: 'me', models: 2 }

function normal(extra: Handler = () => [404, {}]): Handler {
  return (c) => {
    const p = c.path
    if (p.startsWith('/sources/workbuddy/models')) return [200, { custom: false, models: [{ id: 'workbuddy/a', name: 'A · x0.00', selected: true, recommended: true }, { id: 'workbuddy/b', name: 'B · x0.5', selected: false, recommended: false }] }]
    if (p.startsWith('/sources')) return [200, [workbuddy]]
    if (p === '/keys') return [200, [{ name: 'dsh', key: 'dshm_…abcd', createdAt: '2026-10-01' }]]
    if (p === '/stats') return [200, { byKey: {}, byModel: {} }]
    if (p === '/endpoints') return [200, { local: 'http://127.0.0.1:8317/v1' }]
    if (p === '/self') return [200, { version: '1.0.0', latest: '1.0.0', canManage: true, commands: { update: 'dsh-model update', uninstall: 'dsh-model uninstall' } }]
    return extra(c)
  }
}

const gemini = { id: 'gemini', label: 'Gemini（Google AI Studio）', kind: 'apikey', login: 'key', riskAck: false, risky: false, subscribeUrl: 'https://aistudio.google.com/apikey', pricing: { tier: 'limited', zh: '免费 key，每天有次数上限', en: 'free key with daily limits' }, loggedIn: false, enabled: false, models: 0 }

describe('settings page', () => {
  it('service not set up: shows the set-up card, not a bare error line', async () => {
    handler = () => [503, { error: { code: 'daemon_not_configured', message: 'dsh-model daemon not configured (run dsh-model setup)' } }]
    await render()
    await waitText('一键安装')
    expect(container.textContent).toContain('npm install -g dsh-model')
  })

  it('service not running: offers repair', async () => {
    handler = () => [503, { error: { code: 'daemon_unreachable', message: 'dsh-model daemon is not running (run dsh-model repair)' } }]
    await render()
    await waitText('修复')
    expect(container.textContent).toContain('dsh-model repair')
  })

  it('normal: lists sources, keys and about; the model picker opens', async () => {
    handler = normal()
    await render()
    await waitText('WorkBuddy')
    await waitText('dsh-model 1.0.0')
    expect(container.textContent).toContain('dsh')
    await click('选模型')
    await waitText('恢复推荐')
    expect(container.textContent).toContain('已选 1 / 2')
  })

  it('turning on an API-key source without a key opens the key dialog; saving posts the key', async () => {
    const posted: unknown[] = []
    handler = (c) => {
      if (c.path === '/apikey/gemini') {
        posted.push(c.body)
        return [200, { models: 3, free: 3 }]
      }
      if (c.path.startsWith('/sources') && !c.path.includes('/models')) return [200, [workbuddy, gemini]]
      return normal()(c)
    }
    window.localStorage.clear()
    await render()
    await waitText('未登录的来源（1 个）')
    await click('▸ 未登录的来源（1 个）')
    const sw = container.querySelector('button[role="switch"][aria-label="Gemini（Google AI Studio）"]')!
    await act(async () => sw.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await waitText('去创建 key')
    const input = container.querySelector('input[type="password"]') as HTMLInputElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'AIza-test-key-123456')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('保存')
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    expect(posted).toEqual([{ key: 'AIza-test-key-123456' }])
  })

  it('updated but not restarted: shows the restart banner (button only on dsh-vps)', async () => {
    handler = normal()
    hostInfo = { running: '1.0.0', installed: '1.1.0', restart: 'desktop' }
    await render()
    await waitText('dsh-model 已更新到 1.1.0')
    expect(container.textContent).toContain('完全退出 dsh')
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === '重启 dsh')).toBe(false)
    await act(async () => root?.unmount())
    hostInfo = { running: '1.0.0', installed: '1.1.0', restart: 'vps' }
    await render()
    await waitText('重启 dsh')
  })

  it('no banner when the running code is the installed one', async () => {
    handler = normal()
    await render()
    await waitText('WorkBuddy')
    expect(container.textContent).not.toContain('已更新到')
  })

  it('shows recent failures with advice', async () => {
    handler = normal((c) => (c.path === '/failures' ? [200, [{ at: new Date().toISOString(), model: 'workbuddy-ai/deepseek-v4.1-flash', source: 'workbuddy-ai', status: 429, code: 'model_cooldown', message: '请求过于频繁，请稍后重试。', kind: 'rate', advice: '被限流：请求太频繁' }]] : [404, {}]))
    await render()
    await waitText('最近失败（24 小时内 1 次）')
    expect(container.textContent).toContain('被限流：请求太频繁')
    expect(container.textContent).toContain('workbuddy-ai/deepseek-v4.1-flash')
  })

  it('model picker: "Test" shows whether the model works', async () => {
    handler = normal((c) => (c.path === '/models/test' ? [200, { ok: true, ms: 1234, reply: '好' }] : [404, {}]))
    await render()
    await waitText('WorkBuddy')
    await click('选模型')
    await waitText('恢复推荐')
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '测一下')!
    await act(async () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await waitText('可用 · 1.2 秒 · 好')
  })

  it('one-click set-up shows progress while it runs', async () => {
    handler = () => [503, { error: { code: 'daemon_not_configured', message: 'not configured' } }]
    setupReplies = [
      { running: true, output: '统一端点（引擎）\n下载引擎…', code: null },
      { running: true, output: '统一端点（引擎）\n下载引擎…\n✓ 引擎已在 127.0.0.1:8317 运行', code: null },
      { running: false, output: '统一端点（引擎）\n下载引擎…\n✓ 引擎已在 127.0.0.1:8317 运行\n✓ 完成', code: 1 },
    ]
    await render()
    await waitText('一键安装')
    await click('一键安装')
    await waitText('下载引擎…')
    expect(container.textContent).toContain('进行中…')
    await waitText('没有完成（退出码 1）', 5000)
    expect(container.textContent).toContain('✓ 完成')
  })

  it('low quota: a notice in the shell overlay, dismissed for a day with "Got it"', async () => {
    window.localStorage.clear()
    handler = (c) => (c.path === '/usage' ? [200, [{ source: 'workbuddy-ai', label: 'WorkBuddy AI', windows: [], credits: { remaining: 50, total: 670 }, fetchedAt: new Date().toISOString() }, { source: 'workbuddy', label: 'WorkBuddy', windows: [], credits: { remaining: 3000, total: 4000 }, fetchedAt: new Date().toISOString() }]] : [404, {}])
    await render(Overlay)
    await waitText('WorkBuddy AI 积分只剩 7%（50 / 670）')
    expect(container.textContent).not.toContain('3,000')
    await click('知道了')
    expect(container.textContent).toBe('')
    await act(async () => root?.unmount())
    await render(Overlay)
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    expect(container.textContent).toBe('')
  })

  it('first-use guide: offers free sources, opens the key dialog, can be hidden', async () => {
    window.localStorage.clear()
    handler = (c) => (c.path.startsWith('/sources') && !c.path.includes('/models') ? [200, [workbuddy, gemini]] : normal()(c))
    await render()
    await waitText('开始使用')
    await click('Gemini（Google AI Studio）')
    await waitText('去创建 key')
    await act(async () => root?.unmount())
    await render()
    await waitText('开始使用')
    await click('我知道了，不再显示')
    expect(container.textContent).not.toContain('开始使用')
    await act(async () => root?.unmount())
    await render()
    await waitText('WorkBuddy')
    expect(container.textContent).not.toContain('开始使用')
  })

  it('signed-in sources are listed; signed-out ones are folded away (and the choice is remembered)', async () => {
    window.localStorage.clear()
    window.localStorage.setItem('dsh-model.guideDone', '1')
    handler = (c) => (c.path.startsWith('/sources') && !c.path.includes('/models') ? [200, [workbuddy, gemini]] : normal()(c))
    await render()
    await waitText('WorkBuddy')
    expect(container.querySelector('button[role="switch"][aria-label="WorkBuddy"]')).toBeTruthy()
    expect(container.querySelector('button[role="switch"][aria-label="Gemini（Google AI Studio）"]')).toBeNull()
    await click('▸ 未登录的来源（1 个）')
    expect(container.querySelector('button[role="switch"][aria-label="Gemini（Google AI Studio）"]')).toBeTruthy()
    await act(async () => root?.unmount())
    await render()
    await waitText('收起未登录的来源（1 个）')
  })

  it('nothing signed in yet: the signed-out list starts open', async () => {
    window.localStorage.clear()
    handler = (c) => (c.path.startsWith('/sources') && !c.path.includes('/models') ? [200, [{ ...workbuddy, loggedIn: false, enabled: false }, gemini]] : normal()(c))
    await render()
    await waitText('还没有接入任何来源')
    expect(container.querySelector('button[role="switch"][aria-label="Gemini（Google AI Studio）"]')).toBeTruthy()
  })

  it('check-in card: lists what is left, "Check in all" shows the results; auto switch is on', async () => {
    window.localStorage.setItem('dsh-model.guideDone', '1')
    const status = (results: unknown[]) => ({ auto: true, date: '2026-10-14', results, available: [{ id: 'workbuddy', label: 'WorkBuddy' }, { id: 'qoder', label: 'Qoder（国内版）' }], qoder: { configured: true, region: 'cn' } })
    handler = normal((c) => {
      if (c.path === '/checkin' && c.method === 'GET') return [200, status([])]
      if (c.path === '/checkin' && c.method === 'POST') return [200, status([{ id: 'workbuddy', label: 'WorkBuddy', state: 'signed', credit: 30, at: 'x' }, { id: 'qoder', label: 'Qoder（国内版）', state: 'already', at: 'x' }])]
      return [404, {}]
    })
    await render()
    await waitText('还没签：WorkBuddy、Qoder（国内版）')
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked).toBe(true)
    await click('一键签到')
    await waitText('今日已完成签到：WorkBuddy、Qoder（国内版）')
    expect(container.textContent).toContain('WorkBuddy：成功 +30 积分')
    expect(container.textContent).toContain('Qoder（国内版）：今天已签过')
  })

  it('check-in notice: shows today once, with failures called out', async () => {
    window.localStorage.clear()
    handler = (c) => (c.path === '/checkin' ? [200, { auto: true, date: '2026-10-14', results: [{ id: 'workbuddy', label: 'WorkBuddy', state: 'signed', credit: 30, at: 'x' }, { id: 'qoder', label: 'Qoder', state: 'failed', message: '令牌过期', at: 'x' }], available: [], qoder: { configured: true } }] : [404, {}])
    await render(CheckinOverlay)
    await waitText('dsh-model：有签到没成功')
    expect(container.textContent).toContain('Qoder：失败：令牌过期')
    await click('知道了')
    expect(container.textContent).toBe('')
  })
})
