// util/redact.ts — key 脱敏：只露前缀和后 4 位
export function redactKey(key) {
    if (key.length <= 12)
        return '****';
    const prefix = key.startsWith('dshm_') ? 'dshm_' : key.slice(0, 4);
    return `${prefix}…${key.slice(-4)}`;
}
