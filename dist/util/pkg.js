// util/pkg.ts — 包根目录（dist/util/pkg.js 或 src/util/pkg.ts 往上两级）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 这个进程启动时装着的版本（之后磁盘上的包可能被换成新版，进程里跑的还是这个） */
export const RUNNING_VERSION = pkgVersion();
/** 磁盘上现在装着的版本 */
export function pkgVersion() {
    try {
        return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
    }
    catch {
        return '0.0.0';
    }
}
