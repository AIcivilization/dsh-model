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
let Section: React.ComponentType
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
    const [status, body] = handler(JSON.parse(opts.body))
    return reply(status, body)
  }
  globalThis.fetch = w.fetch as typeof fetch
  w.__ModuleLoader__ = {
    load({ factory }: { factory: (req: (n: string) => unknown) => { apply: (ctx: unknown) => void } }) {
      const mod = factory((n) => (n === 'react' ? React : null))
      mod.apply({ slots: { inject: (_n: string, fn: () => void) => fn(), register: (_d: unknown, C: React.ComponentType) => (Section = C) } })
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

async function render(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Section))
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
    await render()
    await waitText('Gemini（Google AI Studio）')
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
})
