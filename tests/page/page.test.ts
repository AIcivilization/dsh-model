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
})
