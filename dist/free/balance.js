// free/balance.ts — 余额兜底（设计 §14.34）
//
// 能分开查「充值余额」的平台：每 30 分钟看一次。充值余额只会因为两件事变少：免费池用了它的收费模型，
// 或者用户自己直接用了收费模型。不管是哪个，都先把这家整个移出免费池，等用户确认——宁可少用，不能替用户花钱。
// 赠送余额（新人券、实名送的）不算用户的钱，不看。
/** 能查充值余额的来源 → 怎么查 */
export const BALANCE_SOURCES = {
    // 硅基流动：原来的 /v1/user/info（chargeBalance）官方已停用，2026-11 实测返回 410，没有替代接口，
    // 所以查不了。它进免费池的只有官网价格为 0 的模型（free-catalog.json），不靠余额兜底。
    // { balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
    deepseek: {
        url: 'https://api.deepseek.com/user/balance',
        read: (b) => {
            const infos = b?.balance_infos;
            if (!Array.isArray(infos) || !infos.length)
                return null;
            const vals = infos.map((i) => num(i.topped_up_balance));
            return vals.some((v) => v === null) ? null : vals.reduce((s, v) => s + (v ?? 0), 0);
        },
    },
};
function num(v) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
}
/** 查一次充值余额；查不到（网络、key 不对、格式变了）返回 null，不当成「变少了」 */
export async function fetchPaidBalance(source, key, fetchImpl = fetch) {
    const s = BALANCE_SOURCES[source];
    if (!s)
        return null;
    try {
        const r = await fetchImpl(s.url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
        if (!r.ok)
            return null;
        return s.read(await r.json());
    }
    catch {
        return null;
    }
}
/** 比较前后两次：少了超过 1 分钱才算（避免四舍五入抖动） */
export const balanceDropped = (prev, now) => now < prev - 0.01;
