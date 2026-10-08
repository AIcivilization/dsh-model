// util/port.ts — 端口占用检测
import { createServer } from 'node:net';
export function isPortFree(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen(port, host, () => server.close(() => resolve(true)));
    });
}
/** 从 start 起找第一个空闲端口（最多试 50 个） */
export async function findFreePort(start, host = '127.0.0.1') {
    for (let p = start; p < start + 50; p++)
        if (await isPortFree(p, host))
            return p;
    throw new Error(`no free port in ${start}..${start + 49}`);
}
