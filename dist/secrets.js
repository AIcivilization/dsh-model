// secrets.ts — dsh-model 自己保管的上游凭据（目前是 OpenCode Zen key）。secrets.json 0600，不进 dsh 的凭据库：
// 统一端点下 dsh 只认 dsh-model 一个 provider，上游 key 由引擎持有。
import { join } from 'node:path';
import { readJson, writeJson } from './util/fs.js';
export function secretsPath(ctx) {
    return join(ctx.paths.home, 'secrets.json');
}
export async function loadSecrets(ctx) {
    return (await readJson(secretsPath(ctx))) ?? {};
}
export async function saveSecrets(ctx, secrets) {
    await writeJson(secretsPath(ctx), secrets, { owner: ctx.owner });
}
