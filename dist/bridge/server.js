// bridge/server.ts — dsh-model 的 WorkBuddy bridge：把 WorkBuddy 私有接口变成本机 OpenAI 兼容接口
//
// 只绑 127.0.0.1，要求内部密钥（引擎的 openai-compatibility 上游带着它来）；Host / Origin 必须是回环，挡 DNS rebinding。
// 路由按产品分前缀：/cn/v1/...（WorkBuddy 国内版）、/ai/v1/...（WorkBuddy AI 国际版）。
// 协议细节（凭据解密、客户端身份、刷新、目录）来自移植的 ./workbuddy/*（MIT，见其 LICENSE）。
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { aggregateSse } from './aggregate.js';
import { hostIsLoopback, originIsLoopback } from './workbuddy/loopback.js';
import { extractDisplayErrorMessage, prepareChatBody } from './workbuddy/upstream.js';
const BODY_LIMIT = 64 * 1024 * 1024;
const KIND_STATUS = {
    hard_credit: 402,
    soft_rate: 429,
    session_dead: 401,
    not_found: 502,
    server: 502,
    client: 400,
};
function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}
function oaiError(res, status, code, message) {
    json(res, status, { error: { message, type: code, code } });
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > BODY_LIMIT) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}
export function createBridge(options) {
    const expected = Buffer.from(options.secret);
    const byKey = new Map(options.variants.map((v) => [v.key, v]));
    const log = options.log ?? (() => { });
    const authorized = (req) => {
        const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? '').trim());
        if (!m)
            return false;
        const got = Buffer.from(m[1]);
        return got.length === expected.length && timingSafeEqual(got, expected);
    };
    const server = createServer((req, res) => {
        void handle(req, res).catch((error) => {
            log(`bridge: unhandled ${String(error)}`);
            if (!res.headersSent)
                oaiError(res, 500, 'internal', 'bridge internal error');
            else
                res.end();
        });
    });
    async function handle(req, res) {
        if (!hostIsLoopback(req.headers.host))
            return oaiError(res, 403, 'host_not_allowed', 'Host must be loopback');
        if (!originIsLoopback(req.headers.origin))
            return oaiError(res, 403, 'origin_not_allowed', 'Origin must be loopback');
        if (!authorized(req))
            return oaiError(res, 401, 'unauthorized', 'missing or invalid bearer');
        const url = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
        if (req.method === 'GET' && url === '/healthz')
            return json(res, 200, { ok: true });
        if (req.method === 'GET' && url === '/status') {
            const out = {};
            for (const v of options.variants) {
                const st = await v.store.status().catch((e) => ({ signedIn: false, error: String(e) }));
                out[v.key] = { label: v.label, models: v.catalog.current().length, auth: st };
            }
            return json(res, 200, out);
        }
        if (req.method === 'POST' && url === '/refresh') {
            if (!options.onRefresh)
                return oaiError(res, 404, 'not_found', 'refresh not supported');
            return json(res, 200, { ok: true, result: await options.onRefresh() });
        }
        const m = /^\/([a-z]+)\/v1\/(models|chat\/completions)$/.exec(url);
        const variant = m ? byKey.get(m[1]) : undefined;
        if (!m || !variant)
            return oaiError(res, 404, 'not_found', `no such route: ${req.method} ${url}`);
        if (m[2] === 'models' && req.method === 'GET') {
            return json(res, 200, { object: 'list', data: variant.catalog.current().map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: 'workbuddy' })) });
        }
        if (m[2] === 'chat/completions' && req.method === 'POST')
            return chat(variant, req, res);
        return oaiError(res, 405, 'method_not_allowed', `${req.method} ${url}`);
    }
    async function chat(variant, req, res) {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
            return oaiError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
        let credential;
        try {
            credential = await variant.store.resolve();
        }
        catch (error) {
            return oaiError(res, 401, 'not_signed_in', `${variant.label}: ${String(error.message ?? error)} — sign in again in the ${variant.label} app`);
        }
        const raw = (await readBody(req)).toString('utf8');
        let wantsStream = true;
        try {
            wantsStream = JSON.parse(raw).stream !== false;
        }
        catch {
            return oaiError(res, 400, 'invalid_json', 'request body is not JSON');
        }
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        const result = await variant.client.chatStream(credential, prepareChatBody(raw), controller.signal);
        if (!result.ok) {
            const detail = extractDisplayErrorMessage(result.message) ?? result.message.slice(0, 400);
            return oaiError(res, KIND_STATUS[result.kind], result.kind, `${variant.label} upstream ${result.kind} (http ${result.status}): ${detail}`);
        }
        const body = Readable.fromWeb(result.response.body);
        if (!wantsStream) {
            let text = '';
            for await (const chunk of body)
                text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            return json(res, 200, aggregateSse(text));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        let sawDone = false;
        body.on('data', (c) => {
            if (c.includes('[DONE]'))
                sawDone = true;
        });
        body.on('error', (error) => {
            log(`bridge: ${variant.label} stream failed mid-flight: ${String(error)}`);
            // 上游中途断开：补发 [DONE]，让客户端正常收尾而不是挂住
            if (!sawDone && res.writable)
                res.end('data: [DONE]\n\n');
        });
        body.pipe(res);
    }
    const ready = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host ?? '127.0.0.1', () => {
            const addr = server.address();
            resolve(typeof addr === 'object' && addr ? addr.port : options.port);
        });
    });
    return {
        server,
        ready,
        close: () => new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        }),
    };
}
