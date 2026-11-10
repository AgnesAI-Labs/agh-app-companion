import { SLOT_STATES } from './machine.mjs'
import { handbackReason } from './signals.mjs'
import { allTasks, choiceCard, dispose, getTask, label, transit } from './tasks.mjs'
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
    const { cursor } = await deps.sessions.events(task.sessionId, task.cursor)
    const tx = deps.tx()
    tx.store.transaction(() => tx.store.putTask({ ...getTask(tx, task.id), cursor }))
  }
  const tasks = allTasks(deps.tx()).filter((t) => SLOT_STATES.includes(t.state) && t.sessionId)
  for (const task of tasks) {
    const row = rows.get(task.sessionId)
    if (!row || row.archived) {
      const tx = deps.tx()
      tx.store.transaction(() => transit(tx, task.id, 'sessionLost'))
      continue
    }
    const { events, cursor } = await deps.sessions.events(task.sessionId, task.cursor)
    const ended = events.some((e) => e.kind === 'turn' && e.outcome === 'completed')
    const reply = ended ? ((await deps.sessions.result(task.sessionId))?.text ?? '') : ''
    const usage = await deps.sessions.usage(task.sessionId)
    const tx = deps.tx()
    tx.store.transaction(() => {
      tx.store.putTask({ ...getTask(tx, task.id), cursor })
      for (const event of events) apply(tx, task.id, event, reply)
      account(tx, task.id, usage)
    })
  }
}

/** @param {import('./tasks.mjs').Tx} tx @param {string} taskId @param {import('./sessions.mjs').SessionEvent} event @param {string} reply */
function apply(tx, taskId, event, reply) {
  const task = getTask(tx, taskId)
  if (event.kind === 'status' && event.status.flags.length && task.state === 'running') transit(tx, taskId, 'sessionWaiting')
  // The session left its wait: the owner's answer or the approval result reached it.
  if (event.kind === 'status' && !event.status.flags.length && task.state === 'waiting') transit(tx, taskId, 'ownerAnswered')
  if (event.kind === 'approval' && event.state === 'expired') transit(tx, taskId, 'approvalExpired')
  if (event.kind === 'approval' && event.state === 'answered') {
    const refusals = event.decision === 'refused' ? task.refusals + 1 : 0
    tx.store.putTask({ ...task, refusals })
    if (refusals >= tx.limits.refusalLimit) transit(tx, taskId, 'refusedThrice')
    else if (task.state === 'waiting') transit(tx, taskId, 'ownerAnswered')
  }
  if (event.kind !== 'turn') return
  if (event.outcome === 'failed') return void transit(tx, taskId, 'sessionFailed')
  if (event.outcome === 'interrupted') return void transit(tx, taskId, 'turnInterrupted')
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
