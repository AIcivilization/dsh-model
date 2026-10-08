// dsh/credentials.ts — $DSH_HOME/.credentials.yaml 的 refs.<NAME>
//
// dsh-credentials-local 的规则：0600，否则拒绝加载；不接受空值和未知顶层键；
// 格式 version: 1 / refs: {NAME: value} / records: {...}。provider 里用 apiKeyEnv: NAME 引用。
import YAML, { isMap } from 'yaml';
import { DshModelError } from '../errors.js';
import { L } from '../i18n.js';
export const KEY_REF = 'DSH_MODEL_API_KEY';
function parse(text) {
    const src = text ?? '';
    const doc = YAML.parseDocument(src.trim() ? src : 'version: 1\n');
    if (doc.errors.length) {
        throw new DshModelError('credentials_invalid', L(`dsh 的 .credentials.yaml 有 YAML 语法错误：${doc.errors[0]?.message}`, `dsh .credentials.yaml has a YAML error: ${doc.errors[0]?.message}`));
    }
    if (!isMap(doc.contents)) {
        throw new DshModelError('credentials_invalid', L('dsh 的 .credentials.yaml 顶层不是映射，不敢改', 'dsh .credentials.yaml is not a top-level mapping; refusing to edit'));
    }
    return doc;
}
export function readRef(text, name = KEY_REF) {
    if (text == null)
        return undefined;
    const v = parse(text).getIn(['refs', name]);
    return typeof v === 'string' ? v : undefined;
}
export function upsertRef(text, value, name = KEY_REF) {
    const doc = parse(text);
    const root = doc.contents;
    if (!root.has('version'))
        root.set('version', 1);
    let refs = root.get('refs', true);
    if (refs == null) {
        root.set('refs', doc.createNode({}));
        refs = root.get('refs', true);
    }
    if (!isMap(refs))
        throw new DshModelError('credentials_invalid', L('.credentials.yaml 的 refs 不是映射，不敢改', '.credentials.yaml refs is not a mapping; refusing to edit'));
    refs.flow = false;
    refs.set(name, value);
    return doc.toString({ lineWidth: 0 });
}
/** 移除 refs.<NAME>；refs 因此变空就连 refs 键一起删（dsh 不接受空值） */
export function removeRef(text, name = KEY_REF) {
    if (text == null)
        return { text, changed: false };
    const doc = parse(text);
    const root = doc.contents;
    const refs = root.get('refs', true);
    if (!isMap(refs) || !refs.has(name))
        return { text, changed: false };
    refs.delete(name);
    if (refs.items.length === 0)
        root.delete('refs');
    return { text: doc.toString({ lineWidth: 0 }), changed: true };
}
