import { ChannelRefusal } from './channel-targets.mjs'
import { parseChannelEvent } from './channel-contract.mjs'
import { answerRejection, isAsking } from './tasks.mjs'

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
 *   accepted/duplicate confirms durable ingress; the service throws for an unconfirmed Host receipt
 * @typedef {import('./effects.mjs').Channel & {
 *   replyBudget(): Promise<number>,
 *   prepareReply(text: string): Promise<string>,
 *   watchSession(sessionId: string): Promise<void>,
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

const LABEL_MAX = 40
const MAX_ACTIONS = 6
const ACTION_ID = /^[A-Za-z0-9:_-]{1,64}$/
const BUTTON_POINTER = '点按钮选择，或直接回复你的意思。'
const LINK_LEFTOVER = /\]([(\[:])/g
const LINK = /!?\[([^\[\]\n]*)\]\(\s*<?((?:[^()\s<>]|\([^()\s<>]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g

/**
 * Worker-written content can carry Markdown that hides where a link goes, and the chat renders it.
 * Each `[text](url)` becomes `text（url）` so the owner sees the real address.
 * Forms the pattern misses (an escaped bracket in the label, a reference link and its definition) are
 * defused by a zero-width space after the `]`, so no channel can render them as a link.
 * @param {string} value
 */
export function showLinks(value) {
  return value
    .replace(LINK, (_, label, url) => (!label.trim() || label.trim() === url ? url : `${label}（${url}）`))
    .replace(LINK_LEFTOVER, ']​$1')
}

const oneLine = (value, max) => clip(value.replace(/\s+/g, ' ').trim(), max)

/** The buttons a message offers, or null when it has none or they would not fit one card. @param {import('./effects.mjs').Outbound} message @returns {import('./channel-contract.mjs').ChannelAction[] | null} */
function buttons(message) {
  const items = message.card
    ? [
        ...message.card.options.map((o) => ({ id: `pick:${o.taskId}`, label: oneLine(`${o.taskId} ${o.title}`, LABEL_MAX) })),
        ...(message.card.allowNew ? [{ id: 'pick:new', label: NEW_TASK_LABEL }] : []),
      ]
    : (message.ask?.options ?? []).map((option, i) => ({ id: `answer:${i + 1}`, label: oneLine(option, LABEL_MAX) }))
  const fits = items.length >= 1 && items.length <= MAX_ACTIONS && items.every((item) => item.label && ACTION_ID.test(item.id))
  return fits ? items : null
}

/**
 * The platform send for an outbound: a fixed title, the body, and one button per option of a choice
 * card or a worker question (A6). The text never exceeds `textChars`, and the body is cut first so
 * the tail survives, so the platform cannot answer TOO_LARGE. A card the buttons cannot carry falls
 * back to a numbered list that points to the AGH page. A question option too long for its button
 * label is also listed in full, so no part of a choice is lost.
 * @param {import('./effects.mjs').Outbound} message @param {number} textChars
 * @returns {{ title: string, text: string, actions?: import('./channel-contract.mjs').ChannelAction[] }}
 */
export function compose(message, textChars) {
  const detail = message.detail ? showLinks(message.detail) : ''
  const body = detail ? `${message.text}\n\n${detail}` : message.text
  const title = message.card ? CHANNEL_TITLES.choice : CHANNEL_TITLES.message
  if (message.deliveryKey.startsWith('answer:') && body.length > textChars)
    throw new ChannelRefusal('TOO_LARGE', 'direct reply exceeds the current channel text budget')
  const actions = buttons(message)
  const numbered = (items) => items.map((t, i) => `${i + 1}. ${showLinks(t)}`).join('\n')
  let tail = ''
  if (message.card) {
    tail = actions
      ? `\n\n${BUTTON_POINTER}`
      : `\n\n${numbered([...message.card.options.map((o) => o.title), ...(message.card.allowNew ? [NEW_TASK_LABEL] : [])])}\n${CHOICE_POINTER}`
  } else if (message.ask && message.ask.options.some((o) => oneLine(o, LABEL_MAX) !== o)) {
    tail = `\n\n${numbered(message.ask.options)}`
  }
  const room = textChars - tail.length
  const text = room >= 1 ? clip(body, room) + tail : clip(body + tail, textChars)
  return { title, text, ...(actions ? { actions } : {}) }
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
  let textBudget = bound.textChars
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
      textBudget = now.textChars
      return now
    }
    return null
  }
  /** @param {string} messageId @returns {OutboxEntry | undefined} */
  const outboxByMessage = (messageId) => store.scan('outbox/').find((row) => row.value.messageId === messageId)?.value

  /**
   * A click is the owner's answer only to a message the companion sent and only to an option that
   * message offered; anything else is dropped. A click on a worker question must also find that
   * question still waiting.
   * @param {Extract<ChannelEvent, { kind: 'action' }>} event
   * @returns {import('./signals.mjs').InboundSignal | string} the signal, or the reason it is dropped
   */
  const clickSignal = (event) => {
    const row = outboxByMessage(event.messageId)
    if (!row) return 'not a message the companion sent'
    const base = { source: `channel:${bound.instanceId}`, eventId: event.eventId, at: event.at, origin: /** @type {const} */ ('owner') }
    const [verb, rest = ''] = event.actionId.split(/:(.*)/s)
    if (verb === 'pick' && row.card && (rest === 'new' || row.card.options.some((o) => o.taskId === rest))) return { ...base, kind: 'choice', card: row.deliveryKey, pick: rest }
    if (verb === 'answer' && row.ask && /^[1-9]\d?$/.test(rest)) {
      const option = row.ask.options[Number(rest) - 1]
      const taskId = row.taskIds[0]
      const task = taskId ? store.getTask(taskId) : undefined
      if (option === undefined) return 'the action is not an option of that message'
      if (!task || !isAsking(task) || task.question?.at !== row.ask.at) return 'the question is no longer waiting'
      // Only the number: the option text is the worker's own words and must not become owner-origin text.
      return { ...base, kind: 'message', text: rest, replyTo: taskId }
    }
    return 'the action is not an option of that message'
  }

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
      if (event.kind === 'message' && !event.text.trim()) return { kind: 'dropped', reason: 'message has no text' }
      const signal = event.kind === 'action' ? clickSignal(event) : {
        source: `channel:${bound.instanceId}`, eventId: event.eventId, at: event.at, origin: 'owner',
        kind: 'message', text: event.text, ...quoted(event, outboxByMessage),
        ...(event.receiptId ? { receiptId: event.receiptId } : {}),
        authority: { pairingId: event.pairingId, instanceId: event.instanceId, userId: event.sender.userId,
          chatId: event.chat.id, messageId: event.messageId, quotedMessageId: event.quotedMessageId ?? null },
      }
      if (typeof signal === 'string') return { kind: 'dropped', reason: signal }
      const result = await receive(signal)
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
        const sent = await gateway.send(pairing.id, { deliveryKey: key, ...compose(message, pairing.textChars) })
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

    async replyBudget() {
      await check()
      // Staging an answer is not delivery authority; an offline channel still gates every send.
      return textBudget
    },

    async prepareReply(text) {
      const pairing = await check()
      if (!pairing) throw new Error(/** @type {string} */ (status))
      return text.length <= pairing.textChars
        ? text
        : clip(answerRejection('answer is too long', pairing.textChars), pairing.textChars)
    },

    async watchSession(sessionId) {
      const pairing = await check()
      if (pairing && gateway.watchSession) await gateway.watchSession(pairing.id, sessionId)
    },

    async refresh() {
      const pairing = await check()
      if (!pairing || !gateway.update) return
      for (const { key, value: row } of store.scan('outbox/')) {
        if (!row.messageId || row.cardSettled || (!row.ask?.options.length && !row.card)) continue
        const taskId = row.taskIds.at(0)
        const task = taskId ? store.getTask(taskId) : undefined
        const closed = row.card ? !!row.chosen : !task || !isAsking(task) || task.question?.at !== row.ask?.at
        if (!closed) continue
        try {
          await gateway.update(pairing.id, row.messageId, {
            title: '伴侣：已处理', text: clip(`${row.text}\n\n已处理，此卡片不再接受选择。`, pairing.textChars),
          })
        } catch (error) {
          if (error instanceof ChannelRefusal && error.code === 'NOT_PAIRED') throw error
          continue
        }
        store.set(key, { ...row, cardSettled: true })
      }
    },

    status: () => status ?? (unconfirmed ? STATUS.unconfirmed : null),

    owner: Object.freeze({ instanceId: bound.instanceId, userId: bound.userId }),
  }
  return { ok: true, channel: Object.freeze(channel) }
}
