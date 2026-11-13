/**
 * Inbound signals and the inbox. The channel port parses its events into InboundSignal and states
 * the origin itself (owner identity is checked by the channel, C4); nothing here infers authority
 * from text.
 *
 * @typedef {'owner' | 'material' | 'stranger'} Origin  material = content that is not the owner's words
 * @typedef {{ source: string, eventId: string, at: string, origin: Origin, hops?: number, receiptId?: string, authority?: any }} SignalBase
 * @typedef {SignalBase & { kind: 'message', text: string, replyTo?: string, candidates?: string[] }} MessageSignal
 *   replyTo = the task whose message the owner replied to, as the channel matched it; candidates = the
 *   tasks of a message about several tasks the owner replied to, the only ones the judge may pick
 * @typedef {SignalBase & { kind: 'button', action: 'confirm' | 'refuse' | 'continue' | 'stop', taskId: string }} ButtonSignal
 * @typedef {SignalBase & { kind: 'choice', card: string, pick: string }} ChoiceSignal  pick = a task id or 'new'
 * @typedef {MessageSignal | ButtonSignal | ChoiceSignal} InboundSignal
 * @typedef {'created' | 'appended' | 'answered' | 'asked' | 'control' | 'rejected' | 'ignored' | 'fallback' | 'returned'} DispositionKind
 * @typedef {{ kind: DispositionKind, taskIds: string[], reason?: string, notes?: string[] }} Disposition  notes = why judge decisions about it were dropped
 * @typedef {{
 *   key: string, signal: InboundSignal, receivedAt: string,
 *   disposition: Disposition | null, disposedAt: string | null, handedBack: boolean, newFrom: string | null,
 * }} InboxEntry  newFrom = the message the owner chose to make a new task from, on a choice card
 * @typedef {{ kind: 'reject', reason: string } | { kind: 'status' }
 *   | { kind: 'command', event: 'ownerStop' | 'ownerContinue' | 'ownerConfirm' | 'ownerRefuse', taskId: string }
 *   | { kind: 'reply', taskId: string } | { kind: 'attach', taskId: string } | { kind: 'choice' } | { kind: 'batch' }} Route
 */

const TASK_ID = /T-\d{4,}/g
const BUTTON_EVENTS = { confirm: 'ownerConfirm', refuse: 'ownerRefuse', continue: 'ownerContinue', stop: 'ownerStop' }
const COMMANDS = [
  { pattern: /^\s*(?:状态|status)\s*$/i, kind: 'status' },
  { pattern: /^\s*(?:停掉|停止|stop)\s*#?(T-\d{4,})\s*$/i, event: 'ownerStop' },
  { pattern: /^\s*(?:继续|continue)\s*#?(T-\d{4,})\s*$/i, event: 'ownerContinue' },
]

const text = (value, max = 8192) => typeof value === 'string' && value.length <= max
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const taskList = (value) => Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((id) => text(id, 64))

/** Parses one inbound signal at the port boundary. @param {unknown} value @returns {{ ok: true, signal: InboundSignal, key: string } | { ok: false, error: string }} */
export function parseSignal(value) {
  if (!isObject(value)) return { ok: false, error: 'signal is not an object' }
  const { kind, source, eventId, at, origin } = /** @type {Record<string, unknown>} */ (value)
  if (!text(source, 64) || !source || !text(eventId, 128) || !eventId) return { ok: false, error: 'source and eventId are required' }
  if (!text(at, 64) || Number.isNaN(Date.parse(/** @type {string} */ (at)))) return { ok: false, error: 'at is not a time' }
  if (origin !== 'owner' && origin !== 'material' && origin !== 'stranger') return { ok: false, error: 'origin is unknown' }
  const hops = /** @type {Record<string, unknown>} */ (value).hops
  if (hops !== undefined && !(Number.isSafeInteger(hops) && /** @type {number} */ (hops) >= 0)) return { ok: false, error: 'hops is invalid' }
  const v = /** @type {Record<string, unknown>} */ (value)
  if (v.receiptId !== undefined && (!text(v.receiptId, 256) || !v.receiptId)) return { ok: false, error: 'receiptId is invalid' }
  const ok = kind === 'message'
    ? text(v.text) && (v.replyTo === undefined || text(v.replyTo, 64)) && (v.candidates === undefined || taskList(v.candidates))
    : kind === 'button'
      ? Object.hasOwn(BUTTON_EVENTS, /** @type {string} */ (v.action)) && text(v.taskId, 64)
      : kind === 'choice' && text(v.card, 200) && text(v.pick, 64)
  if (!ok) return { ok: false, error: `signal fields do not match kind ${String(kind)}` }
  // The field caps keep the key under the Host's 256-character limit.
  return { ok: true, signal: /** @type {InboundSignal} */ (structuredClone(value)), key: `inbox/${source}:${eventId}` }
}

/** Task ids written in a message that name existing tasks. @param {string} body @param {(id: string) => boolean} exists */
export function mentionedTasks(body, exists) {
  return [...new Set(body.match(TASK_ID) ?? [])].filter(exists)
}

/**
 * The split before the judge: replies, task ids, PR links, buttons, choices and control commands
 * are handled by code; the rest goes to the judge batch.
 * @param {InboundSignal} signal
 * @param {{ exists: (id: string) => boolean, byPrUrl: (body: string) => string | undefined,
 *   asking: () => { id: string, options: readonly string[] }[] }} tasks  asking = the tasks waiting on their own ask_owner question
 * @returns {Route}
 */
export function route(signal, tasks) {
  if (signal.origin === 'stranger') return { kind: 'reject', reason: 'not from the owner' }
  if (signal.kind === 'choice') return signal.origin === 'owner' ? { kind: 'choice' } : { kind: 'reject', reason: 'not from the owner' }
  if (signal.kind === 'button') {
    if (signal.origin !== 'owner') return { kind: 'reject', reason: 'not from the owner' }
    return { kind: 'command', event: /** @type {any} */ (BUTTON_EVENTS[signal.action]), taskId: signal.taskId }
  }
  if (signal.origin !== 'owner') return { kind: 'batch' }
  if (signal.replyTo && tasks.exists(signal.replyTo)) return { kind: 'reply', taskId: signal.replyTo }
  for (const command of COMMANDS) {
    const match = signal.text.match(command.pattern)
    if (!match) continue
    if (command.kind === 'status') return { kind: 'status' }
    if (tasks.exists(match[1])) return { kind: 'command', event: /** @type {any} */ (command.event), taskId: match[1] }
  }
  // A reply to a card about several tasks attaches only to a task on that card.
  const onCard = (id) => !signal.candidates || signal.candidates.includes(id)
  const ids = mentionedTasks(signal.text, tasks.exists)
  if (ids.length === 1 && onCard(ids[0])) return { kind: 'attach', taskId: ids[0] }
  const linked = ids.length ? undefined : tasks.byPrUrl(signal.text)
  if (linked && onCard(linked)) return { kind: 'attach', taskId: linked }
  // One waiting question is not enough to claim a message: it must be the answer itself.
  if (!signal.candidates) {
    const asking = tasks.asking()
    if (asking.length === 1 && isAnswer(signal.text, asking[0].options)) return { kind: 'attach', taskId: asking[0].id }
  }
  return { kind: 'batch' }
}

// The only decorations an answer may carry: a leading 选, a trailing . or 。.
const NUMBERED = /^选?\s*([1-9]\d?)\s*[.。]?$/

/**
 * Whether a message is an explicit answer to a question with these options: one option number in
 * range, or an option's own text. Anything else is left to the judge.
 * @param {string} body @param {readonly string[]} options
 */
export function isAnswer(body, options) {
  const said = body.trim()
  const number = Number(said.match(NUMBERED)?.[1])
  return (number >= 1 && number <= options.length) || options.includes(said)
}

const wordIn = (body, word) =>
  new RegExp(`(^|[^a-z0-9-])${word.replace(/[-]/g, '\\-')}($|[^a-z0-9-])`, 'i').test(body)

/**
 * §4.19 workspace name check: a message that names another authorized workspace and not the task's
 * own is not sent into the session.
 * @param {string} body @param {string} own @param {readonly string[]} workspaces
 */
export function namesOtherWorkspace(body, own, workspaces) {
  return !wordIn(body, own) && workspaces.some((name) => name !== own && wordIn(body, name))
}

/** The worker's one-line return of an attached message. @param {string} reply */
export function handbackReason(reply) {
  const first = reply.trimStart().split('\n', 1)[0] ?? ''
  const match = first.match(/^退回[：:]\s*(.*)$/)
  return match ? match[1].trim() || '未写原因' : undefined
}
