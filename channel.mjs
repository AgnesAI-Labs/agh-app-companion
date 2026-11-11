import { ChannelRefusal } from './channel-targets.mjs'
import { parseChannelEvent } from './channel-contract.mjs'

/**
 * The chat channel adapter: the engine's `Channel` port outbound, InboundSignal inbound. Authority
 * comes only from the platform's pairing: an event counts when its pairing id, chat and sender are
 * the pairing the channel opened on (A2, A3). Every receive and send re-reads the pairing and
 * refuses unless it is still that one and its channel runs: outbox rows do not record whom they were
 * written for, so after a re-pair to another owner none may go to anyone until the service restarts.
 * An unpair that is undone for the same owner resumes by itself.
 *
 * @typedef {import('./channel-contract.mjs').ChannelEvent} ChannelEvent
 * @typedef {import('./channel-contract.mjs').ChannelGateway} ChannelGateway
 * @typedef {import('./channel-contract.mjs').Pairing} Pairing
 * @typedef {import('./tasks.mjs').OutboxEntry} OutboxEntry
 * @typedef {{ kind: 'accepted' | 'duplicate', key: string } | { kind: 'dropped', reason: string } | { kind: 'invalid', error: string }} ReceiveResult
 *   every result is final: the platform does not redeliver an event once `receive` returns
 * @typedef {import('./effects.mjs').Channel & {
 *   receive(raw: unknown): Promise<ReceiveResult>, refresh(): Promise<void>, status(): string | null,
 *   owner: import('./store.mjs').ChannelOwner,
 * }} ChatChannel
 *   status is why the channel cannot serve the owner right now, or null; owner is the pairing's owner at open
 */

/** Titles are fixed text, so a message about no task still reads as the companion's (A9). */
export const CHANNEL_TITLES = Object.freeze({ message: '伴侣：有新消息', choice: '伴侣：有件事请你选' })
const NEW_TASK_LABEL = '新建任务'
export const CHOICE_POINTER = '请到 AGH 的「伴侣」页选择，或直接回复你的意思。'
const MAX_CANDIDATES = 32

export const STATUS = Object.freeze({
  notPaired: 'the companion is not paired with a chat; pair it from the AGH channel page',
  notRunning: 'the channel the companion is paired with is not running',
  rebound: 'the pairing was rebound to another owner; restart the companion service to serve the new owner',
  unconfirmed: 'the chat only accepts the companion\'s messages after the owner sends one first (TARGET_UNCONFIRMED)',
})

/**
 * A quote of one task's message names that task. A quote of a message about several tasks, or of a
 * choice list (whose question a typed answer belongs to, not the worker), limits the judge to them.
 */
function quoted(event, outboxByMessage) {
  const row = event.quotedMessageId ? outboxByMessage(event.quotedMessageId) : undefined
  if (!row || row.taskIds.length === 0) return {}
  if (row.taskIds.length === 1 && !row.card) return { replyTo: row.taskIds[0] }
  return { candidates: row.taskIds.slice(0, MAX_CANDIDATES) }
}

/** Shortens `value` to at most `max` UTF-16 units, never splitting a surrogate pair. @param {string} value @param {number} max */
function clip(value, max) {
  if (value.length <= max) return value
  if (max <= 1) return max === 1 ? '…' : ''
  let end = max - 1
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${value.slice(0, end)}…`
}

/**
 * The one platform message for an outbound: a fixed title line, then the body. A choice question is
 * a numbered list with the pointer to the AGH page (A6). The body is cut first so the list and the
 * pointer survive; the result never exceeds `textChars`, so the platform cannot answer TOO_LARGE.
 * @param {import('./effects.mjs').Outbound} message @param {number} textChars
 */
export function render(message, textChars) {
  const body = message.detail ? `${message.text}\n\n${message.detail}` : message.text
  const head = `${message.card ? CHANNEL_TITLES.choice : CHANNEL_TITLES.message}\n\n`
  const tail = message.card
    ? `\n\n${[...message.card.options.map((o) => o.title), ...(message.card.allowNew ? [NEW_TASK_LABEL] : [])].map((t, i) => `${i + 1}. ${t}`).join('\n')}\n${CHOICE_POINTER}`
    : ''
  const room = textChars - head.length - tail.length
  return room >= 1 ? head + clip(body, room) + tail : clip(head + body + tail, textChars)
}

/**
 * Opens the adapter on the service's current pairing, or refuses with the status to show the owner.
 * @param {{
 *   gateway: ChannelGateway, store: import('./store.mjs').Store,
 *   receive: (signal: unknown) => { kind: string, key?: string, error?: string } | Promise<{ kind: string, key?: string, error?: string }>,
 * }} deps receive = the engine's `receive`
 * @returns {Promise<{ ok: true, channel: ChatChannel } | { ok: false, status: string }>}
 */
export async function openChannel({ gateway, store, receive }) {
  /** @type {Pairing | undefined} */
  let opened
  try {
    opened = await gateway.pairing()
  } catch (error) {
    return { ok: false, status: `the pairing could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!opened) return { ok: false, status: STATUS.notPaired }
  if (!opened.running) return { ok: false, status: STATUS.notRunning }
  const bound = opened
  /** @type {string | null} */
  let status = null
  let unconfirmed = false

  /** @returns {Promise<Pairing | null>} the pairing when it is the one opened and runs; otherwise sets `status` and returns null */
  const check = async () => {
    let now
    try {
      now = await gateway.pairing()
    } catch (error) {
      status = `the pairing could not be read: ${error instanceof Error ? error.message : String(error)}`
      return null
    }
    if (!now) status = STATUS.notPaired
    else if (now.id !== bound.id || now.userId !== bound.userId || now.chatId !== bound.chatId || now.instanceId !== bound.instanceId) status = STATUS.rebound
    else if (!now.running) status = STATUS.notRunning
    else {
      status = null
      return now
    }
    return null
  }
  /** @param {string} messageId @returns {OutboxEntry | undefined} */
  const outboxByMessage = (messageId) => store.scan('outbox/').find((row) => row.value.messageId === messageId)?.value

  /** @type {ChatChannel} */
  const channel = {
    async receive(raw) {
      const parsed = parseChannelEvent(raw)
      if (!parsed.ok) return { kind: 'invalid', error: parsed.error }
      const event = parsed.event
      const pairing = await check()
      if (!pairing) return { kind: 'dropped', reason: /** @type {string} */ (status) }
      // Strangers stop here, before the inbox, so their volume cannot fill the store.
      if (event.pairingId !== pairing.id || event.chat.id !== pairing.chatId || event.sender.userId !== pairing.userId) return { kind: 'dropped', reason: 'not from the owner' }
      if (!event.text.trim()) return { kind: 'dropped', reason: 'message has no text' }
      const result = await receive({
        source: `channel:${bound.instanceId}`, eventId: event.eventId, at: event.at, origin: 'owner',
        kind: 'message', text: event.text, ...quoted(event, outboxByMessage),
      })
      if (result.kind === 'accepted' || result.kind === 'duplicate') {
        // The owner just wrote, so the chat platform now accepts sends to this chat again.
        unconfirmed = false
        return { kind: result.kind, key: /** @type {string} */ (result.key) }
      }
      return { kind: 'invalid', error: result.error ?? 'refused by the engine' }
    },

    // Asks the ledger before every send, so a redelivery after a crash never sends twice even when
    // the chat platform has no idempotency key of its own. A key left `unknown` is sent again with
    // the same key (A8).
    async deliver(message) {
      const key = message.deliveryKey
      const pairing = await check()
      if (!pairing) throw new Error(/** @type {string} */ (status))
      const before = await gateway.delivery(pairing.id, key)
      if (before.state === 'delivered') return { messageId: before.messageId }
      if (before.state === 'pending') throw new Error(`delivery ${key} is still pending at the channel`)
      try {
        const sent = await gateway.send(pairing.id, { deliveryKey: key, text: render(message, pairing.textChars) })
        unconfirmed = false
        return sent
      } catch (error) {
        if (error instanceof ChannelRefusal) {
          if (error.code === 'NOT_PAIRED') status = STATUS.notPaired
          else if (error.code === 'CHANNEL_UNAVAILABLE') status = STATUS.notRunning
          else if (error.code === 'TARGET_UNCONFIRMED') unconfirmed = true
        }
        const after = await gateway.delivery(pairing.id, key).catch(() => undefined)
        if (after?.state === 'delivered') return { messageId: after.messageId }
        throw error
      }
    },

    async refresh() {
      await check()
    },

    status: () => status ?? (unconfirmed ? STATUS.unconfirmed : null),

    owner: Object.freeze({ instanceId: bound.instanceId, userId: bound.userId }),
  }
  return { ok: true, channel: Object.freeze(channel) }
}
