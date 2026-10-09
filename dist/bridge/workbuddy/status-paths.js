// Ported from dsh-workbuddy-connect v0.7.1 (commit 390582e04da4e8e8bf746d71997440e4b716ec47),
// https://github.com/corrinehu/dsh-workbuddy-connect — MIT License, Copyright (c) 2026 Corrine Hu.
// See LICENSE.dsh-workbuddy-connect in this directory. Changes: imports adapted to dsh-model (./_compat.js).
/** Node-free constants and types shared by the Host and browser halves. */
/** Plugin-owned status endpoint consumed by its browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-workbuddy-connect/status';
/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
export const WORKBUDDY_PROBE_PATH = '/plugins/dsh-workbuddy-connect/probe';
/**
 * The international (WorkBuddy AI) variant's own pair of routes.
 *
 * Kept as separate constants rather than a computed suffix so both halves
 * reference literal strings: the browser bundle and the host bundle are built
 * independently, and a shared expression is one build-config drift away from
 * the desk asking a route the host never mounted.
 */
export const WORKBUDDY_AI_STATUS_PATH = '/plugins/dsh-workbuddy-connect/ai/status';
export const WORKBUDDY_AI_PROBE_PATH = '/plugins/dsh-workbuddy-connect/ai/probe';
/**
 * Same-origin route backing the browser's update reminder.
 *
 * Read-only like the status route, so the same loopback Host/Origin gate
 * applies; it answers public npm/GitHub metadata only and never token
 * material.
 */
export const WORKBUDDY_UPDATE_PATH = '/plugins/dsh-workbuddy-connect/update';
/** Every reason code, for validation without trusting a wire value. */
const SIGNED_OUT_REASON_CODES = [
    'no-credential',
    'credential-region-mismatch',
    'encrypted-credential-unreadable',
    'electron-binary-not-found',
    'electron-binary-ambiguous',
    'electron-binary-unavailable',
    'electron-path-invalid',
    'electron-discovery-incomplete',
];
/** Whether a value is one of the closed set of signed-out reason codes. */
export function isWorkBuddySignedOutReasonCode(value) {
    return typeof value === 'string' && SIGNED_OUT_REASON_CODES.includes(value);
}
