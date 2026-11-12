/**
 * Task states and the one table that moves a task between them. The rows mirror the state table
 * in the companion design §4.3 in order; the last three rows are the additions named beside them.
 *
 * @typedef {'proposed' | 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'paused' | 'abandoned' | 'expired'} TaskState
 * @typedef {'approvalExpired' | 'sessionFailed' | 'budget' | 'hops' | 'sessionLost' | 'turnInterrupted' | 'refused' | 'platform' | 'prFailed'} StateReason
 * @typedef {'ownerConfirm' | 'ownerRefuse' | 'proposalExpired' | 'sessionWaiting' | 'sessionAsked' | 'questionRecovered' | 'ownerAnswered' | 'approvalExpired'
 *   | 'sessionCompleted' | 'sessionFailed' | 'overBudget' | 'overHops' | 'sessionLost' | 'turnInterrupted'
 *   | 'refusedThrice' | 'prFailed' | 'ownerContinue' | 'ownerMessage' | 'ownerStop' | 'slotFree' | 'handback' | 'platformRefused'} TaskEventName
 * @typedef {'resume' | 'continue' | 'reopen' | 'interrupt' | 'endedReply' | 'restore'} RowEffect
 * @typedef {{
 *   from: readonly TaskState[], on: TaskEventName, to: TaskState | 'same' | 'prior',
 *   reason?: StateReason, effect?: RowEffect, when?: (task: { resumed: number }) => boolean,
 * }} Row
 */

/** States that hold one of the workspace's session slots (limits.workspaceConcurrency). */
export const SLOT_STATES = Object.freeze(/** @type {TaskState[]} */ (['running', 'waiting']))
export const UNFINISHED = Object.freeze(/** @type {TaskState[]} */ (['proposed', 'queued', 'running', 'waiting', 'paused']))
const ACTIVE = SLOT_STATES

/** @type {readonly Row[]} */
export const TRANSITIONS = Object.freeze([
  { from: ['proposed'], on: 'ownerConfirm', to: 'running' },
  { from: ['proposed'], on: 'ownerRefuse', to: 'abandoned' },
  { from: ['proposed'], on: 'proposalExpired', to: 'expired' },
  { from: ['running'], on: 'sessionWaiting', to: 'waiting' },
  { from: ['done'], on: 'questionRecovered', to: 'waiting' },
  // Native waiting may already hold the task when the separate ask_owner turn ends.
  { from: ACTIVE, on: 'sessionAsked', to: 'waiting' },
  { from: ['waiting'], on: 'ownerAnswered', to: 'running' },
  { from: ['waiting'], on: 'approvalExpired', to: 'failed', reason: 'approvalExpired' },
  { from: ['running'], on: 'prFailed', to: 'paused', reason: 'prFailed' },
  { from: ['running'], on: 'sessionCompleted', to: 'done' },
  { from: ['running'], on: 'sessionFailed', to: 'failed', reason: 'sessionFailed' },
  { from: ACTIVE, on: 'overBudget', to: 'paused', reason: 'budget', effect: 'interrupt' },
  { from: ACTIVE, on: 'overHops', to: 'paused', reason: 'hops', effect: 'interrupt' },
  { from: ACTIVE, on: 'sessionLost', to: 'paused', reason: 'sessionLost' },
  { from: ['running'], on: 'turnInterrupted', when: (t) => t.resumed === 0, to: 'running', effect: 'resume' },
  { from: ['running'], on: 'turnInterrupted', when: (t) => t.resumed > 0, to: 'paused', reason: 'turnInterrupted' },
  { from: ACTIVE, on: 'refusedThrice', to: 'paused', reason: 'refused', effect: 'interrupt' },
  { from: ['paused'], on: 'ownerContinue', to: 'running', effect: 'continue' },
  { from: ['done', 'failed'], on: 'ownerMessage', to: 'running', effect: 'reopen' },
  { from: UNFINISHED, on: 'ownerStop', to: 'abandoned', effect: 'interrupt' },
  { from: ['abandoned', 'expired'], on: 'ownerMessage', to: 'same', effect: 'endedReply' },
  // Decision round 16: a task waits here while its workspace has no free slot.
  { from: ['queued'], on: 'slotFree', to: 'running' },
  // §4.19: the worker returned an attached message; the task goes back to where it was before.
  { from: ACTIVE, on: 'handback', to: 'prior', effect: 'restore' },
  // The platform refused a start or send for a reason waiting cannot cure (platform-sessions.mjs).
  { from: ACTIVE, on: 'platformRefused', to: 'paused', reason: 'platform' },
])

/**
 * The row that applies, or undefined when the event does not move a task in this state.
 * @param {{ state: TaskState, resumed: number }} task @param {TaskEventName} event
 */
export function transition(task, event) {
  return TRANSITIONS.find((row) => row.on === event && row.from.includes(task.state) && (!row.when || row.when(task)))
}
