// commands/status.ts — status（一屏总览）与 doctor（逐项检查，--e2e 实测每个模型）

import { join } from 'node:path'
import type { Ctx } from '../context.js'
import { providerPresent } from '../dsh/connect.js'
import { KEY_REF, readRef } from '../dsh/credentials.js'
import { listAuthFiles, summarize } from '../engine/auth.js'
import { healthy, listModels, probeStream, probeToolCall, unauthStatus, type ModelEntry } from '../engine/client.js'
import { currentVersion } from '../engine/install.js'
import { L } from '../i18n.js'
import { findActive, DSH_KEY_NAME } from '../keys.js'
import { loadAll } from '../ops.js'
import { serviceFor } from '../service/index.js'
import { UPSTREAMS } from '../upstreams.js'
import { exists, fileMode, readText, sha256 } from '../util/fs.js'
import { dim, green, info, isJsonMode, printJson, red, table, yellow } from '../util/output.js'
import { proxyReachable, redactProxy } from '../util/proxy.js'

export async function status(ctx: Ctx): Promise<number> {
  const all = await loadAll(ctx)
  const key = findActive(all.keys, DSH_KEY_NAME)?.key
  const version = await currentVersion(ctx)
  const svc = ctx.serviceDisabled ? null : await serviceFor(ctx).status()
  const up = await healthy(all.config.port)
  const models = up && key ? await listModels(all.config.port, key).catch(() => [] as ModelEntry[]) : []
  const { byUpstream } = summarize(await listAuthFiles(ctx))
  const dshOk = await providerPresent(all.state, all.config.dsh.providerId).catch(() => false)

  const data = {
    mode: ctx.mode,
    home: ctx.paths.home,
    engine: { version, running: up, port: all.config.port, service: svc },
    upstreams: Object.fromEntries(UPSTREAMS.map((u) => [u.id, (byUpstream[u.id] ?? []).length])),
    models: models.length,
    dsh: all.state.dsh ? { profile: all.state.dsh.profile, patchFile: all.state.dsh.patchFile, providerPresent: dshOk } : null,
    remote: all.config.remote.mode,
    proxy: all.config.proxy ? redactProxy(all.config.proxy) : null,
    keys: all.keys.keys.filter((k) => !k.revokedAt).map((k) => k.name),
  }
  if (isJsonMode()) {
    printJson(data)
    return 0
  }
  const yes = (b: boolean, t: string, f: string) => (b ? green(t) : red(f))
  const logged = UPSTREAMS.filter((u) => byUpstream[u.id]?.length).map((u) => u.id)
  info(
    table([
      [L('模式', 'Mode'), ctx.mode],
      [L('引擎', 'Engine'), version ? `v${version}` : red(L('未安装', 'not installed'))],
      [L('运行', 'Running'), yes(up, `127.0.0.1:${all.config.port}`, L('未运行', 'not running')) + (svc ? dim(`  (${svc.detail ?? '-'})`) : '')],
      [L('已登录', 'Logged in'), logged.length ? logged.join(', ') : yellow(L('无（dsh-model login codex）', 'none (dsh-model login codex)'))],
      [L('模型数', 'Models'), String(models.length)],
      ['dsh', data.dsh ? yes(dshOk, `${data.dsh.profile} ✓`, L(`${data.dsh.profile}：provider 不在了（dsh-model repair）`, `${data.dsh.profile}: provider missing (dsh-model repair)`)) : yellow(L('未接入', 'not connected'))],
      [L('远程访问', 'Remote'), all.config.remote.mode],
      [L('出站代理', 'Proxy'), data.proxy ?? L('不使用', 'none')],
      ['Keys', data.keys.join(', ') || '-'],
    ]),
  )
  return 0
}

type Level = 'ok' | 'warn' | 'fail'
interface Check {
  id: string
  level: Level
  message: string
}

export async function doctor(ctx: Ctx, opts: { e2e?: boolean; all?: boolean; model?: string }): Promise<number> {
  const all = await loadAll(ctx)
  const checks: Check[] = []
  const add = (id: string, level: Level, message: string) => checks.push({ id, level, message })
  const key = findActive(all.keys, DSH_KEY_NAME)?.key

  const homeMode = await fileMode(ctx.paths.home)
  if (homeMode == null) add('home', 'fail', L(`${ctx.paths.home} 不存在（先 setup）`, `${ctx.paths.home} missing (run setup)`))
  else add('home', homeMode & 0o077 ? 'warn' : 'ok', L(`home 权限 ${homeMode.toString(8)}`, `home mode ${homeMode.toString(8)}`))

  for (const [id, file] of [['keys', ctx.paths.keys], ['engine-yaml', ctx.paths.engineYaml]] as const) {
    const m = await fileMode(file)
    if (m != null) add(id, m & 0o077 ? 'warn' : 'ok', `${file.split('/').pop()} ${m.toString(8)}`)
  }
  const authFiles = await listAuthFiles(ctx)
  const loose = []
  for (const f of authFiles) if (((await fileMode(join(ctx.paths.auth, f))) ?? 0) & 0o077) loose.push(f)
  add('auth-perms', loose.length ? 'warn' : 'ok', loose.length ? L(`凭据文件权限过宽：${loose.join(', ')}`, `Credential files too permissive: ${loose.join(', ')}`) : L(`凭据文件 ${authFiles.length} 个，权限正常`, `${authFiles.length} credential files, permissions OK`))

  const { byUpstream, other } = summarize(authFiles)
  const multi = Object.entries(byUpstream).filter(([, f]) => f.length > 1)
  add('single-account', multi.length ? 'warn' : 'ok', multi.length ? L(`同一上游有多个账号：${multi.map(([u]) => u).join(', ')}`, `Multiple accounts for: ${multi.map(([u]) => u).join(', ')}`) : L('每个上游最多一个账号', 'At most one account per upstream'))
  if (other.length) add('unknown-auth', 'warn', L(`不认识的凭据文件：${other.join(', ')}`, `Unrecognized credential files: ${other.join(', ')}`))

  const version = await currentVersion(ctx)
  add('engine', version ? (version === all.config.engine.version ? 'ok' : 'warn') : 'fail', version ? `v${version}` : L('未安装', 'not installed'))

  if (!ctx.serviceDisabled) {
    const s = await serviceFor(ctx).status()
    add('service', s.running ? 'ok' : 'fail', `${serviceFor(ctx).kind}: ${s.detail ?? '-'}`)
  }
  if (all.config.proxy) {
    const reach = await proxyReachable(all.config.proxy)
    add('proxy', reach ? 'ok' : 'fail', reach ? L(`代理 ${redactProxy(all.config.proxy)} 可连接`, `Proxy ${redactProxy(all.config.proxy)} reachable`) : L(`代理 ${redactProxy(all.config.proxy)} 连不上（代理软件没开？dsh-model setup --proxy <地址>|none）`, `Proxy ${redactProxy(all.config.proxy)} unreachable (proxy app not running? dsh-model setup --proxy <url>|none)`))
  }
  const up = await healthy(all.config.port)
  add('healthz', up ? 'ok' : 'fail', `127.0.0.1:${all.config.port}`)
  if (up) {
    const code = await unauthStatus(all.config.port)
    add('auth-enforced', code === 401 ? 'ok' : 'fail', L(`不带 key 请求返回 ${code}`, `unauthenticated request → ${code}`))
  }
  let models: ModelEntry[] = []
  if (up && key) {
    try {
      models = await listModels(all.config.port, key)
      add('models', models.length ? 'ok' : 'warn', L(`${models.length} 个模型`, `${models.length} models`))
    } catch (error) {
      add('models', 'fail', String((error as Error).message))
    }
  }

  if (all.state.dsh) {
    const d = all.state.dsh
    const present = await providerPresent(all.state, all.config.dsh.providerId).catch(() => false)
    add('dsh-provider', present || !models.length ? 'ok' : 'fail', present ? L(`dsh（${d.profile}）里有 dsh-model`, `dsh-model present in dsh (${d.profile})`) : L('dsh 里没有 dsh-model（dsh-model repair）', 'dsh-model missing in dsh (dsh-model repair)'))
    const credText = await readText(d.credFile)
    add('dsh-key', readRef(credText) === key ? 'ok' : 'fail', readRef(credText) === key ? L(`${KEY_REF} 与 key 一致`, `${KEY_REF} matches`) : L(`${KEY_REF} 与 key 不一致（dsh-model repair）`, `${KEY_REF} does not match (dsh-model repair)`))
    const cm = await fileMode(d.credFile)
    if (cm != null) add('dsh-cred-perms', cm === 0o600 ? 'ok' : 'fail', L(`.credentials.yaml 权限 ${cm.toString(8)}（dsh 要求 600）`, `.credentials.yaml mode ${cm.toString(8)} (dsh requires 600)`))
    const patchText = await readText(d.patchFile)
    if (patchText != null && d.writtenPatchSha && sha256(patchText) !== d.writtenPatchSha) {
      add('dsh-patch-edited', 'ok', L('cordis.patch.yml 在接线后被修改过（卸载时只会移除 dsh-model 的部分）', 'cordis.patch.yml edited since connect (uninstall will remove only dsh-model parts)'))
    }
  } else {
    add('dsh-provider', 'warn', L('还没接入 dsh（dsh-model connect-dsh）', 'Not connected to dsh (dsh-model connect-dsh)'))
  }
  if (ctx.env[KEY_REF]) add('env-override', 'warn', L(`环境变量 ${KEY_REF} 会覆盖 dsh 凭据里的值`, `Env var ${KEY_REF} overrides the value in dsh credentials`))
  if (await exists('/etc/caddy/dsh-model.conf') && all.config.remote.mode !== 'caddy') add('caddy-orphan', 'warn', L('发现残留的 /etc/caddy/dsh-model.conf', 'Found leftover /etc/caddy/dsh-model.conf'))

  // e2e：默认每个 owned_by 取一个模型
  const e2e: { model: string; stream: string; tool: string; ok: boolean }[] = []
  if (opts.e2e && key && models.length) {
    const pick = opts.model
      ? models.filter((m) => m.id === opts.model)
      : opts.all
        ? models
        : [...new Map(models.map((m) => [m.owned_by ?? m.id, m])).values()]
    for (const m of pick) {
      const s = await probeStream(all.config.port, key, m.id)
      const t = await probeToolCall(all.config.port, key, m.id)
      e2e.push({ model: m.id, stream: s.detail, tool: t.detail, ok: s.ok && t.ok })
    }
  }

  const failed = checks.some((c) => c.level === 'fail') || e2e.some((r) => !r.ok)
  if (isJsonMode()) {
    printJson({ ok: !failed, checks, e2e })
    return failed ? 1 : 0
  }
  const mark = (l: Level) => (l === 'ok' ? green('✓') : l === 'warn' ? yellow('!') : red('✗'))
  info(table(checks.map((c) => [mark(c.level), c.id, c.message])))
  if (e2e.length) {
    info('')
    info(table([[L('模型', 'Model'), L('流式', 'Stream'), L('工具调用', 'Tool call')], ...e2e.map((r) => [`${r.ok ? green('✓') : red('✗')} ${r.model}`, r.stream, r.tool])]))
  } else if (opts.e2e) {
    info(yellow(L('没有可测的模型（先 login）', 'No models to test (log in first)')))
  }
  return failed ? 1 : 0
}
