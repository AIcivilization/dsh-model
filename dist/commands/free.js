// commands/free.ts — dsh-model free：免费额度（设计 §14.25–14.27）
//
//   free                       总览：已接入的、还能领的、免费池里的模型、新发现
//   free discover              现在探测一次新额度
//   free optin <来源> <上限>   会扣钱的额度放进免费池（token 上限，用到 90% 自动移出）
//   free optout <来源>
//   free add <名字> <地址> <key> [--free daily|monthly|once|forever]   手动添加来源
import { control } from '../daemon/client.js';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
import { bold, dim, info, isJsonMode, ok, printJson } from '../util/output.js';
const CYCLE = {
    daily: () => L('每天', 'daily'),
    monthly: () => L('每月', 'monthly'),
    once: () => L('一次性', 'one-off'),
    limited: () => L('限时', 'limited'),
    forever: () => L('长期', 'ongoing'),
    local: () => L('本机', 'local'),
};
function show(o) {
    const s = o.summary;
    info(bold(L(`免费额度：已接入 ${s.connected} 份，免费池 ${s.poolModels.auto} 个模型；还有 ${s.missing} 份可领${s.missingCny ? `（一次性和每月的约 ¥${s.missingCny}）` : ''}；签到 ${s.checkinConnected}/${s.checkinConnected + s.checkinMissing} 家`, `Free quota: ${s.connected} connected, ${s.poolModels.auto} models in the pool; ${s.missing} more to claim${s.missingCny ? ` (≈ ¥${s.missingCny})` : ''}; check-in ${s.checkinConnected}/${s.checkinConnected + s.checkinMissing}`)));
    if (s.poolModels.auto)
        info(dim(L('模型名：free/auto、free/smart、free/fast', 'Model names: free/auto, free/smart, free/fast')));
    for (const d of o.discoveries)
        info(`  ${L('新发现', 'new')}: ${d.title}${d.url ? `  ${d.url}` : ''}`);
    const tag = {
        connected: () => L('✓ 在用', '✓ in use'),
        cooling: () => L('… 冷却中', '… cooling'),
        optin: () => L('$ 会扣钱，没进池', '$ charges, not in pool'),
        capped: () => L('! 到上限', '! cap reached'),
        missing: () => L('  还没领', '  not claimed'),
    };
    for (const e of o.entries) {
        const meta = [CYCLE[e.cycle]?.() ?? e.cycle, e.amount, e.until ? L(`到 ${e.until}`, `until ${e.until}`) : '', e.kind === 'checkin' ? L('只签到', 'check-in only') : ''].filter(Boolean).join(' · ');
        info(`${tag[e.status]()}  ${e.name}${e.cny ? ` ≈ ¥${e.cny}` : ''}\n      ${dim(meta)}${e.status === 'missing' ? `\n      ${dim(e.url)}` : ''}`);
    }
    for (const p of o.pool)
        if (p.models.length)
            info(`${bold(`free/${p.tier}`)}  ${dim(p.models.map((m) => m.alias).join(' → '))}`);
}
export async function free(ctx, sub, args) {
    const out = (o) => (isJsonMode() ? printJson(o) : show(o));
    if (!sub || sub === 'list') {
        out(await control(ctx, 'GET', '/free'));
        return 0;
    }
    if (sub === 'discover') {
        const r = await control(ctx, 'POST', '/free/discover');
        if (!isJsonMode())
            ok(L(`探测完成，新发现 ${r.found} 条`, `Done, ${r.found} new`));
        out(r);
        return 0;
    }
    if (sub === 'optin') {
        const [source, cap] = args;
        if (!source || !cap)
            throw new DshModelError('missing_arg', L('用法：dsh-model free optin <来源> <token 上限>', 'Usage: dsh-model free optin <source> <token cap>'));
        out(await control(ctx, 'POST', '/free/optin', { source, capTokens: Number(cap) }));
        return 0;
    }
    if (sub === 'optout') {
        if (!args[0])
            throw new DshModelError('missing_arg', L('用法：dsh-model free optout <来源>', 'Usage: dsh-model free optout <source>'));
        out(await control(ctx, 'POST', '/free/optout', { source: args[0] }));
        return 0;
    }
    if (sub === 'add') {
        const i = args.indexOf('--free');
        const cycle = i >= 0 ? args[i + 1] : undefined;
        const rest = i >= 0 ? args.filter((_, j) => j !== i && j !== i + 1) : args;
        const [name, baseUrl, key] = rest;
        if (!name || !baseUrl || !key)
            throw new DshModelError('missing_arg', L('用法：dsh-model free add <名字> <地址> <key> [--free daily|monthly|once|forever]', 'Usage: dsh-model free add <name> <url> <key> [--free daily|monthly|once|forever]'));
        const r = await control(ctx, 'POST', '/custom-sources', { name, baseUrl, key, free: i >= 0, ...(cycle ? { cycle } : {}) });
        if (isJsonMode())
            printJson(r);
        else
            ok(L(`已添加 ${r.id}，读到 ${r.models} 个模型${i >= 0 ? '，已进免费池' : ''}`, `Added ${r.id} with ${r.models} models${i >= 0 ? ', in the free pool' : ''}`));
        return 0;
    }
    throw new DshModelError('unknown_command', L(`未知子命令：free ${sub}`, `Unknown subcommand: free ${sub}`));
}
