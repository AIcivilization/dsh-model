// commands/status.ts — status（一屏总览）与 doctor（逐项检查，--e2e 实测每个模型）
import { join } from 'node:path';
import { availableVariants, bridgeConfigPath, loadBridgeConfig, loadCatalogs } from '../bridge/runtime.js';
import { providerPresent } from '../dsh/connect.js';
import { KEY_REF, readRef } from '../dsh/credentials.js';
import { listAuthFiles, summarize } from '../engine/auth.js';
import { healthy, listModels, probeStream, probeToolCall, unauthStatus } from '../engine/client.js';
import { currentBinary, currentVersion } from '../engine/install.js';
import { L } from '../i18n.js';
import { opencodeConfigured } from '../integrations/opencode.js';
import { bridgeHealthy, userPluginInstalled } from '../integrations/workbuddy.js';
import { findActive, DSH_KEY_NAME } from '../keys.js';
import { loadAll } from '../ops.js';
import { serviceFor } from '../service/index.js';
import { UPSTREAMS } from '../upstreams.js';
import { exists, fileMode, readText, sha256 } from '../util/fs.js';
import { dim, green, info, isJsonMode, printJson, red, table, yellow } from '../util/output.js';
import { proxyReachable, redactProxy } from '../util/proxy.js';
/** 模型 id 的分组：opencode/… workbuddy/… 其余算订阅 */
function groupCounts(models) {
    const g = new Map();
    for (const m of models) {
        const k = m.id.includes('/') ? m.id.split('/')[0] : 'subscription';
        g.set(k, (g.get(k) ?? 0) + 1);
    }
    return g;
}
export async function status(ctx) {
    const all = await loadAll(ctx);
    const key = findActive(all.keys, DSH_KEY_NAME)?.key;
    const engineInstalled = await exists(currentBinary(ctx));
    const version = engineInstalled ? await currentVersion(ctx) : null;
    const svc = engineInstalled && !ctx.serviceDisabled ? await serviceFor(ctx).status() : null;
    const up = engineInstalled ? await healthy(all.config.port) : false;
    const models = up && key ? await listModels(all.config.port, key).catch(() => []) : [];
    const groups = groupCounts(models);
    const { byUpstream } = summarize(await listAuthFiles(ctx));
    const dshOk = await providerPresent(all.state, all.config.dsh.providerId).catch(() => false);
    const oc = await opencodeConfigured(ctx);
    const bridgeCfg = await loadBridgeConfig(ctx.paths.home);
    const bridgeUp = bridgeCfg ? await bridgeHealthy(bridgeCfg.port, bridgeCfg.secret) : false;
    const cats = await loadCatalogs(ctx.paths.home);
    const apps = await availableVariants(ctx.paths.home);
    const logged = UPSTREAMS.filter((u) => byUpstream[u.id]?.length).map((u) => u.id);
    const data = {
        mode: ctx.mode,
        home: ctx.paths.home,
        endpoint: { version, running: up, port: all.config.port, service: svc, models: Object.fromEntries(groups) },
        opencode: { configured: oc, models: groups.get('opencode') ?? 0 },
        workbuddy: { apps: apps.map((v) => v.displayName), bridge: bridgeCfg ? { port: bridgeCfg.port, running: bridgeUp } : null, catalogs: cats.map((c) => ({ label: c.label, signedIn: c.signedIn, models: c.models.length, error: c.error })) },
        subscriptions: logged,
        dsh: all.state.dsh ? { profile: all.state.dsh.profile, providerPresent: dshOk } : null,
        remote: all.config.remote.mode,
        proxy: all.config.proxy ? redactProxy(all.config.proxy) : null,
        keys: all.keys.keys.filter((k) => !k.revokedAt).map((k) => k.name),
    };
    if (isJsonMode()) {
        printJson(data);
        return 0;
    }
    const yes = (b, t, f) => (b ? green(t) : red(f));
    const wbLine = !apps.length
        ? dim(L('未登录（dsh-model workbuddy login）', 'not signed in (dsh-model workbuddy login)'))
        : !bridgeCfg
            ? yellow(L('未启用（dsh-model workbuddy enable）', 'not enabled (dsh-model workbuddy enable)'))
            : !bridgeUp
                ? red(L(`bridge 没在运行（127.0.0.1:${bridgeCfg.port}，dsh-model repair）`, `bridge not running (127.0.0.1:${bridgeCfg.port}, dsh-model repair)`))
                : cats.map((c) => (c.signedIn ? green(`${c.label} ${c.models.length}`) : yellow(L(`${c.label} 未登录`, `${c.label} signed out`)))).join(' · ') || yellow(L('目录还没读到', 'catalog not read yet'));
    info(table([
        [L('统一端点', 'Endpoint'), engineInstalled ? yes(up, `127.0.0.1:${all.config.port}`, L('未运行（dsh-model repair）', 'not running (dsh-model repair)')) + dim(`  v${version ?? '-'}${svc ? ` · ${svc.detail ?? '-'}` : ''}`) : red(L('未安装（dsh-model setup）', 'not installed (dsh-model setup)'))],
        [L('模型', 'Models'), models.length ? [...groups].map(([g, n]) => `${g === 'subscription' ? L('订阅', 'subscription') : g} ${n}`).join(' · ') : yellow('0')],
        ['OpenCode Zen', oc ? green(L(`已配置 · ${groups.get('opencode') ?? 0} 个模型`, `configured · ${groups.get('opencode') ?? 0} models`)) : yellow(L('未配置（dsh-model opencode key）', 'not configured (dsh-model opencode key)'))],
        ['WorkBuddy', wbLine],
        [L('订阅', 'Subscriptions'), logged.length ? logged.join(', ') : dim(L('无（dsh-model login <上游>）', 'none (dsh-model login <upstream>)'))],
        ['dsh', data.dsh ? yes(dshOk, `${data.dsh.profile} ✓`, L(`${data.dsh.profile}：provider 不在了（dsh-model repair）`, `${data.dsh.profile}: provider missing (dsh-model repair)`)) : yellow(L('未接入', 'not connected'))],
        [L('远程访问', 'Remote'), all.config.remote.mode],
        [L('出站代理', 'Proxy'), data.proxy ?? L('不使用', 'none')],
        ['Keys', data.keys.join(', ') || '-'],
    ]));
    return 0;
}
export async function doctor(ctx, opts) {
    const all = await loadAll(ctx);
    const checks = [];
    const add = (id, level, message) => checks.push({ id, level, message });
    const key = findActive(all.keys, DSH_KEY_NAME)?.key;
    const homeMode = await fileMode(ctx.paths.home);
    if (homeMode == null)
        add('home', 'fail', L(`${ctx.paths.home} 不存在（先 setup）`, `${ctx.paths.home} missing (run setup)`));
    else
        add('home', homeMode & 0o077 ? 'warn' : 'ok', L(`home 权限 ${homeMode.toString(8)}`, `home mode ${homeMode.toString(8)}`));
    for (const [id, file] of [['keys', ctx.paths.keys], ['engine-yaml', ctx.paths.engineYaml], ['secrets', join(ctx.paths.home, 'secrets.json')], ['bridge-config', bridgeConfigPath(ctx.paths.home)]]) {
        const m = await fileMode(file);
        if (m != null)
            add(id, m & 0o077 ? 'warn' : 'ok', `${file.split('/').pop()} ${m.toString(8)}`);
    }
    const authFiles = await listAuthFiles(ctx);
    const loose = [];
    for (const f of authFiles)
        if (((await fileMode(join(ctx.paths.auth, f))) ?? 0) & 0o077)
            loose.push(f);
    if (authFiles.length)
        add('auth-perms', loose.length ? 'warn' : 'ok', loose.length ? L(`凭据文件权限过宽：${loose.join(', ')}`, `Credential files too permissive: ${loose.join(', ')}`) : L(`订阅凭据 ${authFiles.length} 个，权限正常`, `${authFiles.length} subscription credentials, permissions OK`));
    const { byUpstream, other } = summarize(authFiles);
    const multi = Object.entries(byUpstream).filter(([, f]) => f.length > 1);
    if (multi.length)
        add('single-account', 'warn', L(`同一上游有多个账号：${multi.map(([u]) => u).join(', ')}`, `Multiple accounts for: ${multi.map(([u]) => u).join(', ')}`));
    if (other.length)
        add('unknown-auth', 'warn', L(`不认识的凭据文件：${other.join(', ')}`, `Unrecognized credential files: ${other.join(', ')}`));
    // —— 统一端点 ——
    const engineInstalled = await exists(currentBinary(ctx));
    const version = engineInstalled ? await currentVersion(ctx) : null;
    add('engine', engineInstalled ? (version === all.config.engine.version ? 'ok' : 'warn') : 'fail', engineInstalled ? `v${version}` : L('未安装（dsh-model setup）', 'not installed (dsh-model setup)'));
    if (engineInstalled && !ctx.serviceDisabled) {
        const s = await serviceFor(ctx).status();
        add('engine-service', s.running ? 'ok' : 'fail', `${serviceFor(ctx).kind}: ${s.detail ?? '-'}`);
    }
    if (all.config.proxy) {
        const reach = await proxyReachable(all.config.proxy);
        add('proxy', reach ? 'ok' : 'fail', reach ? L(`代理 ${redactProxy(all.config.proxy)} 可连接`, `Proxy ${redactProxy(all.config.proxy)} reachable`) : L(`代理 ${redactProxy(all.config.proxy)} 连不上（代理软件没开？dsh-model setup --proxy <地址>|none）`, `Proxy ${redactProxy(all.config.proxy)} unreachable (proxy app not running? dsh-model setup --proxy <url>|none)`));
    }
    const up = engineInstalled ? await healthy(all.config.port) : false;
    if (engineInstalled)
        add('healthz', up ? 'ok' : 'fail', `127.0.0.1:${all.config.port}`);
    if (up) {
        const code = await unauthStatus(all.config.port);
        add('auth-enforced', code === 401 ? 'ok' : 'fail', L(`不带 key 请求返回 ${code}`, `unauthenticated request → ${code}`));
    }
    let models = [];
    if (up && key) {
        try {
            models = await listModels(all.config.port, key);
            const g = groupCounts(models);
            add('models', models.length ? 'ok' : 'warn', models.length ? [...g].map(([k, n]) => `${k} ${n}`).join(' · ') : L('0 个模型', '0 models'));
        }
        catch (error) {
            add('models', 'fail', String(error.message));
        }
    }
    // —— OpenCode / WorkBuddy ——
    const oc = await opencodeConfigured(ctx);
    const ocModels = models.filter((m) => m.id.startsWith('opencode/')).length;
    add('opencode', !oc ? 'warn' : up && !ocModels ? 'fail' : 'ok', !oc ? L('OpenCode Zen 未配置（dsh-model opencode key）', 'OpenCode Zen not configured (dsh-model opencode key)') : up && !ocModels ? L('已配置但引擎里没有 opencode/ 模型（dsh-model repair）', 'configured but no opencode/ models in the engine (dsh-model repair)') : L(`OpenCode Zen：${ocModels} 个模型`, `OpenCode Zen: ${ocModels} models`));
    const apps = await availableVariants(ctx.paths.home);
    const bridgeCfg = await loadBridgeConfig(ctx.paths.home);
    if (apps.length) {
        if (!bridgeCfg)
            add('workbuddy', 'warn', L('检测到 WorkBuddy App，但没启用（dsh-model workbuddy enable）', 'WorkBuddy app found but not enabled (dsh-model workbuddy enable)'));
        else {
            const bUp = await bridgeHealthy(bridgeCfg.port, bridgeCfg.secret);
            add('bridge', bUp ? 'ok' : 'fail', bUp ? L(`bridge 127.0.0.1:${bridgeCfg.port} 运行中`, `bridge 127.0.0.1:${bridgeCfg.port} running`) : L(`bridge 没在运行（dsh-model logs --bridge；dsh-model repair）`, 'bridge not running (dsh-model logs --bridge; dsh-model repair)'));
            for (const c of await loadCatalogs(ctx.paths.home)) {
                const inEngine = models.filter((m) => m.id.startsWith(`${c.prefix}/`)).length;
                if (!c.signedIn)
                    add(`workbuddy-${c.key}`, 'warn', L(`${c.label}：未登录${c.error ? `（${c.error}）` : ''}——在 App 里登录后执行 dsh-model workbuddy refresh`, `${c.label}: signed out${c.error ? ` (${c.error})` : ''} — sign in to the app, then dsh-model workbuddy refresh`));
                else
                    add(`workbuddy-${c.key}`, up && !inEngine ? 'fail' : 'ok', L(`${c.label}：已登录，${c.models.length} 个模型${up ? `（引擎里 ${inEngine} 个）` : ''}${c.error ? `；${c.error}` : ''}`, `${c.label}: signed in, ${c.models.length} models${up ? ` (${inEngine} in engine)` : ''}${c.error ? `; ${c.error}` : ''}`));
            }
        }
        if (await userPluginInstalled(ctx, all))
            add('workbuddy-plugin', 'warn', L('同时装了 dsh-workbuddy-connect 插件：dsh 里会有两组 WorkBuddy 模型', 'dsh-workbuddy-connect is also installed: dsh shows two WorkBuddy groups'));
    }
    // —— dsh 接线 ——
    if (all.state.dsh) {
        const d = all.state.dsh;
        const present = await providerPresent(all.state, all.config.dsh.providerId).catch(() => false);
        add('dsh-provider', present || !models.length ? 'ok' : 'fail', present ? L(`dsh（${d.profile}）里有 dsh-model`, `dsh-model present in dsh (${d.profile})`) : L('dsh 里没有 dsh-model（dsh-model repair）', 'dsh-model missing in dsh (dsh-model repair)'));
        const credText = await readText(d.credFile);
        add('dsh-key', readRef(credText) === key ? 'ok' : 'fail', readRef(credText) === key ? L(`${KEY_REF} 与 key 一致`, `${KEY_REF} matches`) : L(`${KEY_REF} 与 key 不一致（dsh-model repair）`, `${KEY_REF} does not match (dsh-model repair)`));
        const cm = await fileMode(d.credFile);
        if (cm != null)
            add('dsh-cred-perms', cm === 0o600 ? 'ok' : 'fail', L(`.credentials.yaml 权限 ${cm.toString(8)}（dsh 要求 600）`, `.credentials.yaml mode ${cm.toString(8)} (dsh requires 600)`));
        const patchText = await readText(d.patchFile);
        if (patchText != null && d.writtenPatchSha && sha256(patchText) !== d.writtenPatchSha) {
            add('dsh-patch-edited', 'ok', L('cordis.patch.yml 在接线后被修改过（卸载时只会移除 dsh-model 的部分）', 'cordis.patch.yml edited since connect (uninstall will remove only dsh-model parts)'));
        }
    }
    else {
        add('dsh-provider', 'warn', L('还没接入 dsh（dsh-model setup）', 'Not connected to dsh (dsh-model setup)'));
    }
    if (ctx.env[KEY_REF])
        add('env-override', 'warn', L(`环境变量 ${KEY_REF} 会覆盖 dsh 凭据里的值`, `Env var ${KEY_REF} overrides the value in dsh credentials`));
    if ((await exists('/etc/caddy/dsh-model.conf')) && all.config.remote.mode !== 'caddy')
        add('caddy-orphan', 'warn', L('发现残留的 /etc/caddy/dsh-model.conf', 'Found leftover /etc/caddy/dsh-model.conf'));
    // —— e2e：默认每组（订阅按 owned_by，opencode/workbuddy 按前缀）取一个模型 ——
    const e2e = [];
    if (opts.e2e && key && models.length) {
        const groupOf = (m) => (m.id.includes('/') ? m.id.split('/')[0] : (m.owned_by ?? m.id));
        const pick = opts.model ? models.filter((m) => m.id === opts.model) : opts.all ? models : [...new Map(models.map((m) => [groupOf(m), m])).values()];
        for (const m of pick) {
            const s = await probeStream(all.config.port, key, m.id);
            const t = await probeToolCall(all.config.port, key, m.id);
            e2e.push({ model: m.id, stream: s.detail, tool: t.detail, ok: s.ok && t.ok });
        }
    }
    const failed = checks.some((c) => c.level === 'fail') || e2e.some((r) => !r.ok);
    if (isJsonMode()) {
        printJson({ ok: !failed, checks, e2e });
        return failed ? 1 : 0;
    }
    const mark = (l) => (l === 'ok' ? green('✓') : l === 'warn' ? yellow('!') : red('✗'));
    info(table(checks.map((c) => [mark(c.level), c.id, c.message])));
    if (e2e.length) {
        info('');
        info(table([[L('模型', 'Model'), L('流式', 'Stream'), L('工具调用', 'Tool call')], ...e2e.map((r) => [`${r.ok ? green('✓') : red('✗')} ${r.model}`, r.stream, r.tool])]));
    }
    else if (opts.e2e) {
        info(yellow(L('没有可测的模型', 'No models to test')));
    }
    return failed ? 1 : 0;
}
