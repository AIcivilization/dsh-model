// cli.ts — 参数解析与分发；统一错误输出（中英双语）与退出码
import { parseArgs } from 'node:util';
import { connect, disconnect, models } from './commands/connect.js';
import { engine } from './commands/engine.js';
import { key } from './commands/key.js';
import { login, logout } from './commands/login.js';
import { logs } from './commands/logs.js';
import { remote } from './commands/remote.js';
import { repair, service } from './commands/service.js';
import { setup } from './commands/setup.js';
import { doctor, status } from './commands/status.js';
import { uninstall } from './commands/uninstall.js';
import { createContext } from './context.js';
import { isDshModelError } from './errors.js';
import { L, initLang } from './i18n.js';
import { UPSTREAMS } from './upstreams.js';
import { dim, fail, isJsonMode, printJson, setJsonMode } from './util/output.js';
import { pkgVersion } from './util/pkg.js';
const OPTIONS = {
    lang: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    port: { type: 'string' },
    profile: { type: 'string' },
    force: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    'keep-auth': { type: 'boolean' },
    device: { type: 'boolean' },
    replace: { type: 'boolean' },
    'accept-risk': { type: 'boolean' },
    via: { type: 'string' },
    domain: { type: 'string' },
    e2e: { type: 'boolean' },
    all: { type: 'boolean' },
    model: { type: 'string' },
    lines: { type: 'string' },
};
function help() {
    const ups = UPSTREAMS.map((u) => u.id).join('|');
    return L(`dsh-model ${pkgVersion()} — 把你自己的 CLI 订阅接进 dsh（本机 OpenAI 兼容端点，默认鉴权，可干净卸载）

用法：dsh-model <命令> [选项]

  setup [--port N] [--profile P]       一键安装：引擎、key、系统服务、接入 dsh（可重复执行）
  login <${ups}> [--device] [--replace] [--accept-risk]
                                       登录上游订阅
  logout <上游>                         退出登录
  status                               一屏总览
  doctor [--e2e] [--all] [--model M]   逐项自检；--e2e 实测流式与工具调用
  connect-dsh [--dry-run] [--force]    写入 / 刷新 dsh 配置
  disconnect-dsh                       还原 dsh 配置
  models [sync]                        列出模型 / 同步到 dsh
  key list|add|revoke|rotate <名称>     管理访问 key（每台设备一把）
  remote enable --via ssh|tailscale|caddy [--domain D] / remote disable
                                       让你自己的其他设备访问
  engine version|upgrade [版本]|rollback 引擎版本管理
  service status|install|start|stop|restart|uninstall
  repair                               按台账修复配置、服务与接线
  logs [--lines N]                     引擎日志
  uninstall [--yes] [--keep-auth]      干净卸载

通用选项：--lang zh|en  --json  --help  --version
环境变量：DSH_HOME、DSH_MODEL_HOME、DSH_MODEL_LANG`, `dsh-model ${pkgVersion()} — wire your own CLI subscriptions into dsh (local OpenAI-compatible endpoint, auth by default, clean uninstall)

Usage: dsh-model <command> [options]

  setup [--port N] [--profile P]       One-step install: engine, key, service, dsh wiring (idempotent)
  login <${ups}> [--device] [--replace] [--accept-risk]
                                       Log in to an upstream subscription
  logout <upstream>                    Log out
  status                               Overview
  doctor [--e2e] [--all] [--model M]   Health checks; --e2e tests streaming and tool calls
  connect-dsh [--dry-run] [--force]    Write / refresh dsh config
  disconnect-dsh                       Restore dsh config
  models [sync]                        List models / sync them to dsh
  key list|add|revoke|rotate <name>    Manage access keys (one per device)
  remote enable --via ssh|tailscale|caddy [--domain D] / remote disable
                                       Access from your other devices
  engine version|upgrade [ver]|rollback  Engine version management
  service status|install|start|stop|restart|uninstall
  repair                               Repair config, service and wiring from the ledger
  logs [--lines N]                     Engine logs
  uninstall [--yes] [--keep-auth]      Clean uninstall

Global: --lang zh|en  --json  --help  --version
Env: DSH_HOME, DSH_MODEL_HOME, DSH_MODEL_LANG`);
}
export async function main(argv) {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    }
    catch (error) {
        initLang();
        fail(String(error.message));
        return 2;
    }
    const { values: o, positionals: [cmd, a1, a2] } = parsed;
    initLang(o.lang);
    setJsonMode(Boolean(o.json));
    if (o.version) {
        console.log(pkgVersion());
        return 0;
    }
    if (o.help || !cmd || cmd === 'help') {
        console.log(help());
        return 0;
    }
    try {
        const ctx = await createContext();
        const port = o.port ? Number(o.port) : undefined;
        if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))
            throw new Error(L(`端口不合法：${o.port}`, `Invalid port: ${o.port}`));
        switch (cmd) {
            case 'setup':
                return await setup(ctx, { port, profile: o.profile, force: o.force });
            case 'login':
                if (!a1)
                    throw new Error(L(`用法：dsh-model login <${UPSTREAMS.map((u) => u.id).join('|')}>`, `Usage: dsh-model login <${UPSTREAMS.map((u) => u.id).join('|')}>`));
                return await login(ctx, a1, { device: o.device, replace: o.replace, acceptRisk: o['accept-risk'] });
            case 'logout':
                if (!a1)
                    throw new Error(L('用法：dsh-model logout <上游>', 'Usage: dsh-model logout <upstream>'));
                return await logout(ctx, a1);
            case 'status':
                return await status(ctx);
            case 'doctor':
                return await doctor(ctx, { e2e: o.e2e, all: o.all, model: o.model });
            case 'connect-dsh':
                return await connect(ctx, { dryRun: o['dry-run'], profile: o.profile, force: o.force });
            case 'disconnect-dsh':
                return await disconnect(ctx);
            case 'models':
                return await models(ctx, a1);
            case 'key':
                return await key(ctx, a1, a2);
            case 'remote':
                return await remote(ctx, a1, { via: o.via, domain: o.domain });
            case 'engine':
                return await engine(ctx, a1, a2);
            case 'service':
                return await service(ctx, a1);
            case 'repair':
                return await repair(ctx);
            case 'logs':
                return await logs(ctx, o.lines ? Number(o.lines) : undefined);
            case 'uninstall':
                return await uninstall(ctx, { yes: o.yes, keepAuth: o['keep-auth'] });
            default:
                fail(L(`未知命令：${cmd}`, `Unknown command: ${cmd}`));
                console.log(dim(L('查看帮助：dsh-model --help', 'See: dsh-model --help')));
                return 2;
        }
    }
    catch (error) {
        if (isJsonMode()) {
            printJson({ ok: false, code: isDshModelError(error) ? error.code : 'error', message: error.message, hint: isDshModelError(error) ? error.hint : undefined });
        }
        else {
            fail(error.message);
            if (isDshModelError(error) && error.hint)
                console.error(dim(`  ${error.hint}`));
            if (!isDshModelError(error) && process.env.DSH_MODEL_DEBUG)
                console.error(error.stack);
        }
        return 1;
    }
}
