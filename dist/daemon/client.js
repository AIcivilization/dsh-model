// daemon/client.ts — 调守护进程 /control/*（CLI 用；dsh 插件宿主端也照这个格式调）
import { loadBridgeConfig } from '../bridge/runtime.js';
import { DshModelError } from '../errors.js';
import { L, lang } from '../i18n.js';
export async function control(ctx, method, path, body, timeoutMs = 60_000) {
    const cfg = await loadBridgeConfig(ctx.paths.home);
    if (!cfg)
        throw new DshModelError('daemon_not_configured', L('守护进程未配置（dsh-model setup）', 'Daemon not configured (dsh-model setup)'));
    let res;
    try {
        res = await fetch(`http://127.0.0.1:${cfg.port}/control${path}`, {
            method,
            headers: { Authorization: `Bearer ${cfg.secret}`, 'x-dsh-model-lang': lang(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch {
        throw new DshModelError('daemon_unreachable', L(`守护进程没在 127.0.0.1:${cfg.port} 上运行`, `Daemon is not running on 127.0.0.1:${cfg.port}`), L('执行 dsh-model repair', 'Run dsh-model repair'));
    }
    const data = (await res.json().catch(() => ({})));
    if (!res.ok || data.error) {
        const e = data.error ?? { code: 'daemon_error', message: `HTTP ${res.status}` };
        throw new DshModelError(e.code, e.message, e.hint);
    }
    return data;
}
