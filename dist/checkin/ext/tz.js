// 拷自 dsh-checkin-all（同作者，MIT），见设计 §14.28；改动：日志前缀、只读开关的环境变量名。
// lib/tz.js — 统一按北京时间算「今天」
//
// 全部 7 个签到服务都按北京时间判断日期和签到窗口，不跟随本机时区。
// 原因：服务器返回的日期、连续签到天数、每日窗口都是北京日期；
// 本机在美西时，晚上 8 点之后就已经是北京的第二天，两套口径必然对不上。
//
// 这里只依赖 Intl（Node 自带 tzdata），不需要额外依赖。
export const CHECKIN_TZ = 'Asia/Shanghai';
const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHECKIN_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const PART_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: CHECKIN_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
});
/** 北京时间的日期 YYYY-MM-DD */
export function beijingDayKey(date = new Date()) {
    try {
        return DAY_FMT.format(date);
    }
    catch {
        // 极端情况下（时间无效）退回 ISO 日期，不让签到崩掉
        return new Date(date).toISOString().slice(0, 10);
    }
}
/** 北京时间的各个部分（给「到点没」判断用） */
export function beijingParts(date = new Date()) {
    const out = {};
    for (const p of PART_FMT.formatToParts(date))
        out[p.type] = p.value;
    return {
        year: Number(out.year),
        month: Number(out.month),
        day: Number(out.day),
        hour: Number(out.hour) % 24,
        minute: Number(out.minute),
        second: Number(out.second),
    };
}
/** 北京时间当天已经过了多少分钟（0-1439） */
export function beijingMinutes(date = new Date()) {
    const p = beijingParts(date);
    return p.hour * 60 + p.minute;
}
/** 往前/往后挪 n 天的北京日期 */
export function shiftDayKey(key, days) {
    const base = keyToUtcNoon(key);
    return beijingDayKey(new Date(base + days * 86_400_000));
}
/**
 * YYYY-MM-DD 转成一个「肯定落在北京那天中午」的时间戳。
 * 用 04:00Z = 北京 12:00，前后都离日界很远，加减一天不会跨错。
 */
export function keyToUtcNoon(key) {
    return Date.parse(`${key}T04:00:00Z`);
}
/** 解析 HH:MM 成分钟数；不合法返回 null */
export function parseHHMM(time) {
    const m = String(time || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!m)
        return null;
    return Number(m[1]) * 60 + Number(m[2]);
}
const STATUS_DONE = new Set(['claimed', 'already_claimed']);
/**
 * 按 days 账本重算连续天数。
 * 只认「真的签过」的天（claimed / already_claimed），dry-run、失败都不算。
 * 从今天往回数；今天还没有记录就从昨天数（当天还没到点签不算断）。
 */
export function streakFromDays(days, now = new Date()) {
    const keys = new Set(Object.keys(days || {}).filter((k) => {
        const entry = days[k];
        return entry && STATUS_DONE.has(entry.outcome);
    }));
    if (!keys.size)
        return 0;
    const today = beijingDayKey(now);
    const yesterday = shiftDayKey(today, -1);
    let cursor = keys.has(today) ? today : keys.has(yesterday) ? yesterday : null;
    if (!cursor)
        return 0;
    let count = 0;
    while (cursor && keys.has(cursor)) {
        count += 1;
        cursor = shiftDayKey(cursor, -1);
    }
    return count;
}
/** 账本里这些天累计领到的分（只算 claimed 且 points>0） */
export function pointsFromDays(days) {
    let sum = 0;
    for (const entry of Object.values(days || {})) {
        if (entry && entry.outcome === 'claimed')
            sum += Number(entry.points) || 0;
    }
    return sum;
}
/** 最近 n 天的北京日期（新的在前） */
export function recentDayKeys(count = 14, now = new Date()) {
    const today = beijingDayKey(now);
    const out = [];
    for (let i = 0; i < count; i += 1)
        out.push(shiftDayKey(today, -i));
    return out;
}
