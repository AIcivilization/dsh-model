// Ported from dsh-workbuddy-connect v0.7.1 (commit 390582e04da4e8e8bf746d71997440e4b716ec47),
// https://github.com/corrinehu/dsh-workbuddy-connect — MIT License, Copyright (c) 2026 Corrine Hu.
// See LICENSE.dsh-workbuddy-connect in this directory. Changes: imports adapted to dsh-model (./_compat.js).
/**
 * The two WorkBuddy desktop apps this one plugin serves.
 *
 * Both products are the same client framework in different regions, and both
 * write their sign-in into the *same* shared `CodeBuddyExtension` auth
 * directory — they differ by file basename, base URL, catalog endpoint, and
 * display identity. Everything that varies between them is collected here as
 * one descriptor, so no module has to carry its own `if (international)`
 * branch and a third variant would be a data change rather than a refactor.
 *
 * This module is host-side (it names files and env vars). The browser half
 * takes the same ids and routes from the Node-free `status-paths.ts`, which
 * stays the single source shared by both halves.
 *
 * @module dsh-workbuddy-connect/variants
 */
import { WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH } from './status-paths.js';
/** CN WorkBuddy first: the existing provider keeps its id, paths, and copy. */
export const WORKBUDDY_VARIANTS = [
    {
        id: 'workbuddy',
        displayName: 'WorkBuddy',
        appName: 'WorkBuddy',
        region: 'cn',
        env: 'WORKBUDDY_AUTH_FILE',
        electron: {
            productName: 'WorkBuddy',
            envVar: 'WORKBUDDY_ELECTRON_BIN',
            macOS: {
                bundleId: 'com.tencent.workbuddy.mac',
                defaultPath: '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
            },
            windows: {
                displayNamePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
                exeBasename: 'workbuddy.exe',
                defaultPathSegments: ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
            },
        },
        desktopFilename: 'workbuddy-desktop.info',
        ownFilename: '.workbuddy-auth.json',
        probeFilename: '.workbuddy-probe.json',
        catalogFilename: '.workbuddy-catalog.json',
        visibilityFilename: '.workbuddy-model-visibility.json',
        statusPath: WORKBUDDY_STATUS_PATH,
        probePath: WORKBUDDY_PROBE_PATH,
    },
    {
        id: 'workbuddy-ai',
        displayName: 'WorkBuddy AI',
        appName: 'WorkBuddy AI',
        region: 'global',
        env: 'WORKBUDDY_AI_AUTH_FILE',
        electron: {
            productName: 'WorkBuddy AI',
            envVar: 'WORKBUDDY_AI_ELECTRON_BIN',
            macOS: {
                bundleId: 'com.workbuddy.workbuddy-ai',
                defaultPath: '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron',
            },
            windows: {
                // Measured in #60: `WorkBuddy AI 5.6.2`. The CN pattern cannot match
                // this value ("AI" is not a version) and this pattern cannot match
                // `WorkBuddy 5.6.2` (missing the literal " AI"), so the two records
                // never feed each other's discovery.
                displayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
                exeBasename: 'workbuddyai.exe',
            },
        },
        desktopFilename: 'workbuddy-desktop-ai.info',
        ownFilename: '.workbuddy-ai-auth.json',
        probeFilename: '.workbuddy-ai-probe.json',
        catalogFilename: '.workbuddy-ai-catalog.json',
        visibilityFilename: '.workbuddy-ai-model-visibility.json',
        statusPath: WORKBUDDY_AI_STATUS_PATH,
        probePath: WORKBUDDY_AI_PROBE_PATH,
    },
];
/** The CN variant; the plugin's long-standing default and compatibility anchor. */
export const CN_VARIANT = WORKBUDDY_VARIANTS[0];
/** The international variant. */
export const AI_VARIANT = WORKBUDDY_VARIANTS[1];
/** Look up a variant by provider id. */
export function variantFor(id) {
    return WORKBUDDY_VARIANTS.find(variant => variant.id === id);
}
/**
 * The Electron profile a variant resolves with.
 *
 * Callers inside the plugin pass their known-complete variants; descriptors
 * assembled outside (the type is public and predates the profile) fall back
 * by variant id, so an id-less or unknown custom variant stays on the CN
 * product — the same default the store's other legacy fields assume.
 */
export function electronProfileFor(variant) {
    // Both shipped variants always carry their profile; the optional marker
    // exists only for externally assembled descriptors, hence the assertion.
    return variant?.electron ?? (variant?.id === AI_VARIANT.id ? AI_VARIANT : CN_VARIANT).electron;
}
