import { SLOT_STATES } from './machine.mjs'
import { handbackReason } from './signals.mjs'
import { allTasks, choiceCard, dispose, enqueueMessage, getTask, label, TEXT, transit } from './tasks.mjs'
import { recentConversation } from './context.mjs'

/**
 * Turns session facts into table events: the task-to-session mapping is checked against list(),
 * new session events are read from the task's cursor, and usage is summed against the budget.
 * @param {import('./effects.mjs').EffectDeps} deps
 */
export async function reconcile(deps) {
  const rows = new Map((await deps.sessions.list()).map((row) => [row.sessionId, row]))
  // A paused task's session events (its interrupt, a turn that ended anyway) must not replay after 继续.
  for (const task of allTasks(deps.tx()).filter((t) => t.state === 'paused' && t.sessionId && rows.has(t.sessionId))) {
    const { lastSeq } = await deps.sessions.events(task.sessionId, { afterSeq: task.cursor })
    const tx = deps.tx()
    tx.store.transaction(() => tx.store.putTask({ ...getTask(tx, task.id), cursor: lastSeq }))
  }
  const tasks = allTasks(deps.tx()).filter((t) => SLOT_STATES.includes(t.state) && t.sessionId)
  for (const task of tasks) {
    const row = rows.get(task.sessionId)
    if (!row || row.archived) {
      const tx = deps.tx()
      tx.store.transaction(() => transit(tx, task.id, 'sessionLost'))
      continue
    }
    const { events, lastSeq } = await deps.sessions.events(task.sessionId, { afterSeq: task.cursor })
    const ended = events.some((e) => e.kind === 'turn' && e.status === 'completed')
    const reply = ended ? ((await deps.sessions.result(task.sessionId)).text ?? '') : ''
    const usage = reading(await deps.sessions.usage(task.sessionId))
    const tx = deps.tx()
    tx.store.transaction(() => {
      tx.store.putTask({ ...getTask(tx, task.id), cursor: lastSeq })
      waitState(tx, task.id, row.status)
      for (const event of events) apply(tx, task.id, event, reply)
      account(tx, task.id, usage)
    })
  }
}

/**
 * The platform reports waiting as a flag on the session's status, not as an event, so the task
 * follows the status read in this pass.
 * @param {import('./tasks.mjs').Tx} tx @param {string} taskId @param {import('./sessions.mjs').SessionStatus} status
 */
function waitState(tx, taskId, status) {
  const task = getTask(tx, taskId)
  if (status.flags.length && task.state === 'running') transit(tx, taskId, 'sessionWaiting')
  // The session left its wait: the owner's answer or the approval result reached it.
  if (!status.flags.length && task.state === 'waiting') transit(tx, taskId, 'ownerAnswered')
}

/**
 * Tokens are input plus output; cost is kept only in USD, the one currency the platform reports, so
 * another currency reads as unknown rather than as a wrong number.
 * @param {import('./sessions.mjs').SessionUsage} usage @returns {import('./tasks.mjs').Usage}
 */
function reading(usage) {
  return {
    tokens: usage.inputTokens === null || usage.outputTokens === null ? null : usage.inputTokens + usage.outputTokens,
    cost: usage.cost && usage.cost.currency === 'USD' ? usage.cost.amount : null,
  }
}

/**
 * The owner approves on the local Web: a chat card cannot answer an approval and the platform sends
 * no notice for a managed session, so the companion says, once per approval, that the task waits.
 * The key names the session generation and the approval's seq, so a replay or restart repeats nothing.
 * @param {import('./tasks.mjs').Tx} tx @param {import('./tasks.mjs').Task} task @param {number} seq
 */
function waitForApproval(tx, task, seq) {
  if (task.state === 'running') transit(tx, task.id, 'sessionWaiting')
  enqueueMessage(tx, { deliveryKey: `approval:${task.id}:g${task.generation}:${seq}`, text: `${label(task)}：${TEXT.approvalWaiting}`, taskIds: [task.id] })
}

/** @param {import('./tasks.mjs').Tx} tx @param {string} taskId @param {import('./sessions.mjs').SessionEvent} event @param {string} reply */
function apply(tx, taskId, event, reply) {
  const task = getTask(tx, taskId)
  if (event.kind === 'approval' && event.state === 'expired') transit(tx, taskId, 'approvalExpired')
  if (event.kind === 'approval' && event.state === 'decided' && task.state === 'waiting') transit(tx, taskId, 'ownerAnswered')
  // The platform reports neither an approval's verdict nor its later state change (the node keeps its
  // first seq), so an approved step cannot be told from a refused one. Failing closed, every permission
  // request first seen pending counts toward the limit, and only the owner continuing the task
  // restarts the count. One first seen decided was answered before this pass, or allowed by full
  // access without a person, so it is not counted.
  if (event.kind === 'approval' && event.state === 'pending' && event.category === 'permission') {
    const refusals = task.refusals + 1
    tx.store.putTask({ ...task, refusals })
    if (refusals >= tx.limits.refusalLimit) transit(tx, taskId, 'refusedThrice')
    else waitForApproval(tx, getTask(tx, taskId), event.seq)
  }
  if (event.kind !== 'turn' || event.status === 'running' || event.status === 'waiting') return
  if (event.status === 'failed') return void transit(tx, taskId, 'sessionFailed')
  if (event.status === 'cancelled') return void transit(tx, taskId, 'turnInterrupted')
  const reason = task.attach?.sent ? handbackReason(reply) : undefined
  if (reason !== undefined) return handback(tx, task, reason)
  if (task.attach?.sent) tx.store.putTask({ ...task, attach: null })
  transit(tx, taskId, 'sessionCompleted', { note: reply.slice(0, 500) })
}

/**
 * §4.19 退回: the task goes back to its state before the message, and the owner chooses again.
 * A message returned before, or one the owner already placed on a card, offers only "new".
 * @param {import('./tasks.mjs').Tx} tx @param {import('./tasks.mjs').Task} task @param {string} reason
 */
function handback(tx, task, reason) {
  const mark = /** @type {import('./tasks.mjs').AttachMark} */ (task.attach)
  const entry = tx.store.get(mark.inbox)
  transit(tx, task.id, 'handback', { note: `退回：${reason.slice(0, 200)}` })
  const onlyNew = mark.picked || entry?.handedBack
  const candidates = onlyNew
    ? []
    : [...new Set(recentConversation(tx, new Set([mark.inbox])).flatMap((item) => item.taskIds))]
        .filter((id) => id !== task.id && tx.store.getTask(id))
        .map((id) => getTask(tx, id))
        .filter((t) => t.state !== 'abandoned' && t.state !== 'expired')
  // The worker's reason is detail: the owner sees it, the judge's recent conversation never does.
  choiceCard(tx, mark.inbox, candidates, `${label(task)} 退回了一条消息，要接到哪里？`, entry?.handedBack ? 2 : 1, `原因：${reason}`)
  if (entry) tx.store.set(mark.inbox, { ...entry, handedBack: true })
  dispose(tx, mark.inbox, { kind: 'returned', taskIds: [task.id], reason })
}

const plus = (a, b) => (b === null ? a : (a ?? 0) + b)

/** Adds the session's new usage to the task and the day, then applies the caps. Null stays unknown. */
function account(tx, taskId, reading) {
  const task = getTask(tx, taskId)
  const delta = {
    tokens: reading.tokens === null ? null : reading.tokens - (task.reading.tokens ?? 0),
    cost: reading.cost === null ? null : reading.cost - (task.reading.cost ?? 0),
  }
  const usage = { tokens: plus(task.usage.tokens, delta.tokens), cost: plus(task.usage.cost, delta.cost) }
  tx.store.putTask({ ...task, usage, reading })
  const dayKey = `usage/${tx.at.slice(0, 10)}`
  const day = tx.store.get(dayKey) ?? { tokens: 0, cost: 0, unknown: false }
  const today = {
    tokens: day.tokens + (delta.tokens ?? 0),
    cost: day.cost + (delta.cost ?? 0),
    unknown: day.unknown || reading.tokens === null || reading.cost === null,
  }
  tx.store.set(dayKey, today)
  const { taskTokens, taskCost, dailyCost, maxHops } = tx.limits
  const since = task.budgetBase
  const over =
    (taskTokens !== null && usage.tokens !== null && usage.tokens - (since.tokens ?? 0) > taskTokens) ||
    (taskCost !== null && usage.cost !== null && usage.cost - (since.cost ?? 0) > taskCost) ||
    (dailyCost !== null && today.cost > dailyCost)
  if (over) transit(tx, taskId, 'overBudget')
  else if (task.hops > maxHops) transit(tx, taskId, 'overHops')
}
