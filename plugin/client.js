/* global window, document, fetch, navigator, setTimeout, clearTimeout, setInterval, clearInterval */
// plugin/client.js — dsh-model 的设置页（设计 §14）
//
// 手写单文件 bundle，没有构建链：由 dsh web 客户端的 ModuleLoader 注入（写法照 dsh-vps-manager）。
// 挂在「设置 → dsh-model」：来源开关 + 订阅用量、API key 状态、模型统计。
// 界面只通过 /api-dsh-model/call 调宿主，宿主再转给 dsh-model 守护进程；页面拿不到任何密钥。
// 硬约束：界面崩了不能影响 dsh，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-model',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    // —— 语言：跟着页面（dsh 只有中文、英文两种）——
    const isZh = () => {
      const l = (document.documentElement.lang || navigator.language || 'zh').toLowerCase()
      return l.startsWith('zh')
    }
    const L = (zh, en) => (isZh() ? zh : en)

    // —— 调宿主 ——
    let token = window.__DSH_MODEL_TOKEN__ || ''
    async function refreshToken() {
      const r = await fetch('/api-dsh-model/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' })
      const j = await r.json().catch(() => ({}))
      if (j.token) token = j.token
    }
    async function api(method, path, body, retried) {
      const r = await fetch('/api-dsh-model/call', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-model-token': token },
        body: JSON.stringify({ method, path, ...(body !== undefined ? { body } : {}) }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.status === 403 && !retried && j?.error?.code === 'refused') {
        await refreshToken()
        return api(method, path, body, true)
      }
      if (!r.ok || j?.error) {
        const e = new Error(j?.error?.message || `HTTP ${r.status}`)
        e.code = j?.error?.code
        e.hint = j?.error?.hint
        throw e
      }
      return j
    }

    // —— 样式（用 dsh 的颜色变量，跟随明暗主题）——
    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #888)',
      faint: 'var(--dsw-alias-label-tertiary, #999)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,.25))',
      layer: 'var(--dsw-alias-bg-layer-1, transparent)',
      base: 'var(--dsw-alias-bg-base, #fff)',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
      err: 'var(--dsw-alias-state-error-primary, #cf222e)',
      accent: 'var(--primary, #4d6bfe)',
      accentFg: 'var(--primary-foreground, #fff)',
    }
    const S = {
      section: { margin: '0 0 28px' },
      h: { fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: C.text },
      note: { fontSize: 12, color: C.sub, margin: '0 0 12px', lineHeight: 1.6 },
      card: { border: `1px solid ${C.border}`, borderRadius: 10, background: C.layer, overflow: 'hidden' },
      row: { padding: '12px 14px', borderTop: `1px solid ${C.border}` },
      rowFirst: { padding: '12px 14px' },
      line: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 28 },
      label: { fontSize: 14, fontWeight: 500, color: C.text },
      meta: { fontSize: 12, color: C.sub },
      grow: { flex: 1, minWidth: 0 },
      btn: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: `1px solid ${C.border}`, background: 'transparent', color: C.text, cursor: 'pointer' },
      btnPrimary: { fontSize: 12, padding: '5px 12px', borderRadius: 6, border: 'none', background: C.accent, color: C.accentFg, cursor: 'pointer' },
      input: { fontSize: 13, padding: '6px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.base, color: C.text, minWidth: 0 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', fontWeight: 500, color: C.sub, padding: '6px 10px', borderBottom: `1px solid ${C.border}` },
      td: { padding: '6px 10px', borderBottom: `1px solid ${C.border}`, color: C.text, whiteSpace: 'nowrap' },
    }

    // —— 小部件 ——
    function Switch({ on, busy, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        'aria-label': label,
        disabled: busy,
        onClick: () => onChange(!on),
        style: {
          width: 36, height: 20, borderRadius: 10, border: 'none', padding: 2, cursor: busy ? 'wait' : 'pointer', flex: 'none',
          background: on ? C.ok : 'var(--dsw-alias-border-l4, rgba(127,127,127,.4))', opacity: busy ? 0.6 : 1, transition: 'background .15s',
        },
      }, h('span', { style: { display: 'block', width: 16, height: 16, borderRadius: 8, background: '#fff', transform: on ? 'translateX(16px)' : 'none', transition: 'transform .15s' } }))
    }

    function Bar({ pct }) {
      const p = Math.max(0, Math.min(100, pct))
      const color = p >= 90 ? C.err : p >= 70 ? C.warn : C.ok
      return h('span', { style: { display: 'inline-block', width: 120, height: 6, borderRadius: 3, background: 'var(--dsw-alias-border-l2, rgba(127,127,127,.2))', verticalAlign: 'middle', overflow: 'hidden' } },
        h('span', { style: { display: 'block', width: `${p}%`, height: '100%', background: color } }))
    }

    const until = (iso) => {
      if (!iso) return ''
      const ms = Date.parse(iso) - Date.now()
      if (!(ms > 0)) return L('即将重置', 'resetting')
      const m = Math.round(ms / 60000)
      const d = Math.floor(m / 1440)
      const hh = Math.floor((m % 1440) / 60)
      const mm = m % 60
      const t = d ? L(`${d} 天 ${hh} 小时`, `${d}d ${hh}h`) : hh ? L(`${hh} 小时 ${mm} 分`, `${hh}h ${mm}m`) : L(`${mm} 分`, `${mm}m`)
      return L(`${t}后重置`, `resets in ${t}`)
    }
    const winLabel = (w) => ({ '5h': L('5 小时', '5 hours'), '7d': L('每周', 'Weekly'), '30d': L('每月', 'Monthly'), quota: L('总额度', 'Quota'), 'Opus 7d': L('Opus 每周', 'Opus weekly'), 'Sonnet 7d': L('Sonnet 每周', 'Sonnet weekly') }[w.label] || w.label)
    const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`)
    const ms = (x) => (x == null ? '-' : x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${x}ms`)
    const ago = (iso) => {
      if (!iso) return '-'
      const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
      return m < 1 ? L('刚刚', 'just now') : m < 60 ? L(`${m} 分钟前`, `${m}m ago`) : m < 1440 ? L(`${Math.round(m / 60)} 小时前`, `${Math.round(m / 60)}h ago`) : L(`${Math.round(m / 1440)} 天前`, `${Math.round(m / 1440)}d ago`)
    }
    const rateColor = (x) => (x == null ? C.sub : x >= 0.98 ? C.ok : x >= 0.9 ? C.warn : C.err)

    function Usage({ usage }) {
      if (!usage) return null
      if (usage.unsupported) return h('div', { style: { ...S.meta, marginTop: 6 } }, L('用量：暂不支持', 'Usage: not supported yet'))
      const lines = []
      if (usage.plan) lines.push(h('div', { key: 'plan', style: { ...S.meta, marginTop: 6 } }, `${L('套餐', 'Plan')}：${usage.plan}`))
      for (const w of usage.windows || []) {
        lines.push(h('div', { key: w.id, style: { ...S.line, minHeight: 22, fontSize: 12, color: C.text } },
          h('span', { style: { width: 72, color: C.sub } }, winLabel(w)),
          w.usedPercent != null ? h(Bar, { pct: w.usedPercent }) : null,
          w.usedPercent != null ? h('span', { style: { width: 40, textAlign: 'right' } }, `${Math.round(w.usedPercent)}%`) : null,
          w.used != null && w.limit != null ? h('span', { style: { color: C.sub } }, `${w.used}/${w.limit}`) : null,
          h('span', { style: { color: C.faint } }, until(w.resetAt))))
      }
      if (usage.credits) {
        const c = usage.credits
        lines.push(h('div', { key: 'credits', style: { ...S.line, minHeight: 22, fontSize: 12 } },
          h('span', { style: { width: 72, color: C.sub } }, L('积分', 'Credits')),
          c.total ? h(Bar, { pct: 100 - (c.remaining / c.total) * 100 }) : null,
          h('span', null, c.unlimited ? L('不限量', 'Unlimited') : L(`剩余 ${c.remaining.toLocaleString()}${c.total ? ` / ${c.total.toLocaleString()}` : ''}`, `${c.remaining.toLocaleString()} left${c.total ? ` of ${c.total.toLocaleString()}` : ''}`))))
      }
      if (usage.error) lines.push(h('div', { key: 'err', style: { fontSize: 12, color: C.warn, marginTop: 4 } }, `${L('用量暂不可用', 'Usage unavailable')}：${usage.error}`))
      return h('div', { style: { marginTop: 4, paddingLeft: 46 } }, lines)
    }

    // —— 登录弹窗 ——
    function Modal({ title, children, onClose }) {
      return h('div', {
        role: 'dialog', 'aria-modal': true,
        style: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
        onClick: (e) => { if (e.target === e.currentTarget) onClose() },
      }, h('div', { style: { width: 'min(520px, 100%)', background: C.base, color: C.text, borderRadius: 12, padding: 20, boxShadow: 'var(--dsw-elevation-soft, 0 8px 30px rgba(0,0,0,.2))' } },
        h('div', { style: { ...S.line, marginBottom: 12 } }, h('div', { style: { ...S.h, ...S.grow, margin: 0 } }, title), h('button', { type: 'button', style: S.btn, onClick: onClose }, L('关闭', 'Close'))),
        children))
    }

    function copy(text) {
      try { navigator.clipboard?.writeText(text) } catch { /* ignore */ }
    }

    function LoginDialog({ source, session, onDone, onClose }) {
      const [s, setS] = useState(session)
      const [paste, setPaste] = useState('')
      const [msg, setMsg] = useState('')
      useEffect(() => {
        let stop = false
        const tick = async () => {
          if (stop) return
          try {
            const st = await api('GET', `/login/${encodeURIComponent(session.id)}`)
            setS(st)
            if (st.status === 'ok') { onDone(); return }
            if (st.status === 'error' || st.status === 'cancelled') return
          } catch { /* 网络抖动：下一轮 */ }
          setTimeout(tick, 2000)
        }
        const t = setTimeout(tick, 2000)
        return () => { stop = true; clearTimeout(t) }
      }, [session.id])
      const submit = async () => {
        if (!paste.trim()) return
        setMsg(L('已提交，等待确认…', 'Submitted, waiting…'))
        try { await api('POST', `/login/${encodeURIComponent(session.id)}/callback`, { redirectUrl: paste.trim() }) } catch (e) { setMsg(e.message) }
      }
      const cancel = async () => {
        try { await api('DELETE', `/login/${encodeURIComponent(session.id)}`) } catch { /* ignore */ }
        onClose()
      }
      return h(Modal, { title: L(`登录 ${source.label}`, `Sign in to ${source.label}`), onClose: cancel },
        h('p', { style: S.note }, L('在浏览器里打开下面的链接并授权（这台服务器不需要浏览器，用你自己的电脑或手机都行）。', 'Open this link in a browser and approve (any device works; this server needs no browser).')),
        h('div', { style: { ...S.line, marginBottom: 10 } },
          h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', style: { ...S.btnPrimary, textDecoration: 'none' } }, L('打开授权页', 'Open authorization page')),
          h('button', { type: 'button', style: S.btn, onClick: () => copy(s.url) }, L('复制链接', 'Copy link'))),
        s.userCode ? h('div', { style: { ...S.line, marginBottom: 10 } },
          h('span', { style: S.meta }, L('授权页要求输入的码：', 'Code to enter:')),
          h('span', { style: { ...S.mono, fontSize: 18, fontWeight: 600, letterSpacing: 2 } }, s.userCode),
          h('button', { type: 'button', style: S.btn, onClick: () => copy(s.userCode) }, L('复制', 'Copy'))) : null,
        s.needsPaste ? h('div', { style: { marginBottom: 10 } },
          h('p', { style: S.note }, L('授权后浏览器会跳到一个打不开的 localhost 地址——把地址栏里的完整地址粘贴到这里。', 'After approving, the browser lands on a localhost address that will not load — paste that full address here.')),
          h('div', { style: S.line },
            h('input', { style: { ...S.input, ...S.grow }, placeholder: 'http://localhost:…/callback?code=…', value: paste, onChange: (e) => setPaste(e.target.value) }),
            h('button', { type: 'button', style: S.btnPrimary, onClick: submit }, L('提交', 'Submit')))) : null,
        h('div', { style: { fontSize: 12, color: s.status === 'error' ? C.err : C.sub } },
          s.status === 'pending' ? (msg || L('等待授权中…', 'Waiting for approval…')) : s.status === 'ok' ? L('已登录', 'Signed in') : `${L('登录没有完成', 'Login did not complete')}：${s.error || s.status}`))
    }

    function KeyDialog({ onDone, onClose }) {
      const [key, setKey] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const submit = async () => {
        setBusy(true)
        setMsg(L('正在用一个免费模型实测这把 key…', 'Testing the key against a free model…'))
        try { await api('POST', '/opencode/key', { key: key.trim() }); onDone() } catch (e) { setMsg(e.message); setBusy(false) }
      }
      return h(Modal, { title: 'OpenCode Zen', onClose },
        h('p', { style: S.note }, L('需要你的 OpenCode Zen API key（在 opencode.ai 免费注册）。写入前会先用一个免费模型实测。', 'Needs your OpenCode Zen API key (free sign-up at opencode.ai). It is tested against a free model first.')),
        h('div', { style: S.line },
          h('input', { type: 'password', style: { ...S.input, ...S.grow }, placeholder: 'API key', value: key, onChange: (e) => setKey(e.target.value) }),
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !key.trim(), onClick: submit }, L('保存', 'Save'))),
        msg ? h('div', { style: { ...S.meta, marginTop: 8 } }, msg) : null)
    }

    // —— 来源 ——
    function SourcesCard({ sources, reload, onLogin, onKey }) {
      const [busy, setBusy] = useState({})
      const [err, setErr] = useState('')
      const toggle = async (s, on) => {
        setErr('')
        setBusy((b) => ({ ...b, [s.id]: true }))
        try {
          if (!on) await api('POST', `/sources/${s.id}/disable`)
          else if (s.kind === 'opencode' && !s.loggedIn) onKey()
          else {
            let r = await api('POST', `/sources/${s.id}/enable`, {})
            if (r.riskNotice) {
              if (!window.confirm(r.riskNotice)) return
              r = await api('POST', `/sources/${s.id}/enable`, { acceptRisk: true })
            }
            if (r.login) onLogin(s, r.login)
          }
          await reload()
        } catch (e) {
          setErr(`${s.label}：${e.message}`)
        } finally {
          setBusy((b) => ({ ...b, [s.id]: false }))
        }
      }
      const logout = async (s) => {
        if (!window.confirm(L(`退出 ${s.label} 的登录？（它的模型会从 dsh 里消失）`, `Sign out of ${s.label}? (its models disappear from dsh)`))) return
        try { await api('POST', `/sources/${s.id}/logout`); await reload() } catch (e) { setErr(e.message) }
      }
      return h('div', { style: S.section },
        h('div', { style: S.h }, L('来源', 'Sources')),
        h('p', { style: S.note }, L('打开就接入，没登录会弹出登录；关闭只停用，登录保留。所有模型都经同一个端点 http://127.0.0.1:8317/v1 提供。', 'Turn on to connect (signs in if needed); turning off keeps the sign-in. All models are served from one endpoint, http://127.0.0.1:8317/v1.')),
        err ? h('div', { style: { fontSize: 12, color: C.err, margin: '0 0 8px' } }, err) : null,
        h('div', { style: S.card }, sources.map((s, i) => h('div', { key: s.id, style: i ? S.row : S.rowFirst },
          h('div', { style: S.line },
            h(Switch, { on: s.enabled, busy: busy[s.id], label: s.label, onChange: (on) => toggle(s, on) }),
            h('div', { style: S.grow },
              h('span', { style: S.label }, s.label),
              h('span', { style: { ...S.meta, marginLeft: 8 } },
                s.loggedIn ? (s.account || '') : L('未登录', 'Signed out'),
                s.models ? ` · ${L(`${s.models} 个模型`, `${s.models} models`)}` : '')),
            s.loggedIn && s.kind !== 'opencode' ? h('button', { type: 'button', style: S.btn, onClick: () => logout(s) }, L('退出登录', 'Sign out')) : null,
            s.kind === 'opencode' && s.loggedIn ? h('button', { type: 'button', style: S.btn, onClick: onKey }, L('换 key', 'Change key')) : null),
          s.enabled ? h(Usage, { usage: s.usage }) : null,
          !s.loggedIn && s.detail ? h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 4 } }, s.detail) : null))))
    }

    // —— key ——
    function KeysCard({ keys, reload }) {
      const [name, setName] = useState('')
      const [fresh, setFresh] = useState(null)
      const [err, setErr] = useState('')
      const add = async () => {
        setErr('')
        try { const r = await api('POST', '/keys', { name: name.trim() }); setFresh(r); setName(''); await reload() } catch (e) { setErr(e.message) }
      }
      const rotate = async (k) => {
        if (!window.confirm(L(`轮换 ${k.name}？旧 key 立即失效。`, `Rotate ${k.name}? The old key stops working immediately.`))) return
        try { const r = await api('POST', `/keys/${encodeURIComponent(k.name)}/rotate`); if (r.key) setFresh(r); await reload() } catch (e) { setErr(e.message) }
      }
      const revoke = async (k) => {
        if (!window.confirm(L(`吊销 ${k.name}？用它的设备会立即无法访问。`, `Revoke ${k.name}? Devices using it lose access immediately.`))) return
        try { await api('DELETE', `/keys/${encodeURIComponent(k.name)}`); await reload() } catch (e) { setErr(e.message) }
      }
      return h('div', { style: S.section },
        h('div', { style: S.h }, 'API key'),
        h('p', { style: S.note }, L('OpenAI 格式。dsh 用名为 dsh 的那把（自动配置）；其他设备或软件各领一把，丢了就吊销。下面是最近 24 小时的状态。', 'OpenAI-style. dsh uses the "dsh" key (configured automatically); give each other device or tool its own key and revoke it if lost. Stats cover the last 24 hours.')),
        err ? h('div', { style: { fontSize: 12, color: C.err, margin: '0 0 8px' } }, err) : null,
        fresh ? h('div', { style: { ...S.card, padding: 12, marginBottom: 10 } },
          h('div', { style: S.meta }, L(`新 key「${fresh.name}」只显示这一次：`, `New key "${fresh.name}" is shown only once:`)),
          h('div', { style: { ...S.line, marginTop: 6 } }, h('code', { style: { ...S.mono, ...S.grow, wordBreak: 'break-all' } }, fresh.key), h('button', { type: 'button', style: S.btn, onClick: () => copy(fresh.key) }, L('复制', 'Copy')), h('button', { type: 'button', style: S.btn, onClick: () => setFresh(null) }, L('我已保存', 'Saved')))) : null,
        h('div', { style: S.card },
          h('table', { style: S.table },
            h('thead', null, h('tr', null, [L('名称', 'Name'), 'Key', L('请求', 'Requests'), L('成功率', 'Success'), L('平均延迟', 'Latency'), 'tokens/s', L('最后使用', 'Last used'), ''].map((t, i) => h('th', { key: i, style: S.th }, t)))),
            h('tbody', null, keys.map((k) => {
              const st = k.stats?.d1
              return h('tr', { key: k.name },
                h('td', { style: S.td }, k.name),
                h('td', { style: { ...S.td, ...S.mono } }, k.key),
                h('td', { style: S.td }, st ? st.requests : 0),
                h('td', { style: { ...S.td, color: rateColor(st?.successRate) } }, pct(st?.successRate)),
                h('td', { style: S.td }, ms(st?.avgLatencyMs)),
                h('td', { style: S.td }, st?.tokensPerSec ?? '-'),
                h('td', { style: S.td }, ago(st?.lastUsedAt)),
                h('td', { style: { ...S.td, textAlign: 'right' } },
                  h('button', { type: 'button', style: S.btn, onClick: () => rotate(k) }, L('轮换', 'Rotate')),
                  k.name !== 'dsh' ? h('button', { type: 'button', style: { ...S.btn, marginLeft: 6, color: C.err }, onClick: () => revoke(k) }, L('吊销', 'Revoke')) : null))
            })))),
        h('div', { style: { ...S.line, marginTop: 10 } },
          h('input', { style: { ...S.input, width: 200 }, placeholder: L('新 key 名称，如 laptop', 'New key name, e.g. laptop'), value: name, onChange: (e) => setName(e.target.value) }),
          h('button', { type: 'button', style: S.btnPrimary, disabled: !name.trim(), onClick: add }, L('新增 key', 'Add key'))))
    }

    function ModelsCard({ stats }) {
      const rows = Object.entries(stats?.byModel || {}).sort((a, b) => b[1].d1.requests - a[1].d1.requests).slice(0, 30)
      if (!rows.length) return null
      return h('div', { style: S.section },
        h('div', { style: S.h }, L('模型统计', 'Models')),
        h('p', { style: S.note }, L('最近 24 小时经统一端点的请求，按模型。挑模型时参考成功率和速度。', 'Requests through the unified endpoint in the last 24 hours, by model.')),
        h('div', { style: S.card }, h('table', { style: S.table },
          h('thead', null, h('tr', null, [L('模型', 'Model'), L('来源', 'Source'), L('请求', 'Requests'), L('成功率', 'Success'), L('平均延迟', 'Latency'), 'tokens/s'].map((t, i) => h('th', { key: i, style: S.th }, t)))),
          h('tbody', null, rows.map(([m, v]) => h('tr', { key: m },
            h('td', { style: S.td }, m),
            h('td', { style: { ...S.td, color: C.sub } }, v.source),
            h('td', { style: S.td }, v.d1.requests),
            h('td', { style: { ...S.td, color: rateColor(v.d1.successRate) } }, pct(v.d1.successRate)),
            h('td', { style: S.td }, ms(v.d1.avgLatencyMs)),
            h('td', { style: S.td }, v.d1.tokensPerSec ?? '-')))))))
    }

    // —— 整页 ——
    function SettingsSection() {
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [login, setLogin] = useState(null)
      const [keyDialog, setKeyDialog] = useState(false)
      const alive = useRef(true)
      const load = useCallback(async (refresh) => {
        try {
          const [sources, keys, stats] = await Promise.all([api('GET', refresh ? '/sources?refresh=1' : '/sources'), api('GET', '/keys'), api('GET', '/stats')])
          if (alive.current) { setData({ sources, keys, stats }); setErr('') }
        } catch (e) {
          if (alive.current) setErr(e.hint ? `${e.message}（${e.hint}）` : e.message)
        }
      }, [])
      useEffect(() => {
        alive.current = true
        void load(true)
        const t = setInterval(() => void load(false), 15000)
        return () => { alive.current = false; clearInterval(t) }
      }, [load])
      if (!data) return h('div', { style: { fontSize: 13, color: err ? C.err : C.sub, padding: '8px 0' } }, err || L('加载中…', 'Loading…'))
      return h('div', { style: { color: C.text, maxWidth: 820 } },
        err ? h('div', { style: { fontSize: 12, color: C.err, marginBottom: 12 } }, err) : null,
        h(SourcesCard, { sources: data.sources, reload: () => load(false), onLogin: (s, session) => setLogin({ source: s, session }), onKey: () => setKeyDialog(true) }),
        h(KeysCard, { keys: data.keys, reload: () => load(false) }),
        h(ModelsCard, { stats: data.stats }),
        login ? h(LoginDialog, { source: login.source, session: login.session, onDone: () => { setLogin(null); void load(true) }, onClose: () => { setLogin(null); void load(false) } }) : null,
        keyDialog ? h(KeyDialog, { onDone: () => { setKeyDialog(false); void load(true) }, onClose: () => setKeyDialog(false) }) : null)
    }

    const name = 'dsh-model'
    const inject = []
    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-model', order: 25, label: () => 'dsh-model' }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-model] 设置页注册失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { until, pct, ms } }
    return module.exports
  },
})
