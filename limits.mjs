const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * Engine limits, the one place for these numbers. The settings schema is pinned to the configure
 * service, so caps the owner cannot set yet live here; a null cap is not enforced. The token and
 * money caps stay null until a setting turns them on: no default amount is assumed. Money caps are
 * in USD, the only currency reconcile.mjs counts.
 *
 * @typedef {{
 *   workspaceConcurrency: number, maxHops: number, refusalLimit: number,
 *   taskTokens: number | null, taskCost: number | null, dailyCost: number | null,
 *   proposalTtlMs: number, recentMessages: number, recentWindowMs: number,
 *   snapshotTasks: number, snapshotEndedMs: number, answerMaxChars: number, titleMaxChars: number, candidateMax: number,
 *   inboxTtlMs: number, outboxTtlMs: number, compactAfterMs: number,
 *   storeWarnRatio: number, storeRefuseRatio: number, judgeFailuresNotify: number,
 *   tickIntervalMs: number, shutdownSettleMs: number,
 * }} Limits
 */

/** @type {Limits} */
export const LIMITS = Object.freeze({
  // Tasks in one workspace that may hold a session at once (decision round 16: v1a is 1).
  workspaceConcurrency: 1,
  maxHops: 8,
  refusalLimit: 3,
  taskTokens: null,
  taskCost: null,
  dailyCost: null,
  proposalTtlMs: 3 * DAY,
  recentMessages: 10,
  recentWindowMs: DAY,
  snapshotTasks: 50,
  snapshotEndedMs: 7 * DAY,
  answerMaxChars: 200,
  titleMaxChars: 120,
  candidateMax: 3,
  inboxTtlMs: 7 * DAY,
  outboxTtlMs: 7 * DAY,
  compactAfterMs: 30 * DAY,
  storeWarnRatio: 0.8,
  storeRefuseRatio: 0.95,
  judgeFailuresNotify: 3,
  // Pause between engine passes; a pass never overlaps the next.
  tickIntervalMs: 5000,
  // How long shutdown waits for a pass in flight; below the declared shutdownTimeoutMs (5000).
  shutdownSettleMs: 4000,
})

/**
 * The limits with the owner's caps from settings laid over them. An unset cap keeps the base value,
 * so a configuration without caps behaves exactly as before.
 * @param {Limits} base @param {{ caps?: Partial<import('./settings.mjs').Caps> }} settings @returns {Limits}
 */
export function withCaps(base, settings) {
  const caps = settings.caps ?? {}
  return Object.freeze({
    ...base,
    dailyCost: caps.dailyCost ?? base.dailyCost,
    taskCost: caps.taskCost ?? base.taskCost,
    taskTokens: caps.taskTokens ?? base.taskTokens,
  })
}
