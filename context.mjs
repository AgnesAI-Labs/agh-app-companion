import { UNFINISHED } from './machine.mjs'
import { allTasks, isAsking } from './tasks.mjs'

/**
 * What each judge batch sees besides the batch itself (§4.19). Both hold only fields the service
 * code wrote; worker output never enters them.
 *
 * @typedef {{ kind: string, flags: string[] } | null} SessionView
 * @typedef {{
 *   workspaces: string[],
 *   tasks: { id: string, title: string, workspace: string, state: string, reason: string | null,
 *     createdAt: string, updatedAt: string, prUrl: string | null, session: SessionView, asking?: true,
 *     usage: { tokens: number | null, cost: number | null } }[],
 *   omitted: number, counts: Record<string, number>,
 *   today: { tokens: number, cost: number, unknown: boolean, costCap: number | null },
 * }} Snapshot
 * @typedef {{ id: string, at: string, who: 'owner' | 'companion', text: string, taskIds: string[] }} RecentItem
 */

const day = (at) => at.slice(0, 10)

/** @param {import('./tasks.mjs').Tx} tx @param {Map<string, SessionView>} sessions sessionId to status */
export function snapshot(tx, sessions) {
  const now = Date.parse(tx.at)
  const all = allTasks(tx)
  const counts = {}
  for (const task of all) counts[task.state] = (counts[task.state] ?? 0) + 1
  const listed = all
    .filter((t) => UNFINISHED.includes(t.state) || now - Date.parse(t.endedAt) <= tx.limits.snapshotEndedMs)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  const shown = listed.slice(0, tx.limits.snapshotTasks)
  const usage = tx.store.get(`usage/${day(tx.at)}`) ?? { tokens: 0, cost: 0, unknown: false }
  return /** @type {Snapshot} */ ({
    workspaces: [...tx.workspaces],
    tasks: shown.map((t) => ({
      id: t.id, title: t.title, workspace: t.workspace, state: t.state, reason: t.reason,
      createdAt: t.createdAt, updatedAt: t.updatedAt, prUrl: t.prUrl,
      session: t.sessionId ? (sessions.get(t.sessionId) ?? null) : null, usage: t.usage,
      ...(isAsking(t) ? { asking: true } : {}),
    })),
    omitted: listed.length - shown.length,
    counts,
    today: { ...usage, costCap: tx.limits.dailyCost },
  })
}

/**
 * The owner's last messages and the companion's messages from the window, oldest first, excluding
 * the batch being judged. A message's detail (worker output) is never read here.
 * @param {import('./tasks.mjs').Tx} tx @param {ReadonlySet<string>} batch inbox keys
 * @returns {RecentItem[]}
 */
export function recentConversation(tx, batch) {
  const since = Date.parse(tx.at) - tx.limits.recentWindowMs
  const owner = tx.store
    .scan('inbox/')
    .map((row) => row.value)
    .filter((e) => !batch.has(e.key) && e.signal.kind === 'message' && e.signal.origin === 'owner' && Date.parse(e.signal.at) >= since)
    .sort((a, b) => (a.signal.at < b.signal.at ? -1 : 1))
    .slice(-tx.limits.recentMessages)
    .map((e) => ({ id: e.key, at: e.signal.at, who: 'owner', text: e.signal.text, taskIds: e.disposition?.taskIds ?? [] }))
  const companion = tx.store
    .scan('outbox/')
    .map((row) => row.value)
    .filter((m) => Date.parse(m.at) >= since)
    .map((m) => ({
      id: `outbox/${m.deliveryKey}`,
      at: m.at,
      who: 'companion',
      text: m.text,
      taskIds: m.taskIds,
    }))
  return /** @type {RecentItem[]} */ ([...owner, ...companion].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)))
}
