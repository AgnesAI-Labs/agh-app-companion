import { recentConversation, snapshot } from './context.mjs'
import { deliverOutbox, runSessionOps } from './effects.mjs'
import { housekeeping } from './housekeeping.mjs'
import { filterDecisions, judgeInput, parseJudgeOutput } from './judge.mjs'
import { LIMITS } from './limits.mjs'
import { SessionRefusal } from './platform-sessions.mjs'
import { reconcile } from './reconcile.mjs'
import { startRequest } from './sessions.mjs'
import { parseSignal, route } from './signals.mjs'
import {
  allTasks, choiceCard, createTask, dispose, enqueueMessage, forward, getTask, hash, label, noteRefusal, stateText,
  statusText, TEXT, transit,
} from './tasks.mjs'

/**
 * The task engine (§4.2): inbox, split, judge, permission filter, one commit per decision, then
 * effects by idempotency key. It keeps no state in memory: a new engine over the same store and
 * ports continues where a crashed one stopped.
 *
 * @typedef {{ failures: number, until: string }} JudgeBackoff
 * @typedef {{ keys: string[], attempt: number, startedAt: string }} JudgeBatch
 * @typedef {{
 *   store: import('./store.mjs').Store, sessions: import('./sessions.mjs').ManagedSessions,
 *   channel: import('./effects.mjs').Channel, settings: import('./settings.mjs').Settings,
 *   now?: () => string, limits?: import('./limits.mjs').Limits,
 * }} EngineDeps
 */

const MINUTE = 60 * 1000

/** @param {EngineDeps} deps */
export function createEngine({ store, sessions, channel, settings, now = () => new Date().toISOString(), limits = LIMITS }) {
  const workspaces = settings.workspaces.map((w) => w.shortName)
  /** @returns {import('./tasks.mjs').Tx} */
  const tx = () => ({ store, at: now(), limits, workspaces })
  /** @type {import('./effects.mjs').EffectDeps} */
  const effects = {
    tx,
    sessions,
    channel,
    workspacePath: (name) => settings.workspaces.find((w) => w.shortName === name)?.path,
  }
  const routing = {
    exists: (id) => store.getTask(id) !== undefined,
    byPrUrl: (body) => allTasks(tx()).find((t) => t.prUrl && body.includes(t.prUrl))?.id,
  }
  const pending = () => store.scan('inbox/').map((row) => row.value).filter((e) => e.disposition === null)

  /** Records a signal once; the channel acknowledges it only after this returns accepted. @param {unknown} raw */
  function receive(raw) {
    const parsed = parseSignal(raw)
    if (!parsed.ok) return /** @type {const} */ ({ kind: 'invalid', error: parsed.error })
    const t = tx()
    return t.store.transaction(() => {
      if (t.store.get(parsed.key)) return /** @type {const} */ ({ kind: 'duplicate', key: parsed.key })
      /** @type {import('./signals.mjs').InboxEntry} */
      const entry = { key: parsed.key, signal: parsed.signal, receivedAt: t.at, disposition: null, disposedAt: null, handedBack: false, newFrom: null }
      t.store.set(parsed.key, /** @type {any} */ (entry))
      return /** @type {const} */ ({ kind: 'accepted', key: parsed.key })
    })
  }

  /** Step 2: everything code can decide without the judge, one transaction per signal. */
  function triage() {
    const judging = new Set(store.get('judge/batch')?.keys ?? [])
    for (const entry of pending()) {
      if (judging.has(entry.key) || entry.newFrom) continue
      const r = route(entry.signal, routing)
      if (r.kind === 'batch') continue
      const t = tx()
      t.store.transaction(() => {
        const disposition = direct(t, entry, r)
        if (disposition) dispose(t, entry.key, disposition)
      })
    }
  }

  /** @param {import('./tasks.mjs').Tx} t @param {import('./signals.mjs').InboxEntry} entry @param {import('./signals.mjs').Route} r */
  function direct(t, entry, r) {
    switch (r.kind) {
      case 'reject':
        return { kind: 'rejected', taskIds: [], reason: r.reason }
      case 'status':
        enqueueMessage(t, { deliveryKey: `status:${entry.key}`, text: statusText(allTasks(t)), about: entry.key })
        return { kind: 'control', taskIds: [] }
      case 'command': {
        if (!transit(t, r.taskId, r.event, { about: entry.key })) {
          const task = getTask(t, r.taskId)
          enqueueMessage(t, { deliveryKey: `refused:${entry.key}`, text: `${label(task)} 现在${stateText(task)}，这个操作不适用。`, taskIds: [task.id], about: entry.key })
          return { kind: 'rejected', taskIds: [r.taskId], reason: `${r.event} does not apply` }
        }
        return { kind: 'control', taskIds: [r.taskId] }
      }
      case 'reply':
        return forward(t, r.taskId, entry, { unquoted: false, picked: false })
      case 'attach':
        return forward(t, r.taskId, entry, { unquoted: true, picked: false })
      case 'choice':
        return choose(t, entry)
      default:
        throw new Error(`unrouted signal ${entry.key}`)
    }
  }

  /** A click on a choice card: attach to the picked task, or send the message to the judge as new. */
  function choose(t, entry) {
    const signal = /** @type {import('./signals.mjs').ChoiceSignal} */ (entry.signal)
    const card = t.store.get(`outbox/${signal.card}`)
    const original = card?.about ? t.store.get(card.about) : undefined
    if (!card?.card || !original || card.chosen) return { kind: 'rejected', taskIds: [], reason: 'card is unknown or already chosen' }
    const options = card.card.options.map((o) => o.taskId)
    if (signal.pick !== 'new' && !options.includes(signal.pick)) return { kind: 'rejected', taskIds: [], reason: 'pick is not on the card' }
    t.store.set(`outbox/${signal.card}`, { ...card, chosen: signal.pick })
    if (signal.pick === 'new') {
      t.store.set(entry.key, { ...entry, newFrom: card.about })
      return null
    }
    dispose(t, original.key, forward(t, signal.pick, original, { unquoted: true, picked: true }))
    return { kind: 'control', taskIds: [signal.pick] }
  }

  /** Step 3 to 5: one batch through the judge, filtered, committed with its effects. */
  async function judge() {
    const backoff = store.get('judge/backoff')
    if (backoff && Date.parse(now()) < Date.parse(backoff.until)) return
    let batch = store.get('judge/batch')
    if (!batch) {
      const keys = pending()
        .filter((e) => e.newFrom || route(e.signal, routing).kind === 'batch')
        .map((e) => e.key)
      if (!keys.length) return
      batch = { keys, attempt: 0, startedAt: now() }
      store.set('judge/batch', batch)
    }
    const entries = batch.keys.map((key) => store.get(key)).filter(Boolean)
    const items = entries.map(batchItem)
    const views = new Map((await sessions.list()).map((row) => [row.sessionId, { kind: row.status.kind, flags: row.status.flags }]))
    for (;;) {
      const t = tx()
      const recent = recentConversation(t, new Set(batch.keys))
      const view = snapshot(t, views)
      let text
      try {
        const { sessionId } = await sessions.start(
          startRequest('judge', {
            workspace: settings.dedicatedWorkspace,
            input: judgeInput({ snapshot: view, recent, batch: items }),
            startKey: `judge:${hash(`${batch.startedAt}\n${batch.keys.join('\n')}`).slice(0, 24)}:${batch.attempt}`,
          }),
        )
        const result = await sessions.result(sessionId)
        if (!result.turn) return
        if (result.turn.status !== 'completed') return unavailable()
        text = result.text ?? ''
      } catch (error) {
        // Reading the result archives an ephemeral session, so a batch replayed after a crash needs a new key.
        if (error instanceof SessionRefusal && error.code === 'SESSION_ARCHIVED') {
          batch = { ...batch, attempt: batch.attempt + 1 }
          store.set('judge/batch', batch)
          continue
        }
        return unavailable(error instanceof SessionRefusal && !error.retryable ? error : undefined)
      }
      const parsed = parseJudgeOutput(text)
      if (!parsed.ok) {
        if (batch.attempt > 0) return unavailable()
        batch = { ...batch, attempt: batch.attempt + 1 }
        store.set('judge/batch', batch)
        continue
      }
      return commit(entries, items, parsed.decisions, recent, view)
    }
  }

  /** @param {import('./signals.mjs').InboxEntry} entry @returns {import('./judge.mjs').BatchItem} */
  function batchItem(entry) {
    if (entry.newFrom) {
      const original = store.get(entry.newFrom)
      return { id: entry.key, origin: 'owner', text: original?.signal.text ?? '', chosenNew: true }
    }
    const signal = /** @type {import('./signals.mjs').MessageSignal} */ (entry.signal)
    return {
      id: entry.key, origin: signal.origin === 'owner' ? 'owner' : 'material', text: signal.text,
      ...(signal.candidates ? { candidates: signal.candidates } : {}),
    }
  }

  /**
   * The judge could not answer. Its messages stay queued and the next try waits longer. A refusal
   * waiting cannot cure is told once (noteRefusal) instead of as the model being down.
   * @param {SessionRefusal} [refusal]
   */
  function unavailable(refusal) {
    const t = tx()
    t.store.transaction(() => {
      const failures = (t.store.get('judge/backoff')?.failures ?? 0) + 1
      const wait = Math.min(30, 2 ** (failures - 1)) * MINUTE
      t.store.set('judge/backoff', { failures, until: new Date(Date.parse(t.at) + wait).toISOString() })
      t.store.delete('judge/batch')
      if (refusal) noteRefusal(t, refusal, { role: 'judge', workspace: settings.dedicatedWorkspace, taskId: null, prefix: '你的消息还在排队，伴侣现在不能判断。' })
      else if (failures === limits.judgeFailuresNotify) enqueueMessage(t, { deliveryKey: `judge:down:${t.at}`, text: TEXT.judgeDown })
    })
  }

  function commit(entries, items, decisions, recent, view) {
    const t = tx()
    const byId = new Map(entries.map((e) => [e.key, e]))
    const textOf = new Map(items.map((i) => [i.id, i.text]))
    const filtered = filterDecisions(decisions, {
      batch: items,
      recent,
      links: new Set(view.tasks.map((task) => task.prUrl).filter(Boolean)),
      workspaces,
      taskExists: routing.exists,
      storeFull: store.usage().ratio >= limits.storeRefuseRatio,
      limits,
    })
    const notes = new Map()
    for (const { decision, reason } of filtered.rejected) {
      const ids = decision.kind === 'create' ? decision.messages : decision.kind === 'suggest' ? decision.evidence : [decision.message]
      for (const id of ids) notes.set(id, [...(notes.get(id) ?? []), `${decision.kind}: ${reason}`])
    }
    t.store.transaction(() => {
      const outcome = new Map()
      for (const d of filtered.accepted) {
        if (d.kind === 'create') {
          const task = createTask(t, {
            title: d.title,
            workspace: d.workspace,
            inbox: d.messages,
            brief: d.messages.map((id) => textOf.get(id)).join('\n\n'),
            hops: Math.max(0, ...d.messages.map((id) => byId.get(id)?.signal.hops ?? 0)),
          })
          for (const id of d.messages) outcome.set(id, { kind: 'created', taskIds: [task.id] })
          enqueueMessage(t, { deliveryKey: `ack:${d.messages[0]}`, text: `已新建 ${label(task)}：${stateText(task)}`, taskIds: [task.id], about: d.messages[0] })
        } else if (d.kind === 'append') {
          const entry = byId.get(d.message)
          outcome.set(d.message, forward(t, d.taskId, { ...entry, signal: { ...entry.signal, text: textOf.get(d.message) } }, { unquoted: true, picked: false }))
        } else if (d.kind === 'ask') {
          choiceCard(t, d.message, d.candidates.map((id) => getTask(t, id)), TEXT.which)
          outcome.set(d.message, { kind: 'asked', taskIds: d.candidates })
        } else if (d.kind === 'answer') {
          enqueueMessage(t, { deliveryKey: `answer:${d.message}`, text: d.text, about: d.message })
          if (!outcome.has(d.message)) outcome.set(d.message, { kind: 'answered', taskIds: [] })
        } else if (d.kind === 'ignore') {
          outcome.set(d.message, { kind: 'ignored', taskIds: [] })
        }
      }
      for (const id of filtered.storeFull) {
        enqueueMessage(t, { deliveryKey: `full:${id}`, text: TEXT.storeFull, about: id })
        outcome.set(id, { kind: 'rejected', taskIds: [], reason: 'store is full' })
      }
      for (const id of filtered.fallbacks) {
        const onCard = (items.find((i) => i.id === id)?.candidates ?? []).filter(routing.exists)
        if (onCard.length) {
          choiceCard(t, id, onCard.map((taskId) => getTask(t, taskId)), TEXT.whichOnCard)
          outcome.set(id, { kind: 'asked', taskIds: onCard.slice(0, limits.candidateMax) })
          continue
        }
        enqueueMessage(t, { deliveryKey: `fallback:${id}`, text: TEXT.fallback, about: id })
        outcome.set(id, { kind: 'fallback', taskIds: [] })
      }
      for (const entry of entries) {
        const result = outcome.get(entry.key) ?? { kind: 'ignored', taskIds: [] }
        dispose(t, entry.key, notes.has(entry.key) ? { ...result, notes: notes.get(entry.key) } : result)
      }
      t.store.delete('judge/batch')
      t.store.delete('judge/backoff')
      for (const { key } of t.store.scan('refusal/judge:')) t.store.delete(key)
    })
  }

  return Object.freeze({
    receive,
    /** Session facts into the table, as at the start of a tick; the service runs it once at start. */
    reconcile: () => reconcile(effects),
    /** One pass of the engine; each step resumes from the store. */
    async tick() {
      triage()
      await judge()
      // Session facts first, so a message waiting for an idle session sees the finished turn's state.
      await reconcile(effects)
      await runSessionOps(effects)
      await reconcile(effects)
      await runSessionOps(effects)
      await deliverOutbox(effects)
      housekeeping(tx())
    },
  })
}
