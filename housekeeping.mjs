import { allTasks, enqueueMessage, TEXT, transit } from './tasks.mjs'

/**
 * Store upkeep (§4.3): delete disposed inbox entries and delivered messages after their retention,
 * compact the events of long-ended tasks into the task summary, expire old proposals, and warn
 * the owner once when the store passes the warning ratio. Returns the store ratio, which the judge
 * commit uses to refuse new tasks past the refusal ratio.
 * @param {import('./tasks.mjs').Tx} tx
 */
export function housekeeping(tx) {
  const now = Date.parse(tx.at)
  const old = (at, ttl) => at !== null && now - Date.parse(at) > ttl
  tx.store.transaction(() => {
    for (const { key, value } of tx.store.scan('inbox/'))
      if (value.disposition && old(value.disposedAt, tx.limits.inboxTtlMs)) tx.store.delete(key)
    for (const { key, value } of tx.store.scan('outbox/'))
      if (old(value.sentAt, tx.limits.outboxTtlMs)) tx.store.delete(key)
    for (const task of allTasks(tx)) {
      if (task.state === 'proposed' && old(task.createdAt, tx.limits.proposalTtlMs)) transit(tx, task.id, 'proposalExpired')
      if (task.endedAt && task.eventChunks > 0 && old(task.endedAt, tx.limits.compactAfterMs)) compact(tx, task)
    }
  })
  const { ratio } = tx.store.usage()
  tx.store.transaction(() => {
    const alerts = tx.store.get('alerts') ?? { storeWarned: false }
    const warn = ratio >= tx.limits.storeWarnRatio
    if (warn && !alerts.storeWarned) enqueueMessage(tx, { deliveryKey: `store:warn:${tx.at}`, text: TEXT.storeWarn })
    if (warn !== alerts.storeWarned) tx.store.set('alerts', { storeWarned: warn })
  })
  return ratio
}

/** @param {import('./tasks.mjs').Tx} tx @param {import('./tasks.mjs').Task} task */
function compact(tx, task) {
  const events = tx.store.readEvents(task.id)
  const before = task.compacted ?? { events: 0, firstAt: null, lastAt: null }
  tx.store.dropEvents(task.id)
  const fresh = tx.store.getTask(task.id)
  tx.store.putTask({
    ...fresh,
    compacted: {
      events: before.events + events.length,
      firstAt: before.firstAt ?? events[0]?.at ?? null,
      lastAt: events.at(-1)?.at ?? before.lastAt,
    },
  })
}
