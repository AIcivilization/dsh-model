// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.28；改动：日志前缀、只读开关的环境变量名。
// lib/paths.js — 本机 MiniMax Code 的目录约定（都是只读定位，不猜）
//
// MiniMax Code 把登录凭据放在：
//   <dataDir>/auth/<buildEnv>/<region>/mcode-public/auth.json
//   <dataDir>/auth/<buildEnv>/<region>/mcode-public/auth-state.json
// dataDir 就是 ~/.minimax（老版本是 ~/.mavis，符号链接到同一个地方）。
//
// 凭据文件里的记录 key 是 `<service>\0<account>`，两个值都能算出来，不用猜：
//   service = com.minimax.mcode.oauth.<buildEnv>.<region>
//   account = base64url(sha256(`${authHome}\0mcode-public`))
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const CLIENT_ID = 'mcode-public';
export const OAUTH_SCOPES = ['agent.default'];
export const OAUTH_AUDIENCE = 'agent-backend';
/** MiniMax Code 的数据目录：~/.minimax 优先，老版本 ~/.mavis 兜底 */
export function minimaxDataDir(env = process.env) {
    const fromEnv = (env.MINIMAX_DATA_DIR || '').trim();
    if (fromEnv)
        return fromEnv;
    for (const name of ['.minimax', '.mavis']) {
        const dir = join(env.HOME || homedir(), name);
        if (existsSync(dir))
            return dir;
    }
    return join(env.HOME || homedir(), '.minimax');
}
export function authHome(dataDir = minimaxDataDir()) {
    return join(dataDir, 'auth');
}
/** 凭据记录的 account 字段（sha256 前 32 字节的 base64url） */
export function credentialAccount(auth = authHome()) {
    return createHash('sha256').update(`${auth}\0${CLIENT_ID}`).digest('base64url');
}
/** 凭据记录的 key：service\0account */
export function credentialKey(buildEnv, region, auth = authHome()) {
    return `com.minimax.mcode.oauth.${buildEnv}.${region}\0${credentialAccount(auth)}`;
}
/** 一个命名空间（buildEnv + region）下的所有路径 */
export function namespacePaths({ buildEnv, region }, dataDir = minimaxDataDir()) {
    const auth = authHome(dataDir);
    const home = join(auth, buildEnv, region, CLIENT_ID);
    return {
        authHome: auth,
        home,
        credentialPath: join(home, 'auth.json'),
        statePath: join(home, 'auth-state.json'),
        lockPath: join(home, 'auth.lock'),
    };
}
/**
 * 找出现在装了哪些命名空间（正常情况下只有一个：prod/en 或 prod/cn）。
 * 目录结构是 auth/<buildEnv>/<region>/mcode-public/，读不出来就返回空数组。
 */
export async function listNamespaces(dataDir = minimaxDataDir()) {
    const auth = authHome(dataDir);
    const out = [];
    let envs = [];
    try {
        envs = await readdir(auth);
    }
    catch {
        return out;
    }
    for (const buildEnv of envs) {
        if (!/^[a-z]+$/i.test(buildEnv))
            continue;
        let regions = [];
        try {
            regions = await readdir(join(auth, buildEnv));
        }
        catch {
            continue;
        }
        for (const region of regions) {
            if (region !== 'cn' && region !== 'en')
                continue;
            const paths = namespacePaths({ buildEnv, region }, dataDir);
            if (existsSync(paths.credentialPath) || existsSync(paths.statePath)) {
                out.push({ buildEnv, region, ...paths });
            }
        }
    }
    return out;
}
/** Matrix 网关（签到接口挂在它下面）按 region 分 */
export const MATRIX_ORIGINS = {
    cn: { prod: 'https://agent.minimax.cn', staging: 'https://matrix-pre.xaminim.com', test: 'https://matrix-test.xaminim.com' },
    en: { prod: 'https://agent.minimax.io', staging: 'https://matrix-overseas-pre.xaminim.com', test: 'https://matrix-overseas-test.xaminim.com' },
};
/** OAuth 服务器（登录 / 换 token）按 region 分 */
export const ACCOUNT_ORIGINS = {
    cn: { prod: 'https://account.minimax.cn', staging: 'https://account-pre.xaminim.com', test: 'https://account-test.xaminim.com' },
    en: { prod: 'https://account.minimax.io', staging: 'https://account-overseas-pre.xaminim.com', test: 'https://account-overseas-test.xaminim.com' },
};
export function matrixOrigin(buildEnv, region) {
    return (MATRIX_ORIGINS[region] || MATRIX_ORIGINS.en)[buildEnv] || MATRIX_ORIGINS[region].prod;
}
export function accountOrigin(buildEnv, region) {
    return (ACCOUNT_ORIGINS[region] || ACCOUNT_ORIGINS.en)[buildEnv] || ACCOUNT_ORIGINS[region].prod;
}
/** 插件自己的数据目录：签到历史、设置 */
export function pluginHome(env = process.env) {
    const fromEnv = (env.DSH_CHECKIN_ALL_HOME || '').trim();
    if (fromEnv)
        return fromEnv;
    return join(env.HOME || homedir(), '.dsh', 'dsh-checkin-all');
}
