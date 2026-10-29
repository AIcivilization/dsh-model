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
        body: JSON.stringify({ method, path, lang: isZh() ? 'zh' : 'en', ...(body !== undefined ? { body } : {}) }),
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

    /** 距离 iso 还有多久："2 天 3 小时" / "3 小时 5 分" / "12 分"；已过去返回 '' */
    const dur = (iso) => {
      const ms = iso ? Date.parse(iso) - Date.now() : NaN
      if (!(ms > 0)) return ''
      const m = Math.max(1, Math.round(ms / 60000))
      const d = Math.floor(m / 1440)
      const hh = Math.floor((m % 1440) / 60)
      const mm = m % 60
      return d ? L(`${d} 天 ${hh} 小时`, `${d}d ${hh}h`) : hh ? L(`${hh} 小时 ${mm} 分`, `${hh}h ${mm}m`) : L(`${mm} 分`, `${mm}m`)
    }
    const until = (iso) => {
      if (!iso) return ''
      const t = dur(iso)
      return t ? L(`${t}后重置`, `resets in ${t}`) : L('即将重置', 'resetting')
    }
    /** 额度用完了吗：用完的窗口里最晚恢复的那个时间（全部恢复才能用）；积分用完也算 */
    const exhausted = (usage) => {
      if (!usage || usage.noAccess) return null
      const full = (usage.windows || []).filter((w) => w.usedPercent != null && w.usedPercent >= 100)
      if (full.length) {
        const at = full.map((w) => w.resetAt).filter(Boolean).sort().pop()
        return { at }
      }
      const c = usage.credits
      if (c && !c.unlimited && c.remaining <= 0) return { at: c.next && c.next.renews ? c.next.at : undefined }
      return null
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
          h('span', null, c.unlimited ? L('不限量', 'Unlimited') : L(`剩余 ${c.remaining.toLocaleString()}${c.total ? ` / ${c.total.toLocaleString()}` : ''}`, `${c.remaining.toLocaleString()} left${c.total ? ` of ${c.total.toLocaleString()}` : ''}`)),
          c.next && dur(c.next.at) ? h('span', { style: { color: !c.next.renews && Date.parse(c.next.at) - Date.now() < 3 * 86400000 ? C.warn : C.faint } },
            c.next.renews
              ? (c.next.amount ? L(`${c.next.amount.toLocaleString()} 积分 ${dur(c.next.at)}后重置`, `${c.next.amount.toLocaleString()} reset in ${dur(c.next.at)}`) : L(`${dur(c.next.at)}后重置`, `resets in ${dur(c.next.at)}`))
              : L(`${c.next.amount.toLocaleString()} 积分 ${dur(c.next.at)}后到期，先用这些`, `${c.next.amount.toLocaleString()} expire in ${dur(c.next.at)}; use them first`)) : null))
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

    /** 填 API key：OpenCode Zen，以及 Gemini / Groq / OpenRouter / 硅基流动 / DeepSeek / 其他 OpenAI 兼容服务 */
    function KeyDialog({ source, onDone, onClose }) {
      const opencode = !source || source.kind === 'opencode'
      const custom = source && source.id === 'custom'
      const [key, setKey] = useState('')
      const [base, setBase] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const submit = async () => {
        setBusy(true)
        setMsg(opencode ? L('正在用一个免费模型实测这把 key…', 'Testing the key against a free model…') : L('正在用这把 key 读取模型列表…', 'Reading the model list with this key…'))
        try {
          if (opencode) await api('POST', '/opencode/key', { key: key.trim() })
          else await api('POST', `/apikey/${source.id}`, { key: key.trim(), ...(custom ? { baseUrl: base.trim() } : {}) })
          onDone()
        } catch (e) {
          setMsg(e.hint ? `${e.message}（${e.hint}）` : e.message)
          setBusy(false)
        }
      }
      const label = opencode ? 'OpenCode Zen' : source.label
      const link = opencode ? 'https://opencode.ai/auth' : source.subscribeUrl
      return h(Modal, { title: label, onClose },
        h('p', { style: S.note },
          opencode
            ? L('需要你的 OpenCode Zen API key（要先充值）。写入前会先用一个免费模型实测。', 'Needs your OpenCode Zen API key (top-up required). It is tested against a free model first.')
            : custom
              ? L('填服务的地址（以 /v1 结尾）和 API key。保存前会用它读取一次模型列表，读得到才保存。', 'Enter the service URL (ending in /v1) and the API key. It reads the model list once before saving.')
              : L(`填 ${label} 的 API key。保存前会用它读取一次模型列表（不花额度），读得到才保存。${source.pricing ? source.pricing.zh + '。' : ''}`, `Enter your ${label} API key. It reads the model list once before saving (no quota used).${source.pricing ? ' ' + source.pricing.en + '.' : ''}`),
          link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer', style: { color: C.accent, marginLeft: 6 } }, L('去创建 key ↗', 'Create a key ↗')) : null),
        custom ? h('div', { style: { ...S.line, marginBottom: 8 } }, h('input', { style: { ...S.input, ...S.grow }, placeholder: 'https://api.example.com/v1', value: base, onChange: (e) => setBase(e.target.value) })) : null,
        h('div', { style: S.line },
          h('input', { type: 'password', style: { ...S.input, ...S.grow }, placeholder: 'API key', value: key, onChange: (e) => setKey(e.target.value) }),
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !key.trim() || (custom && !base.trim()), onClick: submit }, L('保存', 'Save'))),
        msg ? h('div', { style: { ...S.meta, marginTop: 8 } }, msg) : null)
    }

    // —— 来源 ——
    const RISKY_KEY = 'dsh-model.showRisky'
    const REST_KEY = 'dsh-model.showSignedOut'
    /** 用户选过就按他选的；没选过返回 null（由是否已有登录的来源决定） */
    const readShowRest = () => {
      try {
        const v = window.localStorage.getItem(REST_KEY)
        return v === '1' ? true : v === '0' ? false : null
      } catch {
        return null
      }
    }
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
      const [tests, setTests] = useState({})
      const test = async (id) => {
        setTests((t) => ({ ...t, [id]: { running: true } }))
        try {
          const r = await api('POST', '/models/test', { model: id })
          setTests((t) => ({ ...t, [id]: r }))
        } catch (e) {
          setTests((t) => ({ ...t, [id]: { ok: false, advice: e.message } }))
        }
      }
      useEffect(() => {
        let alive = true
        api('GET', `/sources/${source.id}/models`).then((r) => {
          if (!alive) return
          setData(r)
          setSel(new Set(r.models.filter((m) => m.selected).map((m) => m.id)))
        }, (e) => alive && setMsg(e.message))
        return () => { alive = false }
      }, [source.id])
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
          m.recommended ? h('span', { style: { fontSize: 11, color: C.accent } }, L('推荐', 'Suggested')) : null,
          tests[m.id] ? h('span', { style: { fontSize: 11, color: tests[m.id].running ? C.sub : tests[m.id].ok ? C.ok : C.err, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: tests[m.id].message || tests[m.id].reply || '' },
            tests[m.id].running ? L('测试中…', 'Testing…') : tests[m.id].ok ? L(`可用 · ${(tests[m.id].ms / 1000).toFixed(1)} 秒${tests[m.id].reply ? ` · ${tests[m.id].reply}` : ''}`, `OK · ${(tests[m.id].ms / 1000).toFixed(1)}s${tests[m.id].reply ? ` · ${tests[m.id].reply}` : ''}`) : (tests[m.id].advice || L('不可用', 'Not working'))) : null,
          tests[m.id]?.ok && tests[m.id].note ? h('span', { style: { fontSize: 11, color: C.warn } }, tests[m.id].note) : null,
          h('button', { type: 'button', style: { ...S.btn, padding: '2px 8px' }, disabled: tests[m.id]?.running, onClick: (e) => { e.preventDefault(); void test(m.id) } }, L('测一下', 'Test'))))),
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
          else if ((s.kind === 'opencode' || s.kind === 'apikey') && !s.loggedIn) onKey(s)
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
        if (!window.confirm(s.kind === 'apikey' ? L(`删除 ${s.label} 的 key？（它的模型会从 dsh 里消失）`, `Remove the ${s.label} key? (its models disappear from dsh)`) : L(`退出 ${s.label} 的登录？（它的模型会从 dsh 里消失）`, `Sign out of ${s.label}? (its models disappear from dsh)`))) return
        try { await api('POST', `/sources/${s.id}/logout`); await reload() } catch (e) { setErr(e.message) }
      }
      // 已登录的照常列出；没登录的收进一个可折叠的列表（默认收起；一个都没登录时默认展开）
      // 顶部只放正在用的（已登录且打开）；没登录的、关掉的都收进折叠列表
      const signedIn = visible.filter((s) => s.loggedIn && s.enabled)
      const rest = visible.filter((s) => !(s.loggedIn && s.enabled))
      const [restPref, setRestPref] = useState(readShowRest)
      const openRest = restPref ?? signedIn.length === 0
      const toggleRest = (v) => {
        setRestPref(v)
        try { window.localStorage.setItem(REST_KEY, v ? '1' : '0') } catch { /* 无痕模式：只在本次生效 */ }
      }
      const row = (s, i) => h('div', { key: s.id, style: i ? S.row : S.rowFirst },
          h('div', { style: S.line },
            h(Switch, { on: s.enabled, busy: busy[s.id], label: s.label, onChange: (on) => toggle(s, on) }),
            h('div', { style: S.grow },
              h('span', { style: S.label }, s.label),
              h(PriceTag, { pricing: s.pricing }),
              s.risky ? h('span', { style: { fontSize: 11, color: C.err, marginLeft: 6, border: `1px solid ${C.err}`, borderRadius: 4, padding: '0 4px' } }, L('高风险', 'High risk')) : null,
              (() => {
                const x = s.enabled ? exhausted(s.usage) : null
                if (!x) return null
                const t = dur(x.at)
                return h('span', { style: { fontSize: 11, color: C.err, marginLeft: 6, border: `1px solid ${C.err}`, borderRadius: 4, padding: '0 4px' } }, t ? L(`已用完 · ${t}后恢复`, `Used up · back in ${t}`) : L('已用完', 'Used up'))
              })(),
              h('span', { style: { ...S.meta, marginLeft: 8 } },
                s.loggedIn ? (s.account || '') : s.kind === 'local' ? L('未运行', 'Not running') : L('未登录', 'Signed out'),
                s.models ? ` · ${L(`${s.models} 个模型`, `${s.models} models`)}` : '',
                s.loggedIn && s.kind === 'apikey' && s.detail ? ` · ${s.detail}` : '')),
            s.loggedIn && s.enabled && s.models && !s.usage?.noAccess ? h('button', { type: 'button', style: S.btn, onClick: () => setPicking(picking === s.id ? '' : s.id) }, L('选模型', 'Models')) : null,
            s.loggedIn && s.kind !== 'opencode' && s.kind !== 'local' ? h('button', { type: 'button', style: S.btn, onClick: () => logout(s) }, s.kind === 'apikey' ? L('删除 key', 'Remove key') : L('退出登录', 'Sign out')) : null,
            (s.kind === 'opencode' || s.kind === 'apikey') && s.loggedIn ? h('button', { type: 'button', style: S.btn, onClick: () => onKey(s) }, L('换 key', 'Change key')) : null),
          picking === s.id ? h(ModelPicker, { source: s, onClose: (saved) => { setPicking(''); if (saved) void reload() } }) : null,
          s.kind === 'workbuddy' && s.loggedIn ? h('div', { style: { fontSize: 12, color: C.warn, paddingLeft: 46, marginTop: 4, lineHeight: 1.6 } }, L('注意：WorkBuddy 现在会认出 dsh 发出的对话并拦下（「请求被拦截」），「测一下」能通也不代表能用。积分建议在官方 WorkBuddy 软件里用；签到照常。', 'Note: WorkBuddy now recognises conversations sent by dsh and blocks them ("请求被拦截"); a passing Test does not mean it works. Use the credits in the official WorkBuddy app; check-in still works.')) : null,
          s.enabled ? h(Usage, { usage: s.usage, subscribeUrl: s.subscribeUrl }) : null,
          !s.loggedIn && s.pricing ? h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 4 } },
            L(s.pricing.zh, s.pricing.en),
            s.subscribeUrl && s.kind === 'local' ? h('a', { href: s.subscribeUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: C.accent, marginLeft: 8 } }, L('去下载 ↗', 'Download ↗')) : null,
            s.subscribeUrl && s.pricing.tier !== 'free' ? h('a', { href: s.subscribeUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: C.accent, marginLeft: 8 } }, s.kind === 'opencode' ? L('去充值 ↗', 'Top up ↗') : L('看套餐 ↗', 'Plans ↗')) : null) : null,
          !s.loggedIn && s.detail ? h('div', { style: { ...S.meta, paddingLeft: 46, marginTop: 4 } }, s.detail) : null)
      return h('div', { style: S.section },
        h('div', { style: S.line },
          h('div', { style: { ...S.h, ...S.grow, margin: 0 } }, L('来源', 'Sources')),
          h('label', { style: { ...S.meta, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: showRisky, onChange: (e) => toggleRisky(e.target.checked) }),
            L(`显示高风险来源${!showRisky && hidden ? `（${hidden}）` : ''}`, `Show high-risk sources${!showRisky && hidden ? ` (${hidden})` : ''}`))),
        h('p', { style: S.note }, L('打开就接入，没登录会弹出登录；关闭只停用，登录保留。标「需付费」的来源，要先在那家开通套餐，登录后才能用。', 'Turn on to connect (signs in if needed); turning off keeps the sign-in. Sources marked Paid need a plan from that provider before they work.')),
        err ? h('div', { style: { fontSize: 12, color: C.err, margin: '0 0 8px' } }, err) : null,
        showRisky ? h('p', { style: { ...S.note, color: C.warn } }, L('高风险来源（Claude、Antigravity）：服务商有封禁第三方使用订阅的先例，账号可能被封。仅在你清楚风险时使用。', 'High-risk sources (Claude, Antigravity): the providers have banned third-party use of subscriptions before; your account may be suspended. Use only if you accept the risk.')) : null,
        signedIn.length ? h('div', { style: S.card }, signedIn.map(row)) : h('div', { style: { ...S.note, margin: '0 0 8px' } }, L('还没有接入任何来源：展开下面的列表挑一个。', 'No source connected yet: open the list below and pick one.')),
        rest.length ? h('button', { type: 'button', style: { ...S.btn, marginTop: 10 }, 'aria-expanded': openRest, onClick: () => toggleRest(!openRest) },
          openRest ? L(`▾ 收起没在用的来源（${rest.length} 个：未登录或已关闭）`, `▾ Hide sources not in use (${rest.length}: signed out or off)`) : L(`▸ 没在用的来源（${rest.length} 个：未登录或已关闭）`, `▸ Sources not in use (${rest.length}: signed out or off)`)) : null,
        openRest && rest.length ? h('div', { style: { ...S.card, marginTop: 8 } }, rest.map(row)) : null)
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

    /**
     * 最近失败的请求：平时一行"最近 24 小时失败 N 次（多是…）▸"，点开看明细；「知道了」之后这一批不再显示，有新的失败才重新出现。
     * 已经自己恢复的（同一个模型之后又成功过）守护进程那边就去掉了。
     */
    const FAIL_ACK = 'dsh-model.failuresSeenAt'
    const readAck = () => {
      try { return Number(window.localStorage.getItem(FAIL_ACK)) || 0 } catch { return 0 }
    }
    const KIND_LABEL = {
      blocked: () => L('被服务商拦截', 'blocked by the provider'),
      rate: () => L('限流', 'rate limits'),
      quota: () => L('额度或套餐不足', 'quota or plan'),
      auth: () => L('登录或 key 失效', 'sign-in or key'),
      model: () => L('模型不存在', 'missing models'),
      upstream: () => L('上游或网络问题', 'upstream or network'),
      other: () => L('其他原因', 'other causes'),
    }
    /** 组合切换：几个模型按顺序排好，在 dsh 里就是一个模型；一个不行自动换下一个 */
    function CombosCard() {
      const [data, setData] = useState(null)
      const [editing, setEditing] = useState(null)
      const [err, setErr] = useState('')
      const load = useCallback(() => api('GET', '/combos').then((d) => { setData(d); setErr('') }, (e) => setErr(e.message)), [])
      useEffect(() => { void load() }, [load])
      if (!data) return err ? h('div', { style: S.section }, h('div', { style: { ...S.h } }, L('组合切换', 'Combos')), h('div', { style: { fontSize: 12, color: C.err } }, err)) : null
      const byId = new Map(data.models.map((m) => [m.id, m]))
      const pretty = (id) => { const m = byId.get(id); return m ? `${m.groupLabel} · ${m.name.split(' · ')[0]}` : id }
      const remove = async (c) => {
        if (!window.confirm(L(`删除组合「${c.name}」？（它会从 dsh 里消失）`, `Delete combo "${c.name}"? (it disappears from dsh)`))) return
        try { await api('DELETE', `/combos/${c.id}`); await load() } catch (e) { setErr(e.message) }
      }
      const canBuild = data.models.length >= 2
      return h('div', { style: S.section },
        h('div', { style: S.line },
          h('div', { style: { ...S.h, ...S.grow, margin: 0 } }, L('组合切换', 'Combos')),
          canBuild ? h('button', { type: 'button', style: S.btn, onClick: () => setEditing('new') }, L('新建组合', 'New combo')) : null),
        h('p', { style: S.note }, L('把几个模型按顺序排好，它在 dsh 里就是一个模型（「组合切换」分组）：先用第一个，限流、额度用完或出错就自动换下一个；已经开始回答后不再换。其他软件用模型名 combo/<id>。', 'Put a few models in order and it becomes one model in dsh (the "Combos" group): the first one is used, and on a rate limit, used-up quota or error the next one takes over; once an answer has started it stays put. Other tools use the model name combo/<id>.')),
        err ? h('div', { style: { fontSize: 12, color: C.err, margin: '0 0 8px' } }, err) : null,
        data.combos.length
          ? h('div', { style: S.card }, data.combos.map((c, i) => h('div', { key: c.id, style: i ? S.row : S.rowFirst },
              h('div', { style: S.line },
                h('div', { style: S.grow },
                  h('span', { style: S.label }, c.name),
                  h('span', { style: { ...S.meta, ...S.mono, marginLeft: 8 } }, `combo/${c.id}`)),
                h(CopyButton, { get: `combo/${c.id}`, label: L('复制模型名', 'Copy name') }),
                h('button', { type: 'button', style: S.btn, onClick: () => setEditing(c) }, L('编辑', 'Edit')),
                h('button', { type: 'button', style: S.btn, onClick: () => void remove(c) }, L('删除', 'Delete'))),
              h('div', { style: { ...S.meta, marginTop: 4, lineHeight: 1.7 } }, c.models.map((m, j) => h('span', { key: m },
                j ? ' → ' : '',
                h('span', { title: byId.has(m) ? m : L(`${m}：现在用不了（来源关了或没登录），会被跳过`, `${m}: not available now (source off or signed out); it is skipped`), style: byId.has(m) ? undefined : { color: C.err, textDecoration: 'line-through' } }, pretty(m))))))))
          : h('div', { style: S.meta }, canBuild ? L('还没有组合。例如「主力」：Codex → Kimi → WorkBuddy，订阅额度用完自动换到免费的。', 'No combos yet. For example "Main": Codex → Kimi → WorkBuddy, moving to a free source when the subscription quota runs out.') : L('至少接入两个模型后才能建组合。', 'Connect at least two models to build a combo.')),
        editing ? h(ComboDialog, { combo: editing === 'new' ? null : editing, models: data.models, onClose: (saved) => { setEditing(null); if (saved) void load() } }) : null)
    }

    function ComboDialog({ combo, models, onClose }) {
      const [name, setName] = useState(combo ? combo.name : '')
      const [list, setList] = useState(combo ? combo.models : [])
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const byId = new Map(models.map((m) => [m.id, m]))
      const groups = []
      for (const m of models) {
        let g = groups.find((x) => x.label === m.groupLabel)
        if (!g) groups.push((g = { label: m.groupLabel, models: [] }))
        g.models.push(m)
      }
      const MAX = 8
      const move = (i, d) => { const n = [...list]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setList(n) }
      const save = async () => {
        setBusy(true)
        setMsg('')
        try {
          if (combo) await api('PUT', `/combos/${combo.id}`, { name: name.trim(), models: list })
          else await api('POST', '/combos', { name: name.trim(), models: list })
          onClose(true)
        } catch (e) {
          setMsg(e.message)
          setBusy(false)
        }
      }
      return h(Modal, { title: combo ? L('编辑组合', 'Edit combo') : L('新建组合', 'New combo'), onClose: () => onClose(false) },
        h('div', { style: { ...S.line, marginBottom: 10 } },
          h('input', { style: { ...S.input, ...S.grow }, placeholder: L('名字，如：主力', 'Name, e.g. Main'), maxLength: 30, value: name, onChange: (e) => setName(e.target.value), 'aria-label': L('组合名字', 'Combo name') })),
        h('div', { style: { ...S.meta, marginBottom: 6 } }, L(`按尝试顺序排（第一个最先用），2–${MAX} 个：`, `In the order to try (the first goes first), 2–${MAX} models:`)),
        list.length ? h('div', { style: { ...S.card, marginBottom: 10 } }, list.map((id, i) => h('div', { key: id, style: { ...(i ? S.row : S.rowFirst), padding: '6px 10px' } },
          h('div', { style: S.line },
            h('span', { style: { ...S.meta, width: 18 } }, `${i + 1}.`),
            h('span', { style: { ...S.grow, fontSize: 13 } }, byId.has(id) ? `${byId.get(id).groupLabel} · ${byId.get(id).name}` : id),
            h('button', { type: 'button', style: S.btn, disabled: i === 0, onClick: () => move(i, -1), 'aria-label': L('上移', 'Move up') }, '↑'),
            h('button', { type: 'button', style: S.btn, disabled: i === list.length - 1, onClick: () => move(i, 1), 'aria-label': L('下移', 'Move down') }, '↓'),
            h('button', { type: 'button', style: S.btn, onClick: () => setList(list.filter((x) => x !== id)), 'aria-label': L('移除', 'Remove') }, '✕'))))) : null,
        list.length < MAX ? h('div', { style: { ...S.line, marginBottom: 12 } },
          h('select', { style: { ...S.input, ...S.grow }, value: '', 'aria-label': L('加一个模型', 'Add a model'), onChange: (e) => { const v = e.target.value; if (v && !list.includes(v)) setList([...list, v]) } },
            h('option', { value: '' }, L('加一个模型…', 'Add a model…')),
            groups.map((g) => h('optgroup', { key: g.label, label: g.label }, g.models.filter((m) => !list.includes(m.id)).map((m) => h('option', { key: m.id, value: m.id }, m.name)))))) : null,
        h('div', { style: S.line },
          msg ? h('span', { style: { ...S.grow, fontSize: 12, color: C.err } }, msg) : h('span', { style: S.grow }),
          h('button', { type: 'button', style: S.btn, onClick: () => onClose(false) }, L('取消', 'Cancel')),
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !name.trim() || list.length < 2, onClick: () => void save() }, busy ? L('保存中…', 'Saving…') : L('保存', 'Save'))))
    }

    function FailuresCard({ failures }) {
      const [open, setOpen] = useState(false)
      const [ack, setAck] = useState(readAck)
      const fresh = (failures || []).filter((f) => Date.parse(f.at) > ack)
      if (!fresh.length) return null
      const counts = {}
      for (const f of fresh) counts[f.kind] = (counts[f.kind] || 0) + 1
      const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]
      const color = (k) => (k === 'rate' || k === 'upstream' ? C.warn : C.err)
      const dismiss = () => {
        const latest = Math.max(...fresh.map((f) => Date.parse(f.at)))
        setAck(latest)
        setOpen(false)
        try { window.localStorage.setItem(FAIL_ACK, String(latest)) } catch { /* 无痕模式：只在本次生效 */ }
      }
      return h('div', { style: S.section },
        h('div', { style: { ...S.card, padding: '10px 14px' } },
          h('div', { style: S.line },
            h('button', { type: 'button', 'aria-expanded': open, onClick: () => setOpen(!open), style: { ...S.grow, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, color: color(top) } },
              `${open ? '▾' : '▸'} ${L(`最近 24 小时失败 ${fresh.length} 次（多是${(KIND_LABEL[top] || KIND_LABEL.other)()}）`, `${fresh.length} failed request${fresh.length > 1 ? 's' : ''} in 24 hours (mostly ${(KIND_LABEL[top] || KIND_LABEL.other)()})`)}`),
            h('button', { type: 'button', style: S.btn, onClick: dismiss }, L('知道了', 'Got it'))),
          open ? h('div', { style: { marginTop: 8 } },
            h('div', { style: { ...S.meta, marginBottom: 4 } }, L('经统一端点失败、之后也没再成功的请求。只记录模型和报错，不记录对话内容。', 'Requests that failed through the endpoint and have not succeeded since. Only the model and the error are kept, never the conversation.')),
            fresh.slice(0, 20).map((f, i) => h('div', { key: `${f.at}-${i}`, style: { borderTop: i ? `1px solid ${C.border}` : 'none', padding: '6px 0' } },
              h('div', { style: S.line },
                h('span', { style: { ...S.mono, ...S.grow, fontSize: 12, color: C.text } }, f.model || L('（未知模型）', '(unknown model)')),
                h('span', { style: { fontSize: 12, color: color(f.kind) } }, `HTTP ${f.status}`),
                h('span', { style: S.meta }, ago(f.at))),
              h('div', { style: { fontSize: 12, color: color(f.kind) } }, f.advice),
              f.message ? h('div', { style: { ...S.meta, ...S.mono, wordBreak: 'break-all' } }, f.message) : null))) : null))
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
      const setupCall = async (body, retried) => {
        const r = await fetch('/api-dsh-model/setup', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-model-token': token },
          body: JSON.stringify(body),
        })
        const j = await r.json().catch(() => ({}))
        if (r.status === 403 && !retried && j?.error?.code === 'refused') { await refreshToken(); return setupCall(body, true) }
        return j
      }
      const run = async () => {
        setBusy(true)
        setRes(null)
        try {
          let j = await setupCall({ action, lang: isZh() ? 'zh' : 'en' })
          if (j.vps) { setRes(j); return }
          // 每秒取一次新输出，一行一行显示出来
          while (j.running) {
            setRes({ ...j, code: null })
            await new Promise((r) => setTimeout(r, 1000))
            j = await setupCall({ poll: true })
          }
          setRes(j)
          if (j.code === 0) setTimeout(onDone, 1500)
        } catch (e) {
          setRes({ code: -1, output: e.message })
        } finally {
          setBusy(false)
        }
      }
      const cmds = notInstalled ? ['npm install -g dsh-model', 'dsh-model setup'] : ['dsh-model repair']
      // setup 什么缺了补什么（卸载到一半、服务被删了也能救回来），比 repair 稳
      const vpsCmds = notInstalled ? ['sudo npm install -g dsh-model', 'sudo dsh-model setup'] : ['sudo dsh-model setup']
      const cmdBlock = (list) => h('div', { style: { ...S.card, padding: '8px 12px', marginTop: 8 } }, list.map((c) => h('div', { key: c, style: { ...S.line, minHeight: 30 } }, h('code', { style: { ...S.mono, ...S.grow } }, c), h(CopyButton, { get: c }))))
      return h('div', { style: { color: C.text, maxWidth: 820 } },
        h('div', { style: S.section },
          h('div', { style: S.h }, notInstalled ? L('还差一步：在这台机器上装好 dsh-model', 'One more step: set up dsh-model on this machine') : L('dsh-model 的服务没在运行', 'The dsh-model service is not running')),
          h('p', { style: S.note }, notInstalled
            ? L('这个页面只是管理界面；模型由 dsh-model 在本机运行的服务提供（统一端点、WorkBuddy bridge、登录与用量）。装好后，来源、key 和模型都在这里管理。', 'This page is only the control panel; models are served by dsh-model\'s local service (the unified endpoint, WorkBuddy bridge, sign-ins and usage). Once it is set up, manage sources, keys and models here.')
            : L('可能是电脑重启后服务没起来，或者刚升级。修复会按记录重新注册并启动服务。', 'The service may not have started after a reboot, or was just upgraded. Repair re-registers and starts it from the saved records.')),
          res?.vps ? h('div', null,
            h('p', { style: { ...S.note, color: C.text } }, L('这是 dsh-vps 服务器：这一步要 root 权限，而这台机器上还没有 dsh-model 的管理员服务。请在服务器终端里执行一次（之后页面上的按钮就能用）：', 'This is a dsh-vps server: this needs root, and dsh-model\'s admin service is not on this machine yet. Run this once in a server terminal (the page buttons work afterwards):')),
            cmdBlock(vpsCmds),
            h('p', { style: { ...S.note, marginTop: 8 } }, L('装好后刷新本页。', 'Reload this page when done.'))) : h('div', null,
            h('div', { style: S.line },
              h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: run }, busy ? (notInstalled ? L('安装中…（约 1 分钟）', 'Setting up… (about a minute)') : L('修复中…', 'Repairing…')) : (notInstalled ? L('一键安装', 'Set up now') : L('修复', 'Repair'))),
              h('button', { type: 'button', style: S.btn, onClick: onDone }, L('重新检测', 'Check again'))),
            h('p', { style: { ...S.note, marginTop: 10 } }, L('也可以在终端里执行：', 'Or run in a terminal:')),
            cmdBlock(cmds)),
          res && !res.vps ? h('div', { style: { marginTop: 12 } },
            h('div', { style: { fontSize: 12, color: res.code === null ? C.sub : res.code === 0 ? C.ok : C.err, marginBottom: 6 } }, res.code === null ? L('进行中…', 'Working…') : res.code === 0 ? L('完成，正在加载…', 'Done, loading…') : L(`没有完成（退出码 ${res.code}），输出如下：`, `Did not finish (exit code ${res.code}); output:`)),
            h('pre', { style: { ...S.mono, ...S.card, padding: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, res.output || '')) : null))
    }

    const newer = (a, b) => {
      const pa = String(a || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
      const pb = String(b || '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
      return false
    }

    /** 版本、更新、卸载 */
    function AboutCard({ onJob }) {
      const [info, setInfo] = useState(null)
      const [confirming, setConfirming] = useState(false)
      const [keepAuth, setKeepAuth] = useState(false)
      const [err, setErr] = useState('')
      const [starting, setStarting] = useState(false)
      useEffect(() => {
        let alive = true
        // 服务比页面旧（没有 /self）：也要给出办法，不能整块不显示
        api('GET', '/self').then((r) => alive && setInfo(r), (e) => alive && setInfo({ old: e.code === 'not_found' }))
        return () => { alive = false }
      }, [])
      if (!info) return null
      if (!info.version) {
        const cmd = 'npm install -g dsh-model && dsh-model setup'
        return h('div', { style: S.section },
          h('div', { style: S.h }, L('关于', 'About')),
          h('div', { style: { ...S.card, padding: '12px 14px' } },
            h('div', { style: S.meta }, info.old
              ? L('这台机器上的 dsh-model 服务比这个页面旧，不支持在页面上更新。在终端执行一次（服务器上加 sudo），之后就能在这里更新和卸载：', 'The dsh-model service on this machine is older than this page and cannot update from here. Run this once in a terminal (with sudo on a server); after that you can update and uninstall here:')
              : L('暂时查不到版本信息。可以在终端执行（服务器上加 sudo）：', 'Version info is unavailable right now. You can run in a terminal (with sudo on a server):')),
            h('div', { style: { ...S.line, minHeight: 30, marginTop: 6 } }, h('code', { style: { ...S.mono, ...S.grow } }, cmd), h(CopyButton, { get: cmd }))))
      }
      const hasUpdate = info.latest && newer(info.latest, info.version)
      const start = async (action) => {
        if (starting) return
        setErr('')
        setStarting(true)
        try {
          await api('POST', `/self/${action}`, action === 'uninstall' ? { keepAuth } : {})
          onJob({ action, from: info.version, target: info.latest })
        } catch (e) {
          // 连不上守护进程多半是它已经开始重启（任务已经在跑）：照样进进度页，等它回来
          if (e.code === 'daemon_unreachable') onJob({ action, from: info.version, target: info.latest })
          else setErr(e.message)
        } finally {
          setStarting(false)
        }
      }
      return h('div', { style: S.section },
        h('div', { style: S.h }, L('关于', 'About')),
        h('div', { style: { ...S.card, padding: '12px 14px' } },
          h('div', { style: S.line },
            h('span', { style: { ...S.label, ...S.grow } }, `dsh-model ${info.version}`,
              h('span', { style: { ...S.meta, marginLeft: 8 } }, info.latest ? (hasUpdate ? L(`有新版本 ${info.latest}`, `${info.latest} available`) : L('已是最新', 'Up to date')) : L('查不到最新版本', 'Latest version unknown'))),
            info.canManage && hasUpdate ? h('button', { type: 'button', style: S.btnPrimary, disabled: starting, onClick: () => void start('update') }, starting ? L('正在开始…', 'Starting…') : L(`更新到 ${info.latest}`, `Update to ${info.latest}`)) : null,
            info.canManage ? h('button', { type: 'button', style: { ...S.btn, color: C.err }, onClick: () => setConfirming(true) }, L('卸载', 'Uninstall')) : null),
          !info.canManage ? h('div', { style: { marginTop: 8 } },
            h('div', { style: S.meta }, L('服务器上更新和卸载要 root 权限，请在服务器终端里执行：', 'On the server, update and uninstall need root; run in a server terminal:')),
            [[L('更新', 'Update'), info.commands.update], [L('卸载', 'Uninstall'), info.commands.uninstall]].map(([t, c]) => h('div', { key: c, style: { ...S.line, minHeight: 30 } },
              h('span', { style: { ...S.meta, width: 40 } }, t), h('code', { style: { ...S.mono, ...S.grow } }, c), h(CopyButton, { get: c })))) : null,
          confirming ? h('div', { style: { marginTop: 10, padding: 10, border: `1px solid ${C.err}`, borderRadius: 8 } },
            h('div', { style: { fontSize: 13, color: C.text, lineHeight: 1.7 } }, L('卸载会：关闭对外访问 → 移除这个管理页 → 把 dsh 里的模型配置还原 → 停止并删除引擎与守护进程 → 删除 ~/.dsh-model（含各家登录、OpenCode key、WorkBuddy 令牌副本）。', 'Uninstall will: turn off remote access → remove this page → restore dsh\'s model config → stop and delete the engine and daemon → delete ~/.dsh-model (including sign-ins, the OpenCode key and WorkBuddy token copies).')),
            h('label', { style: { ...S.line, fontSize: 13, marginTop: 6, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: keepAuth, onChange: (e) => setKeepAuth(e.target.checked) }),
              L('先把各家登录凭据备份到主目录（以后重装可以拷回来）', 'Back up provider sign-ins to the home folder first (to reuse after reinstalling)')),
            h('div', { style: { ...S.line, marginTop: 8 } },
              h('button', { type: 'button', style: { ...S.btnPrimary, background: C.err }, disabled: starting, onClick: () => void start('uninstall') }, starting ? L('正在开始…', 'Starting…') : L('确认卸载', 'Uninstall')),
              h('button', { type: 'button', style: S.btn, onClick: () => setConfirming(false) }, L('取消', 'Cancel')))) : null,
          err ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, err) : null))
    }

    /** 更新 / 卸载进行中：守护进程会重启或消失，期间不显示别的 */
    function SelfProgress({ job, onDone }) {
      const [state, setState] = useState({ phase: 'running', log: '' })
      useEffect(() => {
        let stop = false
        const tick = async () => {
          if (stop) return
          try {
            const r = await api('GET', '/self')
            if (r.job?.log) setState((s) => ({ ...s, log: r.job.log }))
            if (job.action === 'update' && r.version !== job.from) { setState({ phase: 'done', log: r.job?.log || '' }); return }
          } catch (e) {
            if (job.action === 'uninstall' && e.code === 'daemon_not_configured') { setState((s) => ({ ...s, phase: 'done' })); return }
          }
          setTimeout(tick, 2000)
        }
        const t = setTimeout(tick, 2000)
        return () => { stop = true; clearTimeout(t) }
      }, [])
      const upd = job.action === 'update'
      const title = state.phase === 'done'
        ? (upd ? L('更新完成', 'Update complete') : L('已卸载', 'Uninstalled'))
        : (upd ? L(`正在更新到 ${job.target}…（服务会重启一下）`, `Updating to ${job.target}… (the service restarts briefly)`) : L('正在卸载…', 'Uninstalling…'))
      return h('div', { style: { color: C.text, maxWidth: 820 } },
        h('div', { style: S.section },
          h('div', { style: S.h }, title),
          state.phase === 'done' ? h('p', { style: { ...S.note, color: C.text } }, upd
            ? L('完全退出 dsh 再打开一次，管理页的新代码才会生效。', 'Quit dsh completely and open it again so the management page loads the new code.')
            : L('dsh 里的 dsh-model 模型已移除。完全退出 dsh 再打开，这一页就会消失。日志在主目录的 dsh-model-uninstall.log。', 'dsh-model\'s models are gone from dsh. Quit dsh completely and reopen it and this page disappears. The log is ~/dsh-model-uninstall.log.')) : null,
          state.log ? h('pre', { style: { ...S.mono, ...S.card, padding: 10, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, state.log) : null,
          state.phase === 'done' && upd ? h('button', { type: 'button', style: { ...S.btn, marginTop: 10 }, onClick: onDone }, L('返回', 'Back')) : null))
    }

    /** 调宿主自己的接口（不经守护进程）：/api-dsh-model/host */
    async function hostCall(body, retried) {
      const r = await fetch('/api-dsh-model/host', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-model-token': token },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (r.status === 403 && !retried && j?.error?.code === 'refused') {
        await refreshToken()
        return hostCall(body, true)
      }
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`)
      return j
    }

    /** 插件已更新、但 dsh 还在跑旧代码：顶部提示，VPS 上可一键重启 */
    function RestartBanner({ host }) {
      const [state, setState] = useState('')
      if (!host || !host.installed || !host.running || host.installed === host.running) return null
      const restart = async () => {
        if (!window.confirm(L('重启 dsh？正在进行的对话会中断，大约十几秒后自动恢复。', 'Restart dsh? Ongoing conversations are interrupted; it comes back in about ten seconds.'))) return
        setState('restarting')
        try {
          await hostCall({ action: 'restart' })
        } catch (e) {
          setState(e.message)
          return
        }
        // 等它停下再起来：先连不上，再连得上，就刷新页面
        let wasDown = false
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const up = await fetch('/', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.ok || r.status === 401 || r.status === 302, () => false)
          if (!up) wasDown = true
          else if (wasDown) { window.location.reload(); return }
        }
        window.location.reload()
      }
      return h('div', { style: { ...S.card, padding: '10px 14px', marginBottom: 16, borderColor: C.warn } },
        h('div', { style: S.line },
          h('span', { style: { ...S.grow, fontSize: 13, color: C.text } },
            L(`dsh-model 已更新到 ${host.installed}，但 dsh 还在运行 ${host.running} 的代码，重启 dsh 后生效。`, `dsh-model was updated to ${host.installed}, but dsh is still running ${host.running}; restart dsh to apply it.`),
            host.restart === 'desktop' ? h('span', { style: { color: C.sub } }, L('请完全退出 dsh（Windows 上连同右下角托盘的图标）再打开。', ' Quit dsh completely (on Windows, the tray icon too) and open it again.')) : null,
            host.restart === 'manual' ? h('span', { style: { color: C.sub } }, L('请重启 dsh。', ' Please restart dsh.')) : null),
          host.restart === 'vps' ? h('button', { type: 'button', style: S.btnPrimary, disabled: state === 'restarting', onClick: () => void restart() }, state === 'restarting' ? L('正在重启…', 'Restarting…') : L('重启 dsh', 'Restart dsh')) : null),
        state && state !== 'restarting' ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, state) : null)
    }

    // —— 额度提醒（dsh 任何页面的右下角）——
    /** 额度快用完的来源：积分剩 10% 以下，或某个窗口用了 90% 以上 */
    function lowQuota(list) {
      const out = []
      for (const u of list || []) {
        if (u.error || u.noAccess) continue
        const label = u.label || u.source
        const c = u.credits
        if (c && !c.unlimited && c.total > 0 && c.remaining / c.total <= 0.1) {
          const pct = Math.max(0, Math.round((c.remaining / c.total) * 100))
          out.push({ key: `${u.source}:credits:${pct <= 0 ? 0 : 10}`, text: L(`${label} 积分只剩 ${pct}%（${c.remaining.toLocaleString()} / ${c.total.toLocaleString()}）`, `${label} credits are down to ${pct}% (${c.remaining.toLocaleString()} / ${c.total.toLocaleString()})`) })
        }
        for (const w of u.windows || []) {
          if (w.usedPercent != null && w.usedPercent >= 90) {
            out.push({ key: `${u.source}:${w.id}:${w.usedPercent >= 100 ? 100 : 90}`, text: L(`${label} 的 ${w.label} 额度已用 ${Math.round(w.usedPercent)}%${w.resetAt ? `，${until(w.resetAt)}` : ''}`, `${label} ${w.label} quota is ${Math.round(w.usedPercent)}% used${w.resetAt ? `, ${until(w.resetAt)}` : ''}`) })
          }
        }
      }
      return out
    }
    const DISMISS_KEY = 'dsh-model.quotaDismissed'
    const readDismissed = () => {
      try { return JSON.parse(window.localStorage.getItem(DISMISS_KEY) || '{}') } catch { return {} }
    }
    function QuotaNotice() {
      const [alerts, setAlerts] = useState([])
      const [dismissed, setDismissed] = useState(readDismissed)
      useEffect(() => {
        let stop = false
        const tick = () => api('GET', '/usage').then((u) => { if (!stop) setAlerts(lowQuota(u)) }, () => {})
        void tick()
        const t = setInterval(tick, 5 * 60 * 1000)
        return () => { stop = true; clearInterval(t) }
      }, [])
      const now = Date.now()
      const shown = alerts.filter((a) => !(dismissed[a.key] && now - dismissed[a.key] < 24 * 60 * 60 * 1000))
      if (!shown.length) return null
      const dismiss = () => {
        const next = { ...dismissed }
        for (const a of shown) next[a.key] = Date.now()
        setDismissed(next)
        try { window.localStorage.setItem(DISMISS_KEY, JSON.stringify(next)) } catch { /* 无痕模式：只在本次生效 */ }
      }
      return h('div', { role: 'status', style: { position: 'fixed', right: 16, bottom: 16, zIndex: 900, maxWidth: 360, background: C.base, color: C.text, border: `1px solid ${C.warn}`, borderRadius: 10, padding: '10px 12px', boxShadow: 'var(--dsw-elevation-soft, 0 8px 30px rgba(0,0,0,.2))', fontSize: 13 } },
        h('div', { style: { fontWeight: 600, marginBottom: 4, color: C.warn } }, L('dsh-model：额度快用完了', 'dsh-model: quota running low')),
        shown.map((a) => h('div', { key: a.key, style: { lineHeight: 1.6 } }, a.text)),
        h('div', { style: { ...S.line, marginTop: 6, justifyContent: 'flex-end' } }, h('button', { type: 'button', style: S.btn, onClick: dismiss }, L('知道了', 'Got it'))))
    }

    // —— 每日签到 ——
    const CHECKIN_TEXT = (r) => (r.state === 'signed' ? L(`成功${r.credit ? ` +${r.credit} 积分` : ''}`, `done${r.credit ? ` +${r.credit} credits` : ''}`) : r.state === 'already' ? L('今天已签过', 'already today') : L(`失败：${r.message || ''}`, `failed: ${r.message || ''}`))

    function QoderDialog({ onDone, onClose, another }) {
      const [pat, setPat] = useState('')
      const [name, setName] = useState('')
      const [region, setRegion] = useState('cn')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const save = async () => {
        setBusy(true)
        setMsg(L('正在验证这个令牌并签到…', 'Checking the token and checking in…'))
        try { await api('POST', '/checkin/qoder', { pat: pat.trim(), region, ...(name.trim() ? { name: name.trim() } : {}) }); onDone() } catch (e) { setMsg(e.message); setBusy(false) }
      }
      return h(Modal, { title: another ? L('再加一个 Qoder 账号', 'Add another Qoder account') : L('添加 Qoder 签到', 'Add Qoder check-in'), onClose },
        h('p', { style: S.note },
          L('登录 Qoder 网站，在「设置 → API 令牌」（有的版本叫「账号 → 集成」）里点「创建令牌」，复制生成的个人访问令牌（以 pt- 开头，只显示一次），粘贴到这里。只用来每天领签到积分，保存在本机。', 'Sign in on the Qoder website, open Settings → API Tokens (Account → Integrations in some versions), click Create token, then paste the personal access token here (it starts with pt- and is shown only once). It is only used to claim the daily credits, and stays on this machine.'),
          h('a', { href: region === 'cn' ? 'https://qoder.com.cn/account/integrations' : 'https://qoder.com/account/integrations', target: '_blank', rel: 'noopener noreferrer', style: { color: C.accent, marginLeft: 6 } }, region === 'cn' ? L('去 Qoder 国内版创建 ↗', 'Create on Qoder China ↗') : L('去 Qoder 国际版创建 ↗', 'Create on Qoder ↗'))),
        h('div', { style: { ...S.line, marginBottom: 8 } },
          ['cn', 'intl'].map((r) => h('label', { key: r, style: { ...S.meta, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
            h('input', { type: 'radio', name: 'qoder-region', checked: region === r, onChange: () => setRegion(r) }), r === 'cn' ? L('国内版', 'China') : L('国际版', 'International')))),
        another ? h('div', { style: { ...S.line, marginBottom: 8 } },
          h('input', { style: { ...S.input, ...S.grow }, maxLength: 20, placeholder: L('给这个账号起个名字，如：小号', 'A name for this account, e.g. Second'), value: name, onChange: (e) => setName(e.target.value), 'aria-label': L('账号名字', 'Account name') })) : null,
        h('div', { style: S.line },
          h('input', { type: 'password', style: { ...S.input, ...S.grow }, placeholder: L('个人访问令牌', 'Personal access token'), value: pat, onChange: (e) => setPat(e.target.value) }),
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !pat.trim(), onClick: () => void save() }, L('保存', 'Save'))),
        msg ? h('div', { style: { ...S.meta, marginTop: 8 } }, msg) : null)
    }

    /** 添加豆包签到：从浏览器复制一次登录 Cookie（豆包没有令牌，也不读豆包客户端的文件） */
    function DoubaoDialog({ onDone, onClose, another }) {
      const [cookie, setCookie] = useState('')
      const [name, setName] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const save = async () => {
        setBusy(true)
        setMsg(L('正在用这份 Cookie 查签到任务并签到…', 'Checking this cookie and checking in…'))
        try { await api('POST', '/checkin/doubao', { cookie: cookie.trim(), ...(name.trim() ? { name: name.trim() } : {}) }); onDone() } catch (e) { setMsg(e.message); setBusy(false) }
      }
      const step = (n, text) => h('div', { style: { ...S.meta, lineHeight: 1.7 } }, `${n}. `, text)
      return h(Modal, { title: another ? L('再加一个豆包账号', 'Add another Doubao account') : L('添加豆包签到（实验）', 'Add Doubao check-in (experimental)'), onClose },
        h('p', { style: S.note }, L('豆包「天天领额度」每天送体验额度，只有个人账号能领（飞书企业账号不行）。豆包没有令牌，要从浏览器复制一次登录 Cookie：', 'Doubao gives daily credits to personal accounts (not Feishu enterprise accounts). Doubao has no token, so copy its sign-in cookie from the browser once:')),
        step(1, h('span', null, L('用电脑浏览器打开 ', 'Open '), h('a', { href: 'https://www.doubao.com/', target: '_blank', rel: 'noopener noreferrer', style: { color: C.accent } }, 'doubao.com ↗'), L(' 并登录', ' in a desktop browser and sign in'))),
        step(2, L('按 F12 打开开发者工具，切到「网络 / Network」，刷新一下页面', 'Press F12, open the Network tab, and reload the page')),
        step(3, L('点列表里任意一条 doubao.com 的请求，在「请求标头 / Request Headers」里找到 Cookie 那一行，右键复制它的值', 'Click any doubao.com request, find Cookie under Request Headers, and copy its value')),
        h('div', { style: { fontSize: 12, color: C.warn, margin: '8px 0' } }, L('Cookie 等于你的登录：只粘在这里（保存在本机），不要发给别人。', 'The cookie is your sign-in: paste it only here (it stays on this machine) and never share it.')),
        another ? h('div', { style: { ...S.line, marginBottom: 8 } },
          h('input', { style: { ...S.input, ...S.grow }, maxLength: 20, placeholder: L('给这个账号起个名字，如：小号', 'A name for this account, e.g. Second'), value: name, onChange: (e) => setName(e.target.value), 'aria-label': L('账号名字', 'Account name') })) : null,
        h('div', { style: S.line },
          h('input', { type: 'password', style: { ...S.input, ...S.grow }, placeholder: L('粘贴 Cookie', 'Paste the cookie'), value: cookie, onChange: (e) => setCookie(e.target.value), 'aria-label': 'Cookie' }),
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !cookie.trim(), onClick: () => void save() }, L('保存', 'Save'))),
        msg ? h('div', { style: { ...S.meta, marginTop: 8 } }, msg) : null)
    }

    /** 签到卡片：平时一行"今日已完成签到：…"；没签完的列出来，一键签到；自动签到开关 */
    function CheckinCard() {
      const [st, setSt] = useState(null)
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      const [qoder, setQoder] = useState(false)
      const [wbLogin, setWbLogin] = useState(null)
      const [doubao, setDoubao] = useState(false)
      const [err, setErr] = useState('')
      const refresh = useCallback(() => api('GET', '/checkin').then(setSt, () => {}), [])
      const addWorkbuddy = async () => {
        setErr('')
        try { setWbLogin((await api('POST', '/checkin/workbuddy')).login) } catch (e) { setErr(e.message) }
      }
      const removeAccount = async (kind, id, label) => {
        if (!window.confirm(L(`不再给「${label}」签到？`, `Stop checking in "${label}"?`))) return
        try { setSt(await api('DELETE', `/checkin/${kind}/${encodeURIComponent(id)}`)) } catch (e) { setErr(e.message) }
      }
      useEffect(() => { void refresh(); const t = setInterval(refresh, 5 * 60 * 1000); return () => clearInterval(t) }, [refresh])
      if (!st) return null
      const byId = new Map(st.results.map((r) => [r.id, r]))
      const done = st.available.filter((a) => { const r = byId.get(a.id); return r && r.state !== 'failed' })
      const pending = st.available.filter((a) => !done.includes(a))
      const run = async () => {
        setBusy(true)
        setErr('')
        try { setSt(await api('POST', '/checkin')); setOpen(true) } catch (e) { setErr(e.message) } finally { setBusy(false) }
      }
      const toggleAuto = async (on) => {
        try { setSt(await api('POST', '/checkin/auto', { on })) } catch (e) { setErr(e.message) }
      }
      if (!st.available.length && st.qoder.configured === false) {
        // 没有能签到的：只留一个很小的入口
        return h('div', { style: { ...S.section, marginBottom: 16 } },
          h('div', { style: { ...S.meta } }, L('每日签到：登录 WorkBuddy 国内版，或', 'Daily check-in: sign in to WorkBuddy (China), or '),
            h('button', { type: 'button', style: { ...S.btn, marginLeft: 6 }, onClick: () => setQoder(true) }, L('添加 Qoder', 'Add Qoder')),
            h('button', { type: 'button', style: { ...S.btn, marginLeft: 6 }, onClick: () => setDoubao(true) }, L('添加豆包', 'Add Doubao'))),
          qoder ? h(QoderDialog, { onDone: () => { setQoder(false); void refresh() }, onClose: () => setQoder(false) }) : null,
          doubao ? h(DoubaoDialog, { onDone: () => { setDoubao(false); void refresh() }, onClose: () => setDoubao(false) }) : null)
      }
      return h('div', { style: S.section },
        h('div', { style: { ...S.card, padding: '10px 14px' } },
          h('div', { style: S.line },
            h('span', { style: { ...S.grow, fontSize: 13 } },
              done.length ? h('span', { style: { color: C.ok } }, L(`今日已完成签到：${done.map((a) => a.label).join('、')}`, `Checked in today: ${done.map((a) => a.label).join(', ')}`)) : null,
              done.length && pending.length ? h('span', { style: { color: C.sub } }, L('；', '; ')) : null,
              pending.length ? h('span', { style: { color: C.text } }, L(`还没签：${pending.map((a) => a.label).join('、')}`, `Not yet: ${pending.map((a) => a.label).join(', ')}`)) : null),
            pending.length ? h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => void run() }, busy ? L('签到中…', 'Checking in…') : L('一键签到', 'Check in all')) : null,
            // 详情里还有管理账号的按钮，所以没签过也要能打开
            h('button', { type: 'button', style: S.btn, onClick: () => setOpen(!open) }, open ? L('收起', 'Hide') : L('详情', 'Details')),
            h('label', { style: { ...S.meta, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', whiteSpace: 'nowrap' } },
              h('input', { type: 'checkbox', checked: st.auto, onChange: (e) => void toggleAuto(e.target.checked) }), L('自动签到', 'Auto'))),
          open ? h('div', { style: { marginTop: 8 } },
            st.results.map((r) => h('div', { key: r.id, style: { fontSize: 12, lineHeight: 1.8, color: r.state === 'failed' ? C.err : C.text } },
              `${r.label}：${CHECKIN_TEXT(r)}`, r.advice ? h('span', { style: { color: C.sub, marginLeft: 6 } }, r.advice) : null)),
            // 多账号：多加的 WorkBuddy 签到账号、每个 Qoder 令牌，都能删；再加一个
            h('div', { style: { marginTop: 8, borderTop: `1px solid ${C.border}`, paddingTop: 8 } },
              h('div', { style: { ...S.meta, marginBottom: 4 } }, L('签到账号（同一家可以加几个账号）', 'Check-in accounts (several per product are fine)')),
              [...((st.accounts && st.accounts.workbuddy) || []).map((a) => ({ kind: 'workbuddy', id: a.uid, label: a.label })), ...((st.accounts && st.accounts.qoder) || []).map((q) => ({ kind: 'qoder', id: q.id, label: q.label })), ...((st.accounts && st.accounts.doubao) || []).map((d) => ({ kind: 'doubao', id: d.id, label: d.label }))].map((a) =>
                h('div', { key: `${a.kind}:${a.id}`, style: { ...S.line, minHeight: 24, fontSize: 12 } },
                  h('span', { style: S.grow }, a.label),
                  h('button', { type: 'button', style: { ...S.btn, padding: '2px 8px' }, onClick: () => void removeAccount(a.kind, a.id, a.label) }, L('删除', 'Remove')))),
              h('div', { style: { ...S.line, marginTop: 4, flexWrap: 'wrap' } },
                h('button', { type: 'button', style: S.btn, onClick: () => void addWorkbuddy() }, L('+ 添加 WorkBuddy 账号', '+ Add a WorkBuddy account')),
                h('button', { type: 'button', style: S.btn, onClick: () => setQoder(true) }, st.qoder.configured ? L('+ 再加一个 Qoder 账号', '+ Add another Qoder account') : L('+ 添加 Qoder', '+ Add Qoder')),
                h('button', { type: 'button', style: S.btn, onClick: () => setDoubao(true) }, (st.accounts && st.accounts.doubao && st.accounts.doubao.length) ? L('+ 再加一个豆包账号', '+ Add another Doubao account') : L('+ 添加豆包', '+ Add Doubao')))),
            // Trae 读本机 Trae 的登录：这台没装（比如 VPS）就不会出现，在装了 Trae 的电脑上签就行（每个账号一天一次）
            !st.available.some((a) => a.id === 'trae') ? h('div', { style: { ...S.meta, marginTop: 6 } }, L('Trae：这台电脑上没装 Trae，所以不签。在装了 Trae 的电脑上会自动签（一个账号一天签一次就够）。', 'Trae: not installed on this machine, so it is skipped. A computer with Trae installed checks it in automatically (once a day per account is enough).')) : null) : null,
          !open && !st.qoder.configured ? h('div', { style: { ...S.meta, marginTop: 4 } }, h('button', { type: 'button', style: { ...S.btn, padding: '2px 8px' }, onClick: () => setQoder(true) }, L('+ 添加 Qoder', '+ Add Qoder'))) : null,
          err ? h('div', { style: { fontSize: 12, color: C.err, marginTop: 6 } }, err) : null),
        qoder ? h(QoderDialog, { another: st.qoder.configured, onDone: () => { setQoder(false); void refresh() }, onClose: () => setQoder(false) }) : null,
        doubao ? h(DoubaoDialog, { another: Boolean(st.accounts && st.accounts.doubao && st.accounts.doubao.length), onDone: () => { setDoubao(false); setOpen(true); void refresh() }, onClose: () => setDoubao(false) }) : null,
        wbLogin ? h(LoginDialog, { source: { id: 'workbuddy-checkin', label: L('WorkBuddy 签到账号', 'WorkBuddy check-in account'), login: 'link' }, session: wbLogin, onDone: () => { setWbLogin(null); setOpen(true); setTimeout(() => void refresh(), 3000) }, onClose: () => { setWbLogin(null); void refresh() } }) : null)
    }

    /** 签完在 dsh 右下角提示一次（成功或失败），一天一次 */
    const CHECKIN_SEEN = 'dsh-model.checkinSeen'
    function CheckinNotice() {
      const [st, setSt] = useState(null)
      const [seen, setSeen] = useState(() => { try { return window.localStorage.getItem(CHECKIN_SEEN) || '' } catch { return '' } })
      useEffect(() => {
        let stop = false
        const tick = () => api('GET', '/checkin').then((r) => { if (!stop) setSt(r) }, () => {})
        void tick()
        const t = setInterval(tick, 15 * 60 * 1000)
        return () => { stop = true; clearInterval(t) }
      }, [])
      if (!st || !st.results.length) return null
      const key = `${st.date}:${st.results.map((r) => `${r.id}=${r.state}`).join(',')}`
      if (seen === key) return null
      const failed = st.results.filter((r) => r.state === 'failed')
      const hide = () => { setSeen(key); try { window.localStorage.setItem(CHECKIN_SEEN, key) } catch { /* 无痕模式 */ } }
      return h('div', { role: 'status', style: { position: 'fixed', right: 16, bottom: 120, zIndex: 900, maxWidth: 360, background: C.base, color: C.text, border: `1px solid ${failed.length ? C.err : C.ok}`, borderRadius: 10, padding: '10px 12px', boxShadow: 'var(--dsw-elevation-soft, 0 8px 30px rgba(0,0,0,.2))', fontSize: 13 } },
        h('div', { style: { fontWeight: 600, marginBottom: 4, color: failed.length ? C.err : C.ok } }, failed.length ? L('dsh-model：有签到没成功', 'dsh-model: a check-in failed') : L('dsh-model：今日签到完成', 'dsh-model: checked in for today')),
        st.results.map((r) => h('div', { key: r.id, style: { lineHeight: 1.6 } }, `${r.label}：${CHECKIN_TEXT(r)}`)),
        h('div', { style: { ...S.line, marginTop: 6, justifyContent: 'flex-end' } }, h('button', { type: 'button', style: S.btn, onClick: hide }, L('知道了', 'Got it'))))
    }

    // —— 首次使用向导 ——
    const GUIDE_KEY = 'dsh-model.guideDone'
    const readGuideDone = () => {
      try { return window.localStorage.getItem(GUIDE_KEY) === '1' } catch { return false }
    }
    /** 刚装好、接入的来源少于两个时显示：先接一个免费来源 → 模型已经挑好 → 去 dsh 里用 */
    function Guide({ sources, onConnect }) {
      const [done, setDone] = useState(readGuideDone)
      // WorkBuddy 只签到（它拦 dsh 的对话），不算"已接入"
      const connected = sources.filter((s) => s.loggedIn && s.enabled && s.kind !== 'workbuddy')
      if (done || connected.length >= 1) return null
      // 只推两家：国内直连的硅基流动、能上外网的 Gemini
      const PICKS = [
        { id: 'siliconflow', why: () => L('国内直连，不用代理；实名认证后部分模型免费', 'Reachable from China without a proxy; some models are free after identity verification') },
        { id: 'gemini', why: () => L('能上外网就选它：免费模型里质量最好，每天有次数上限', 'If you can reach Google: the best free models, with a daily limit') },
      ]
      const picks = PICKS.map((p) => ({ ...p, s: sources.find((s) => s.id === p.id) })).filter((p) => p.s)
      const hide = () => {
        setDone(true)
        try { window.localStorage.setItem(GUIDE_KEY, '1') } catch { /* 无痕模式：只在本次生效 */ }
      }
      const step = (n, title, body) => h('div', { style: { display: 'flex', gap: 10, marginTop: n > 1 ? 12 : 0 } },
        h('div', { style: { width: 22, height: 22, borderRadius: 11, background: C.accent, color: C.accentFg, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }, String(n)),
        h('div', { style: S.grow }, h('div', { style: { ...S.label, marginBottom: 2 } }, title), body))
      return h('div', { style: { ...S.section } },
        h('div', { style: { ...S.card, padding: 14, borderColor: C.accent } },
          h('div', { style: { ...S.line, marginBottom: 10 } },
            h('div', { style: { ...S.h, ...S.grow, margin: 0 } }, L('开始使用', 'Getting started')),
            h('button', { type: 'button', style: S.btn, onClick: hide }, L('我知道了，不再显示', 'Got it, hide this'))),
          step(1, L('接入一个免费来源', 'Connect a free source'),
            h('div', null,
              h('div', { style: S.meta }, L('接一个就能用：去对方网站领一把免费 key，点下面的按钮粘贴进来。', 'One is enough: get a free key from their website, then click below and paste it.')),
              picks.map((p) => h('div', { key: p.id, style: { ...S.line, marginTop: 6, flexWrap: 'wrap' } },
                h('button', { type: 'button', style: S.btn, onClick: () => onConnect(p.s) }, p.s.label),
                h('span', { style: { ...S.meta, ...S.grow } }, p.why()),
                p.s.subscribeUrl ? h('a', { href: p.s.subscribeUrl, target: '_blank', rel: 'noopener noreferrer', style: { color: C.accent, fontSize: 12 } }, L('去领 key ↗', 'Get a key ↗')) : null)))),
          step(2, L('模型已经替你挑好', 'Models are picked for you'),
            h('div', { style: S.meta }, L('每个来源默认挑 5 个放进 dsh（免费的优先）。想换就在下面「来源」里点「选模型」。', 'Each source puts 5 suggested models into dsh (free ones first). Change them with "Models" under Sources below.'))),
          step(3, L('去用', 'Use it'),
            h('div', { style: S.meta }, L('在 dsh 的模型列表里，选来源分组下的任意模型就能开始对话。其他软件用下面的「访问地址」和 API key。', 'In dsh\'s model list, pick any model under a source group. Other tools use the endpoint and an API key below.')))))
    }

    // —— 整页 ——
    function SettingsSection() {
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [errCode, setErrCode] = useState('')
      const [selfJob, setSelfJob] = useState(null)
      const [host, setHost] = useState(null)
      useEffect(() => {
        let stop = false
        const check = () => hostCall({}).then((r) => { if (!stop) setHost(r) }, () => {})
        void check()
        const t = setInterval(check, 60_000)
        return () => { stop = true; clearInterval(t) }
      }, [])
      const banner = h(RestartBanner, { host })
      const [login, setLogin] = useState(null)
      const [keyDialog, setKeyDialog] = useState(false)
      const alive = useRef(true)
      const load = useCallback(async (refresh) => {
        try {
          const [sources, keys, stats, endpoints, failures] = await Promise.all([api('GET', refresh ? '/sources?refresh=1' : '/sources'), api('GET', '/keys'), api('GET', '/stats'), api('GET', '/endpoints').catch(() => null), api('GET', '/failures').catch(() => null)])
          if (alive.current) { setData({ sources, keys, stats, endpoints, failures }); setErr(''); setErrCode('') }
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
      // 更新 / 卸载进行中、服务没装或没在运行：整页换成对应的卡片（不能只显示一行错误）
      if (selfJob) return h(SelfProgress, { job: selfJob, onDone: () => { setSelfJob(null); void load(true) } })
      if (errCode === 'daemon_not_configured' || errCode === 'daemon_unreachable') return h('div', null, banner, h(Onboarding, { code: errCode, onDone: () => void load(true) }))
      if (!data) return h('div', { style: { fontSize: 13, color: err ? C.err : C.sub, padding: '8px 0' } }, err || L('加载中…', 'Loading…'))
      // 向导里的「接入」：和来源开关打开时一样（要 key 的弹 key，要登录的弹登录）
      const connect = async (s) => {
        if ((s.kind === 'opencode' || s.kind === 'apikey') && !s.loggedIn) { setKeyDialog(s); return }
        try {
          let r = await api('POST', `/sources/${s.id}/enable`, {})
          if (r.riskNotice) {
            if (!window.confirm(r.riskNotice)) return
            r = await api('POST', `/sources/${s.id}/enable`, { acceptRisk: true })
          }
          if (r.login) setLogin({ source: s, session: r.login })
          await load(false)
        } catch (e) {
          setErr(`${s.label}：${e.message}${e.hint ? `（${e.hint}）` : ''}`)
        }
      }
      return h('div', { style: { color: C.text, maxWidth: 820 } },
        banner,
        h(Guide, { sources: data.sources, onConnect: (s) => void connect(s) }),
        h(CheckinCard, null),
        err ? h('div', { style: { fontSize: 12, color: C.err, marginBottom: 12 } }, err) : null,
        h(EndpointCard, { endpoints: data.endpoints }),
        h(SourcesCard, { sources: data.sources, reload: () => load(false), onLogin: (s, session) => setLogin({ source: s, session }), onKey: (s) => setKeyDialog(s || true) }),
        h(CombosCard, null),
        h(KeysCard, { keys: data.keys, reload: () => load(false) }),
        h(ModelsCard, { stats: data.stats }),
        h(FailuresCard, { failures: data.failures }),
        h(AboutCard, { onJob: setSelfJob }),
        login ? h(LoginDialog, { source: login.source, session: login.session, onDone: () => { setLogin(null); void load(true) }, onClose: () => { setLogin(null); void load(false) } }) : null,
        keyDialog ? h(KeyDialog, { source: keyDialog === true ? null : keyDialog, onDone: () => { setKeyDialog(false); void load(true) }, onClose: () => setKeyDialog(false) }) : null)
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
      // 额度提醒挂在整个窗口的浮层上（不只设置页）；注册失败不影响别的
      try {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-model-quota' }, QuotaNotice))
      } catch (error) {
        console.warn('[dsh-model] 额度提醒注册失败', error)
      }
      try {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-model-checkin' }, CheckinNotice))
      } catch (error) {
        console.warn('[dsh-model] 签到提示注册失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { until, pct, ms, lowQuota } }
    return module.exports
  },
})
