// engine/mgmt.ts — 引擎管理接口（v8）的客户端
//
// 管理接口只监听本机，用随机强密钥（mgmt.json，0600），只有 dsh-model 自己（CLI 与守护进程）使用；
// 浏览器永远拿不到它。用途：来源登录（OAuth）、停用 / 启用 / 删除凭据、读取用量记录。
// 接口格式对照 v8.0.13 实测（2026-10-09）：
//   GET  /oauth/auth-url?provider=  → {status,url,state,flow?:"device",user_code?,expires_in?}
//   GET  /oauth/status?state=       → {status:"wait"|"ok"|"error", error?}
//   POST /oauth/callback            ← {provider, redirect_url}（回调式登录：用户把跳转地址贴回来）
//   DELETE /oauth/session?state=
//   GET  /credentials               → {files:[...]}
//   PATCH /credentials/status       ← {name, disabled}
//   DELETE /credentials?name=
//   GET  /observability/usage/queue?count=  → 用量记录数组（取走即删）
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { readJson, writeJson } from '../util/fs.js';
export function mgmtPath(ctx) {
    return join(ctx.paths.home, 'mgmt.json');
}
export async function loadMgmt(ctx) {
    return readJson(mgmtPath(ctx));
}
/** 没有就生成；引擎配置据此打开管理接口 */
export async function ensureMgmt(ctx) {
    const existing = await loadMgmt(ctx);
    if (existing?.secret)
        return existing;
    const cfg = { secret: `dshg_${randomBytes(32).toString('base64url')}` };
    await writeJson(mgmtPath(ctx), cfg, { owner: ctx.owner });
    return cfg;
}
export class Mgmt {
    port;
    secret;
    constructor(port, secret) {
        this.port = port;
        this.secret = secret;
    }
    static async forCtx(ctx, port) {
        const cfg = await loadMgmt(ctx);
        if (!cfg)
            throw new DshModelError('mgmt_not_configured', L('引擎管理接口还没配置（dsh-model setup）', 'Engine management API not configured (dsh-model setup)'));
        return new Mgmt(port, cfg.secret);
    }
    async call(method, path, body, timeoutMs = 15_000) {
        const res = await fetch(`http://127.0.0.1:${this.port}/v8/management${path}`, {
            method,
            headers: { Authorization: `Bearer ${this.secret}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let data = undefined;
        try {
            data = text ? JSON.parse(text) : undefined;
        }
        catch {
            // 非 JSON
        }
        if (!res.ok) {
            const msg = data?.error ?? text.slice(0, 200);
            throw new DshModelError('mgmt_error', L(`引擎管理接口 ${method} ${path} 失败（HTTP ${res.status}）：${msg}`, `Engine management ${method} ${path} failed (HTTP ${res.status}): ${msg}`));
        }
        return data;
    }
    authUrl(provider) {
        return this.call('GET', `/oauth/auth-url?provider=${encodeURIComponent(provider)}`);
    }
    oauthStatus(state) {
        // 未知 state 也返回 200 + {status:"error"}，不当异常
        return this.call('GET', `/oauth/status?state=${encodeURIComponent(state)}`);
    }
    oauthCallback(provider, redirectUrl) {
        return this.call('POST', '/oauth/callback', { provider, redirect_url: redirectUrl });
    }
    cancel(state) {
        return this.call('DELETE', `/oauth/session?state=${encodeURIComponent(state)}`);
    }
    async credentials() {
        const r = await this.call('GET', '/credentials');
        return r.files ?? [];
    }
    setDisabled(name, disabled) {
        return this.call('PATCH', '/credentials/status', { name, disabled });
    }
    deleteCredential(name) {
        return this.call('DELETE', `/credentials?name=${encodeURIComponent(name)}`);
    }
    async usageQueue(count = 1000) {
        const r = await this.call('GET', `/observability/usage/queue?count=${count}`);
        return Array.isArray(r) ? r : [];
    }
}
