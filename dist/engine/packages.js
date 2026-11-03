// engine/packages.ts — 引擎也随 npm 一起装（设计 §3.3）
//
// 引擎（CLIProxyAPI）本来只从 GitHub 发布页下载，国内连不上。改成也发到 npm：
// 每个平台一个包 dsh-model-engine-<platform>-<arch>（os/cpu 限定，npm 只装当前平台那一个），
// 里面就是解压好的二进制。dsh-model 把它们列为 optionalDependencies，所以插件市场（走 npm，国内有镜像）
// 装 dsh-model 时引擎就跟着下来了，setup 不用再碰 GitHub。装不到（没发布 / 老环境）就回退到下载。
//
// 包的版本号 = 引擎版本（如 8.0.13），不是 dsh-model 的版本：引擎很少换，平时发版不用重发这些包。
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { PKG_ROOT } from '../util/pkg.js';
export const ENGINE_BIN = process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
/** 平台包名：用 Node 的 process.platform/arch 命名（darwin-arm64、linux-x64、win32-x64…） */
export function enginePackageName(platform = process.platform, arch = process.arch) {
    return `dsh-model-engine-${platform}-${arch}`;
}
/**
 * 找 npm 装好的平台引擎包。版本对不上（包比清单旧）当没有，走下载。
 * baseFile 只给测试用，正常从本包所在位置解析（平台包是本包的 optionalDependency）。
 */
export function localEngineBinary(version, platform = process.platform, arch = process.arch, baseFile = join(PKG_ROOT, 'package.json')) {
    const name = enginePackageName(platform, arch);
    try {
        const require = createRequire(baseFile);
        const metaPath = require.resolve(`${name}/package.json`);
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        if ((meta.engineVersion ?? meta.version) !== version)
            return null;
        const bin = join(dirname(metaPath), platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api');
        if (!existsSync(bin))
            return null;
        return { bin, ...(meta.engineSha256 ? { sha256: meta.engineSha256 } : {}) };
    }
    catch {
        return null;
    }
}
