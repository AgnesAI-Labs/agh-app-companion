import { SLOT_STATES } from './machine.mjs'
import { PUBLISH_TOOL_NAME, publishedPullRequest, pullRequestFailure } from './publish.mjs'
import { handbackReason } from './signals.mjs'
import { allTasks, choiceCard, dispose, enqueueMessage, getTask, isAsking, label, questionText, TEXT, transit } from './tasks.mjs'
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
    const closed = events.some((e) => e.kind === 'turn' && (e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled'))
    const publishes = await readPublishes(deps.sessions, task, events, closed)
    const tx = deps.tx()
    tx.store.transaction(() => {
      tx.store.putTask({ ...getTask(tx, task.id), cursor: lastSeq, ...publishes })
      waitState(tx, task.id, row.status)
      for (const event of events) apply(tx, task.id, event, reply)
      account(tx, task.id, usage)
    })
  }
}

/** Calls of the publish tool one task keeps waiting on at a time; older ones are dropped. */
const MAX_OPEN_PUBLISHES = 8

/**
 * A tool call is reported once, at its own seq, so the calls of `publish` that have no result yet are
 * kept on the task and asked for again each pass (`toolResult`, `pending` until the call ends). A done
 * result that names a pull request gives `prUrl` and `repo` together and clears `prFailed`; one that
 * says the branch is pushed but no pull request opened sets `prFailed` to the reason. Any other done
 * result, and a call left pending when the turn has ended, is dropped. The caller commits these with
 * the cursor.
 * @param {import('./sessions.mjs').ManagedSessions} sessions @param {import('./tasks.mjs').Task} task
 * @param {readonly import('./sessions.mjs').SessionEvent[]} events @param {boolean} turnClosed
 * @returns {{ publishCalls: number[], prUrl?: string, repo?: string, prFailed?: string | null }}
 */
async function readPublishes(sessions, task, events, turnClosed) {
  const seen = events.filter((e) => e.kind === 'tool' && e.name === PUBLISH_TOOL_NAME).map((e) => e.seq)
  const calls = [...new Set([...(task.publishCalls ?? []), ...seen])].sort((a, b) => a - b)
  /** @type {number[]} */
  const open = []
  /** @type {{ prUrl: string, repo: string, prFailed: null } | { prFailed: string } | undefined} */
  let found
  for (const seq of calls) {
    const result = await sessions.toolResult(/** @type {string} */ (task.sessionId), seq).catch(() => undefined)
    if (result?.state !== 'done') {
      open.push(seq)
      continue
    }
    const opened = !result.isError && publishedPullRequest(result.text)
    const failure = result.isError ? pullRequestFailure(result.text) : undefined
    if (opened) found = { ...opened, prFailed: null }
    else if (failure) found = { prFailed: failure }
  }
  return { publishCalls: turnClosed ? [] : open.slice(-MAX_OPEN_PUBLISHES), ...found }
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
  // A task waiting on its own question has no flag to clear: only the owner's answer ends that wait.
  if (!status.flags.length && task.state === 'waiting' && !isAsking(task)) transit(tx, taskId, 'ownerAnswered')
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
  // A permission request first seen pending only tells the owner the task waits. Its end arrives as
  // an approvalOutcome: only the owner's own refusal counts toward the limit and only the owner's
  // allow ends the streak. Expiry, full access and every automatic answer neither count nor reset.
  if (event.kind === 'approval' && event.state === 'pending' && event.category === 'permission') waitForApproval(tx, task, event.seq)
  if (event.kind === 'approvalOutcome' && event.via === 'person') {
    const current = getTask(tx, taskId)
    // A task already paused by this pass ignores what the same page still holds.
    if (current.state !== 'running' && current.state !== 'waiting') return
    if (event.outcome === 'allowed' && current.refusals) tx.store.putTask({ ...current, refusals: 0 })
    if (event.outcome === 'rejected') {
      const refusals = current.refusals + 1
      tx.store.putTask({ ...current, refusals })
      if (refusals >= tx.limits.refusalLimit) transit(tx, taskId, 'refusedThrice')
    }
  }
  if (event.kind !== 'turn' || event.status === 'running' || event.status === 'waiting') return
  if (event.status === 'failed') return void transit(tx, taskId, 'sessionFailed')
  if (event.status === 'cancelled') return void transit(tx, taskId, 'turnInterrupted')
  const reason = task.attach?.sent ? handbackReason(reply) : undefined
  if (reason !== undefined) return handback(tx, task, reason)
  if (task.attach?.sent) tx.store.putTask({ ...task, attach: null })
  if (task.prFailed) return void transit(tx, taskId, 'prFailed', { note: task.prFailed })
  if (task.question && task.question.generation === task.generation) return void asked(tx, task.id)
  transit(tx, taskId, 'sessionCompleted', { note: reply.slice(0, 500), message: reply })
}

/**
 * The turn ended on a question the worker handed to ask_owner. The text is the companion's own fixed
 * sentence, so the judge can read it; the question and options are the worker's words and ride as
 * detail, which only the owner sees.
 * @param {import('./tasks.mjs').Tx} tx @param {string} taskId
 */
function asked(tx, taskId) {
  if (!transit(tx, taskId, 'sessionAsked')) return
  const task = getTask(tx, taskId)
  enqueueMessage(tx, {
    deliveryKey: `ask:${taskId}:${task.eventSeq}`,
    text: `${label(task)}：${TEXT.asked}`,
    detail: questionText(/** @type {import('./tasks.mjs').Question} */ (task.question)),
    taskIds: [taskId],
  })
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
  choiceCard(tx, mark.inbox, candidates, `${label(task)} 退回了一条消息，要接到哪里？`, entry?.handedBack ? 2 : 1, `原因：${reason.slice(0, 200)}`)
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
  // An unknown reading keeps the last known one as the baseline, so the next known reading adds only what is new.
  tx.store.putTask({ ...task, usage, reading: { tokens: reading.tokens ?? task.reading.tokens, cost: reading.cost ?? task.reading.cost } })
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
