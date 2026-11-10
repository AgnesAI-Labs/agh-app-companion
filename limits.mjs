const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * Engine limits. The settings schema is pinned to the configure service, so caps the owner cannot
 * set yet live here; a null cap is not enforced.
 *
 * @typedef {{
 *   workspaceConcurrency: number, maxHops: number, refusalLimit: number,
 *   taskTokens: number | null, taskCost: number | null, dailyCost: number | null,
 *   proposalTtlMs: number, recentMessages: number, recentWindowMs: number,
 *   snapshotTasks: number, snapshotEndedMs: number, answerMaxChars: number, candidateMax: number,
 *   inboxTtlMs: number, outboxTtlMs: number, compactAfterMs: number,
 *   storeWarnRatio: number, storeRefuseRatio: number, judgeFailuresNotify: number,
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
  candidateMax: 3,
  inboxTtlMs: 7 * DAY,
  outboxTtlMs: 7 * DAY,
  compactAfterMs: 30 * DAY,
  storeWarnRatio: 0.8,
  storeRefuseRatio: 0.95,
  judgeFailuresNotify: 3,
})
