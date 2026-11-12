import { SLOT_STATES } from './machine.mjs'
import { SessionRefusal, START_ATTEMPTS } from './platform-sessions.mjs'
import { startRequest } from './sessions.mjs'
import { ChannelRefusal } from './channel-targets.mjs'
import { enqueueMessage, getTask, hash, parkRefused, TEXT, transit } from './tasks.mjs'

/**
 * Runs committed effects. Each carries its idempotency key (start: `taskId:generation`, send:
 * `taskId:eventSeq`, message: deliveryKey), so replaying one after a crash between the call and its
 * mark is absorbed by the platform or the channel.
 *
 * @typedef {{ deliveryKey: string, text: string, detail: string | null, card: import('./tasks.mjs').ChoiceCard | null, ask?: import('./tasks.mjs').AskMark | null }} Outbound
 * @typedef {{ deliver(message: Outbound): Promise<{ messageId: string }>, replyBudget?(): Promise<number>, prepareReply?(text: string): Promise<string | undefined>, watchSession?(sessionId: string): Promise<void>, refresh?(): Promise<void> }} Channel
 *   the IM channel port; it must drop a repeated deliveryKey (IM channel plan)
 * @typedef {{
 *   tx: () => import('./tasks.mjs').Tx, sessions: import('./sessions.mjs').ManagedSessions, channel: Channel,
 *   workspacePath: (shortName: string) => string | undefined,
 * }} EffectDeps
 */

/** @param {EffectDeps} deps */
export async function runSessionOps(deps) {
  const blocked = new Set()
  for (const { key, value: op } of deps.tx().store.scan('op/')) {
    // A new-generation start must not wait behind the sends it unblocks.
    if (blocked.has(op.taskId) && op.kind !== 'start') continue
    const tx = deps.tx()
    const task = tx.store.getTask(op.taskId)
    const drop = () => deps.tx().store.delete(key)
    if (!task || (op.kind !== 'interrupt' && (task.state === 'abandoned' || task.state === 'expired'))) {
      drop()
      continue
    }
    if (op.kind === 'interrupt') {
      try {
        if (task.sessionId) await deps.sessions.interrupt(task.sessionId)
      } catch {
        // The task already shows the stop; the op stays and is tried again next pass without holding up the others.
        blocked.add(op.taskId)
        continue
      }
      drop()
      continue
    }
    if (op.kind === 'send' && op.inbox && (task.state === 'done' || task.state === 'failed'))
      tx.store.transaction(() => {
        // The session finished before this message reached it, so the message reopens the task.
        if (task.attach?.inbox === op.inbox) tx.store.putTask({ ...task, attach: { ...task.attach, prior: { state: task.state, reason: task.reason } } })
        transit(tx, task.id, 'ownerMessage')
      })
    const current = getTask(deps.tx(), op.taskId)
    if (!SLOT_STATES.includes(current.state)) {
      blocked.add(op.taskId)
      continue
    }
    if (op.kind === 'start') {
      if (op.generation !== current.generation) {
        drop()
        continue
      }
      const workspace = deps.workspacePath(current.workspace)
      if (!workspace) {
        blocked.add(op.taskId)
        continue
      }
      let sessionId
      try {
        ;({ sessionId } = await deps.sessions.start(
          startRequest('worker', { workspace, input: op.input, startKey: `${op.taskId}:${op.generation}` }),
        ))
      } catch (error) {
        blocked.add(op.taskId)
        if (error instanceof SessionRefusal) {
          if (!error.retryable) park(deps, op.taskId, error, workspace, key)
          continue
        }
        // The count lives on the op, so it survives a restart and ends with the generation's op.
        const failures = (op.failures ?? 0) + 1
        if (failures >= START_ATTEMPTS) park(deps, op.taskId, new SessionRefusal('START_FAILED', shortError(error)), workspace, key)
        else deps.tx().store.set(key, { ...op, failures })
        continue
      }
      await deps.channel.watchSession?.(sessionId).catch(() => {})
      const done = deps.tx()
      done.store.transaction(() => {
        done.store.putTask({ ...getTask(done, op.taskId), sessionId, cursor: 0, reading: { tokens: null, cost: null } })
        done.store.delete(key)
      })
      continue
    }
    if (!current.sessionId) {
      blocked.add(op.taskId)
      continue
    }
    let result
    try {
      result = await deps.sessions.send(current.sessionId, { text: op.input, idempotencyKey: op.key })
    } catch (error) {
      blocked.add(op.taskId)
      // The owner's message stays queued and goes in once the owner continues the task.
      if (error instanceof SessionRefusal && !error.retryable) park(deps, op.taskId, error, deps.workspacePath(current.workspace) ?? current.workspace, null)
      continue
    }
    const after = deps.tx()
    after.store.transaction(() => {
      if (result.state === 'started' || result.reason === 'duplicateKey') {
        const sent = getTask(after, op.taskId)
        if (sent.attach && sent.attach.inbox === op.inbox) after.store.putTask({ ...sent, attach: { ...sent.attach, sent: true } })
        return after.store.delete(key)
      }
      blocked.add(op.taskId)
      if (result.reason === 'archived') return transit(after, op.taskId, 'sessionLost')
      if (op.inbox && !op.busyNoticed) {
        enqueueMessage(after, { deliveryKey: `busy:${op.key}`, text: TEXT.busy, taskIds: [op.taskId], about: op.inbox })
        after.store.set(key, { ...op, busyNoticed: true })
      }
    })
  }
}

/** First line of an unknown start error, short enough for an owner notice. @param {unknown} error */
function shortError(error) {
  const line = (error instanceof Error ? error.message : String(error)).split('\n', 1)[0]?.trim() ?? ''
  return line ? ([...line].length > 120 ? `${[...line].slice(0, 120).join('')}…` : line) : null
}

/**
 * Parks a task on a refusal waiting cannot cure; a refused start's op goes with it, since continuing
 * opens a new generation.
 * @param {EffectDeps} deps @param {string} taskId @param {SessionRefusal} refusal @param {string} workspace @param {string | null} startOp
 */
function park(deps, taskId, refusal, workspace, startOp) {
  const tx = deps.tx()
  tx.store.transaction(() => {
    if (startOp) tx.store.delete(startOp)
    parkRefused(tx, taskId, refusal, workspace)
  })
}

/** Hands undelivered messages to the channel in the order they were committed. @param {EffectDeps} deps */
export async function deliverOutbox(deps) {
  const pending = deps
    .tx()
    .store.scan('outbox/')
    .filter((row) => row.value.sentAt === null && row.value.replyDelivery !== 'blocked')
    .sort((a, b) => (a.value.at < b.value.at ? -1 : a.value.at > b.value.at ? 1 : 0))
  for (const { key, value: stored } of pending) {
    let value = stored
    let receipt
    try {
      if (value.replyDelivery === 'unprepared') {
        const prepared = await deps.channel.prepareReply?.(value.text)
        if (prepared !== undefined) {
          value = { ...value, text: prepared, replyDelivery: 'prepared' }
          // Freeze the actual payload before a call can have an uncertain external result.
          deps.tx().store.set(key, value)
        }
      }
      receipt = await deps.channel.deliver({ deliveryKey: value.deliveryKey, text: value.text, detail: value.detail, card: value.card, ask: value.ask ?? null })
    } catch (error) {
      if (value.deliveryKey.startsWith('answer:') && error instanceof ChannelRefusal && error.code === 'TOO_LARGE') {
        const tx = deps.tx()
        tx.store.transaction(() => {
          tx.store.set(key, { ...value, replyDelivery: 'blocked' })
          enqueueMessage(tx, {
            deliveryKey: `reply-budget:${hash(value.deliveryKey)}`,
            text: '这次回复的投递结果未确认，当前渠道容量又不足，无法安全重发。其他消息仍会继续处理。',
            ...(value.about ? { about: value.about } : {}),
          })
        })
        continue
      }
      return
    }
    const tx = deps.tx()
    tx.store.set(key, { ...value, sentAt: tx.at, messageId: receipt.messageId })
  }
}
