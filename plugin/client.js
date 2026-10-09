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

    function Usage({ usage, subscribeUrl }) {
      if (!usage) return null
      if (usage.noAccess) {
        return h('div', { style: { ...S.line, alignItems: 'flex-start', fontSize: 12, color: C.warn, marginTop: 6, paddingLeft: 46, lineHeight: 1.6 } },
          h('span', { style: S.grow }, L(`当前账号没有可用订阅，调用会被拒绝（不会扣费），所以它的模型已在 dsh 中隐藏。开通后把开关关掉再打开即可恢复。${usage.error ? `（${usage.error}）` : ''}`, 'This account has no usable subscription — calls are refused (no charge), so its models are hidden in dsh. After subscribing, turn the switch off and on again.')),
          subscribeUrl ? h('a', { href: subscribeUrl, target: '_blank', rel: 'noopener noreferrer', style: { ...S.btnPrimary, textDecoration: 'none', flex: 'none' } }, L('去开通 ↗', 'Subscribe ↗')) : null)
      }
      if (usage.unsupported) return h('div', { style: { ...S.meta, marginTop: 6, paddingLeft: 46 } }, L('已实测可以调用；用量暂不支持查询', 'Tested OK; usage not available yet'))
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

    async function copy(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // 非安全上下文（http 访问）没有 clipboard API：退回老办法
        try {
          const t = document.createElement('textarea')
          t.value = text
          t.style.position = 'fixed'
          t.style.opacity = '0'
          document.body.appendChild(t)
          t.select()
          const done = document.execCommand('copy')
          t.remove()
          return done
        } catch {
          return false
        }
      }
    }

    /** 复制按钮：get 可以是异步取值（例如取完整 key）；点完显示"已复制" */
    function CopyButton({ get, label, style }) {
      const [state, setState] = useState('')
      const timer = useRef(null)
      useEffect(() => () => clearTimeout(timer.current), [])
      const onClick = async () => {
        let done = false
        try { done = await copy(typeof get === 'function' ? await get() : get) } catch { done = false }
        setState(done ? 'ok' : 'fail')
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setState(''), 1500)
      }
      return h('button', { type: 'button', style: { ...S.btn, ...(style || {}), ...(state === 'ok' ? { color: C.ok } : state === 'fail' ? { color: C.err } : {}) }, onClick },
        state === 'ok' ? L('已复制', 'Copied') : state === 'fail' ? L('复制失败', 'Copy failed') : (label || L('复制', 'Copy')))
    }

    // —— 访问地址 ——
    function EndpointCard({ endpoints }) {
      if (!endpoints) return null
      const rows = [
        ...(endpoints.public ? [{ id: 'public', name: L('外网地址', 'Public'), url: endpoints.public, note: L('你的电脑、手机或其他软件用这个', 'Use this from your computer, phone or other tools') }] : []),
        { id: 'local', name: L('本机地址', 'Local'), url: endpoints.local, note: endpoints.public ? L('只在这台服务器上能用（dsh 自己用的就是它）', 'Only works on this server (dsh itself uses it)') : L('只在本机能用；要从别的设备访问，在服务器上执行 dsh-model remote enable', 'Only works on this machine; to reach it from other devices run dsh-model remote enable') },
      ]
      return h('div', { style: S.section },
        h('div', { style: S.h }, L('访问地址', 'Endpoint')),
        h('p', { style: S.note }, L('所有模型都经同一个 OpenAI 兼容端点提供：Base URL 填下面的地址，API key 用下方任意一把。', 'Every model is served from one OpenAI-compatible endpoint: use the address below as Base URL and any key below as the API key.')),
        h('div', { style: S.card }, rows.map((r, i) => h('div', { key: r.id, style: i ? S.row : S.rowFirst },
          h('div', { style: S.line },
            h('span', { style: { ...S.label, width: 72, flex: 'none' } }, r.name),
            h('code', { style: { ...S.mono, ...S.grow, wordBreak: 'break-all' } }, r.url),
            h(CopyButton, { get: r.url })),
          h('div', { style: { ...S.meta, paddingLeft: 82 } }, r.note)))))
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
      const submit = async (value) => {
        const v = String(value ?? paste).trim()
        if (!v) return
        if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/.*[?&]code=/i.test(v)) {
          setMsg(L('这不像授权后的跳转地址：应以 http://localhost 或 http://127.0.0.1 开头，并带 code=', 'This does not look like the redirect address: it should start with http://localhost or http://127.0.0.1 and contain code='))
          return
        }
        setMsg(L('已提交，等待确认…', 'Submitted, waiting…'))
        try { await api('POST', `/login/${encodeURIComponent(session.id)}/callback`, { redirectUrl: v }) } catch (e) { setMsg(e.message) }
      }
      const fromClipboard = async () => {
        try {
          const t = (await navigator.clipboard.readText()).trim()
          setPaste(t)
          await submit(t)
        } catch {
          setMsg(L('浏览器不允许读剪贴板：请手动粘贴到输入框', 'The browser blocked clipboard access: paste into the box manually'))
        }
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
          h('div', { style: { ...S.note, color: C.text } },
            h('div', null, L('授权完成后还差一步：', 'One more step after approving:')),
            h('div', null, L('① 浏览器会跳到一个打不开的页面（「无法访问此网站」「拒绝连接」），地址以 http://localhost 或 http://127.0.0.1 开头——这是正常的。', '① The browser lands on a page that cannot load ("This site can\'t be reached"), starting with http://localhost or http://127.0.0.1 — that is expected.')),
            h('div', null, L('② 复制那个页面地址栏里的完整地址，回到这里点「从剪贴板粘贴」（或粘到输入框点提交）。', '② Copy the full address from its address bar, come back and press "Paste from clipboard" (or paste into the box and submit).')),
            h('div', { style: { color: C.sub } }, L(`这个跳转地址是 ${source.label} 写死的，服务商只接受它，没法换成网址；所以要你把它带回来。`, `${source.label} fixes this redirect address and accepts nothing else, so it cannot be a web URL; you carry it back instead.`))),
          h('div', { style: S.line },
            h('input', { style: { ...S.input, ...S.grow }, placeholder: 'http://127.0.0.1:…/callback?code=…', value: paste, onChange: (e) => setPaste(e.target.value), onPaste: (e) => { const t = e.clipboardData?.getData('text'); if (t) setTimeout(() => void submit(t), 0) } }),
            h('button', { type: 'button', style: S.btnPrimary, onClick: fromClipboard }, L('从剪贴板粘贴', 'Paste from clipboard')),
            h('button', { type: 'button', style: S.btn, onClick: () => void submit() }, L('提交', 'Submit')))) : null,
        h('p', { style: { ...S.note, marginTop: 4 } }, L('授权页本身报错（例如 Operation timed out、糟糕出错了）多半是你的浏览器访问该网站的网络问题：换个代理节点，在那个页面点「重试」。', 'If the authorization page itself errors (e.g. "Operation timed out"), it is usually your browser\'s network path to that site: switch proxy nodes and press Retry on that page.')),
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
    const RISKY_KEY = 'dsh-model.showRisky'
    const readRisky = () => {
      try { return window.localStorage.getItem(RISKY_KEY) === '1' } catch { return false }
    }
    /** 勾选这个来源的哪些模型显示在 dsh 里（统一端点照常提供全部） */
    function ModelPicker({ source, onClose }) {
      const [data, setData] = useState(null)
      const [sel, setSel] = useState(new Set())
      const [q, setQ] = useState('')
      const [msg, setMsg] = useState('')
      const [saving, setSaving] = useState(false)
      useEffect(() => {
        let alive = true
        api('GET', `/sources/${source.id}/models`).then((r) => {
          if (!alive) return
          setData(r)
          setSel(new Set(r.models.filter((m) => m.selected).map((m) => m.id)))
        }, (e) => alive && setMsg(e.message))
        return () => { alive = false }
      }, [source.id])
      if (errCode === 'daemon_not_configured' || errCode === 'daemon_unreachable') return h(Onboarding, { code: errCode, onDone: () => void load(true) })
      if (!data) return h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 8 } }, msg || L('加载中…', 'Loading…'))
      const flip = (id) => setSel((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n })
      const save = async (models) => {
        setSaving(true)
        setMsg('')
        try {
          await api('POST', `/sources/${source.id}/models`, { models })
          onClose(true)
        } catch (e) {
          setMsg(e.message)
        } finally {
          setSaving(false)
        }
      }
      const shown = data.models.filter((m) => !q || `${m.name} ${m.id}`.toLowerCase().includes(q.toLowerCase()))
      return h('div', { style: { marginTop: 10, marginLeft: 46, padding: 10, border: `1px solid ${C.border}`, borderRadius: 8 } },
        h('div', { style: { ...S.line, marginBottom: 6, flexWrap: 'wrap' } },
          h('span', { style: { ...S.meta, ...S.grow } }, L(`勾选的模型显示在 dsh 的模型列表里（已选 ${sel.size} / ${data.models.length}）。其他软件经统一端点仍可用全部模型。`, `Checked models appear in dsh's model list (${sel.size} / ${data.models.length} selected). Other tools can still use every model through the endpoint.`)),
          data.models.length > 10 ? h('input', { style: { ...S.input, width: 140 }, placeholder: L('搜索', 'Search'), value: q, onChange: (e) => setQ(e.target.value) }) : null),
        h('div', { style: { maxHeight: 300, overflowY: 'auto' } }, shown.map((m) => h('label', { key: m.id, style: { ...S.line, minHeight: 26, fontSize: 13, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: sel.has(m.id), onChange: () => flip(m.id) }),
          h('span', { style: S.grow }, m.name),
          m.recommended ? h('span', { style: { fontSize: 11, color: C.accent } }, L('推荐', 'Suggested')) : null))),
        msg ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, msg) : null,
        h('div', { style: { ...S.line, marginTop: 8, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: S.btnPrimary, disabled: saving, onClick: () => save([...sel]) }, saving ? L('保存中…', 'Saving…') : L('保存', 'Save')),
          h('button', { type: 'button', style: S.btn, disabled: saving, onClick: () => save(null) }, L('恢复推荐', 'Use suggested')),
          h('button', { type: 'button', style: S.btn, onClick: () => setSel(new Set(data.models.map((m) => m.id))) }, L('全选', 'All')),
          h('button', { type: 'button', style: S.btn, onClick: () => setSel(new Set()) }, L('全不选', 'None')),
          h('span', { style: S.grow }),
          h('button', { type: 'button', style: S.btn, onClick: () => onClose(false) }, L('取消', 'Cancel'))))
    }

    function SourcesCard({ sources, reload, onLogin, onKey }) {
      const [picking, setPicking] = useState('')
      const [busy, setBusy] = useState({})
      const [err, setErr] = useState('')
      const [showRisky, setShowRisky] = useState(readRisky)
      const toggleRisky = (v) => {
        setShowRisky(v)
        try { window.localStorage.setItem(RISKY_KEY, v ? '1' : '0') } catch { /* 无痕模式等：只在本次生效 */ }
      }
      // 高风险来源默认隐藏；已登录的照常显示，方便退出登录
      const visible = sources.filter((s) => showRisky || !s.risky || s.loggedIn)
      const hidden = sources.length - visible.length
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
        h('div', { style: S.line },
          h('div', { style: { ...S.h, ...S.grow, margin: 0 } }, L('来源', 'Sources')),
          h('label', { style: { ...S.meta, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: showRisky, onChange: (e) => toggleRisky(e.target.checked) }),
            L(`显示高风险来源${!showRisky && hidden ? `（${hidden}）` : ''}`, `Show high-risk sources${!showRisky && hidden ? ` (${hidden})` : ''}`))),
        h('p', { style: S.note }, L('打开就接入，没登录会弹出登录；关闭只停用，登录保留。标「需付费」的来源，要先在那家开通套餐，登录后才能用。', 'Turn on to connect (signs in if needed); turning off keeps the sign-in. Sources marked Paid need a plan from that provider before they work.')),
        err ? h('div', { style: { fontSize: 12, color: C.err, margin: '0 0 8px' } }, err) : null,
        showRisky ? h('p', { style: { ...S.note, color: C.warn } }, L('高风险来源（Claude、Antigravity）：服务商有封禁第三方使用订阅的先例，账号可能被封。仅在你清楚风险时使用。', 'High-risk sources (Claude, Antigravity): the providers have banned third-party use of subscriptions before; your account may be suspended. Use only if you accept the risk.')) : null,
        h('div', { style: S.card }, visible.map((s, i) => h('div', { key: s.id, style: i ? S.row : S.rowFirst },
          h('div', { style: S.line },
            h(Switch, { on: s.enabled, busy: busy[s.id], label: s.label, onChange: (on) => toggle(s, on) }),
            h('div', { style: S.grow },
              h('span', { style: S.label }, s.label),
              h(PriceTag, { pricing: s.pricing }),
              s.risky ? h('span', { style: { fontSize: 11, color: C.err, marginLeft: 6, border: `1px solid ${C.err}`, borderRadius: 4, padding: '0 4px' } }, L('高风险', 'High risk')) : null,
              h('span', { style: { ...S.meta, marginLeft: 8 } },
                s.loggedIn ? (s.account || '') : L('未登录', 'Signed out'),
                s.models ? ` · ${L(`${s.models} 个模型`, `${s.models} models`)}` : '')),
            s.loggedIn && s.enabled && s.models && !s.usage?.noAccess ? h('button', { type: 'button', style: S.btn, onClick: () => setPicking(picking === s.id ? '' : s.id) }, L('选模型', 'Models')) : null,
            s.loggedIn && s.kind !== 'opencode' ? h('button', { type: 'button', style: S.btn, onClick: () => logout(s) }, L('退出登录', 'Sign out')) : null,
            s.kind === 'opencode' && s.loggedIn ? h('button', { type: 'button', style: S.btn, onClick: onKey }, L('换 key', 'Change key')) : null),
          picking === s.id ? h(ModelPicker, { source: s, onClose: (saved) => { setPicking(''); if (saved) void reload() } }) : null,
          s.enabled ? h(Usage, { usage: s.usage, subscribeUrl: s.subscribeUrl }) : null,
          !s.loggedIn && s.pricing ? h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 4 } },
            L(s.pricing.zh, s.pricing.en),
            s.subscribeUrl && s.pricing.tier !== 'free' ? h('a', { href: s.subscribeUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: C.accent, marginLeft: 8 } }, s.kind === 'opencode' ? L('去充值 ↗', 'Top up ↗') : L('看套餐 ↗', 'Plans ↗')) : null) : null,
          !s.loggedIn && s.detail ? h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 4 } }, s.detail) : null))))
    }

    /** 费用标签：免费 / 免费·额度少 / 需付费 */
    function PriceTag({ pricing }) {
      if (!pricing) return null
      const color = pricing.tier === 'free' ? C.ok : pricing.tier === 'limited' ? C.warn : C.err
      const text = pricing.tier === 'free' ? L('免费', 'Free') : pricing.tier === 'limited' ? L('免费·额度少', 'Free · limited') : L('需付费', 'Paid')
      return h('span', { title: L(pricing.zh, pricing.en), style: { fontSize: 11, color, marginLeft: 6, border: `1px solid ${color}`, borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap' } }, text)
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
        h('p', { style: S.note }, L('OpenAI 格式，点「复制」拿完整 key。dsh 用名为 dsh 的那把（自动配置）；其他设备或软件各领一把，丢了就吊销。下面是最近 24 小时的状态。', 'OpenAI-style; click Copy to get the full key. dsh uses the "dsh" key (configured automatically); give each other device or tool its own key and revoke it if lost. Stats cover the last 24 hours.')),
        err ? h('div', { style: { fontSize: 12, color: C.err, margin: '0 0 8px' } }, err) : null,
        fresh ? h('div', { style: { ...S.card, padding: 12, marginBottom: 10 } },
          h('div', { style: S.meta }, L(`新 key「${fresh.name}」只显示这一次：`, `New key "${fresh.name}" is shown only once:`)),
          h('div', { style: { ...S.line, marginTop: 6 } }, h('code', { style: { ...S.mono, ...S.grow, wordBreak: 'break-all' } }, fresh.key), h(CopyButton, { get: fresh.key }), h('button', { type: 'button', style: S.btn, onClick: () => setFresh(null) }, L('我已保存', 'Saved')))) : null,
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
                h('td', { style: { ...S.td, textAlign: 'right', whiteSpace: 'nowrap' } },
                  h(CopyButton, { get: async () => (await api('POST', `/keys/${encodeURIComponent(k.name)}/reveal`)).key, style: { marginRight: 6 } }),
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

    /** 守护进程还没装 / 没在运行：说明 + 一键安装（本机）或命令（VPS 上要 root） */
    function Onboarding({ code, onDone }) {
      const [busy, setBusy] = useState(false)
      const [res, setRes] = useState(null)
      const notInstalled = code === 'daemon_not_configured'
      const action = notInstalled ? 'setup' : 'repair'
      const run = async () => {
        setBusy(true)
        setRes(null)
        try {
          const r = await fetch('/api-dsh-model/setup', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-dsh-model-token': token },
            body: JSON.stringify({ action, lang: isZh() ? 'zh' : 'en' }),
          })
          const j = await r.json().catch(() => ({}))
          if (r.status === 403 && j?.error?.code === 'refused') { await refreshToken(); setBusy(false); return run() }
          setRes(j)
          if (j.code === 0) setTimeout(onDone, 1500)
        } catch (e) {
          setRes({ code: -1, output: e.message })
        } finally {
          setBusy(false)
        }
      }
      const cmds = notInstalled ? ['npm install -g dsh-model', 'dsh-model setup'] : ['dsh-model repair']
      const vpsCmds = notInstalled ? ['sudo npm install -g dsh-model', 'sudo dsh-model setup'] : ['sudo dsh-model repair']
      const cmdBlock = (list) => h('div', { style: { ...S.card, padding: '8px 12px', marginTop: 8 } }, list.map((c) => h('div', { key: c, style: { ...S.line, minHeight: 30 } }, h('code', { style: { ...S.mono, ...S.grow } }, c), h(CopyButton, { get: c }))))
      return h('div', { style: { color: C.text, maxWidth: 820 } },
        h('div', { style: S.section },
          h('div', { style: S.h }, notInstalled ? L('还差一步：在这台机器上装好 dsh-model', 'One more step: set up dsh-model on this machine') : L('dsh-model 的服务没在运行', 'The dsh-model service is not running')),
          h('p', { style: S.note }, notInstalled
            ? L('这个页面只是管理界面；模型由 dsh-model 在本机运行的服务提供（统一端点、WorkBuddy bridge、登录与用量）。装好后，来源、key 和模型都在这里管理。', 'This page is only the control panel; models are served by dsh-model\'s local service (the unified endpoint, WorkBuddy bridge, sign-ins and usage). Once it is set up, manage sources, keys and models here.')
            : L('可能是电脑重启后服务没起来，或者刚升级。修复会按记录重新注册并启动服务。', 'The service may not have started after a reboot, or was just upgraded. Repair re-registers and starts it from the saved records.')),
          res?.vps ? h('div', null,
            h('p', { style: { ...S.note, color: C.text } }, L('这是 dsh-vps 服务器：安装要 root 权限，请在服务器终端里执行：', 'This is a dsh-vps server: setup needs root, so run this in a server terminal:')),
            cmdBlock(vpsCmds),
            h('p', { style: { ...S.note, marginTop: 8 } }, L('装好后刷新本页。', 'Reload this page when done.'))) : h('div', null,
            h('div', { style: S.line },
              h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: run }, busy ? (notInstalled ? L('安装中…（约 1 分钟）', 'Setting up… (about a minute)') : L('修复中…', 'Repairing…')) : (notInstalled ? L('一键安装', 'Set up now') : L('修复', 'Repair'))),
              h('button', { type: 'button', style: S.btn, onClick: onDone }, L('重新检测', 'Check again'))),
            h('p', { style: { ...S.note, marginTop: 10 } }, L('也可以在终端里执行：', 'Or run in a terminal:')),
            cmdBlock(cmds)),
          res && !res.vps ? h('div', { style: { marginTop: 12 } },
            h('div', { style: { fontSize: 12, color: res.code === 0 ? C.ok : C.err, marginBottom: 6 } }, res.code === 0 ? L('完成，正在加载…', 'Done, loading…') : L(`没有完成（退出码 ${res.code}），输出如下：`, `Did not finish (exit code ${res.code}); output:`)),
            h('pre', { style: { ...S.mono, ...S.card, padding: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, res.output || '')) : null))
    }

    // —— 整页 ——
    function SettingsSection() {
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [errCode, setErrCode] = useState('')
      const [login, setLogin] = useState(null)
      const [keyDialog, setKeyDialog] = useState(false)
      const alive = useRef(true)
      const load = useCallback(async (refresh) => {
        try {
          const [sources, keys, stats, endpoints] = await Promise.all([api('GET', refresh ? '/sources?refresh=1' : '/sources'), api('GET', '/keys'), api('GET', '/stats'), api('GET', '/endpoints').catch(() => null)])
          if (alive.current) { setData({ sources, keys, stats, endpoints }); setErr(''); setErrCode('') }
        } catch (e) {
          if (alive.current) { setErr(e.hint ? `${e.message}（${e.hint}）` : e.message); setErrCode(e.code || '') }
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
        h(EndpointCard, { endpoints: data.endpoints }),
        h(SourcesCard, { sources: data.sources, reload: () => load(false), onLogin: (s, session) => setLogin({ source: s, session }), onKey: () => setKeyDialog(true) }),
        h(KeysCard, { keys: data.keys, reload: () => load(false) }),
        h(ModelsCard, { stats: data.stats }),
        login ? h(LoginDialog, { source: login.source, session: login.session, onDone: () => { setLogin(null); void load(true) }, onClose: () => { setLogin(null); void load(false) } }) : null,
        keyDialog ? h(KeyDialog, { onDone: () => { setKeyDialog(false); void load(true) }, onClose: () => setKeyDialog(false) }) : null)
    }

    const name = 'dsh-model'
    // 用到的服务必须先声明，否则 ctx.slots 读不到（实测：cannot get property "slots" without inject）
    const inject = ['slots']
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
