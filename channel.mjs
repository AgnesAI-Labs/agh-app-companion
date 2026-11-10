import { INSTANCE_ID, isInstanceOwner, parseChannelEvent } from './channel-contract.mjs'

/**
 * The chat channel adapter: the engine's `Channel` port outbound, InboundSignal inbound. Authority
 * comes only from the gateway's verified sender id against the instance's bound owner (A2, A3);
 * approval clicks stay with the channel runner (A10). Every receive, send and binding re-reads the
 * instance and refuses unless it still runs with the owner bound at open: outbox rows do not record
 * whom they were written for, so after a rebind none may go to anyone until the service restarts.
 *
 * @typedef {import('./channel-contract.mjs').ChannelEvent} ChannelEvent
 * @typedef {import('./channel-contract.mjs').ChannelGateway} ChannelGateway
 * @typedef {import('./channel-contract.mjs').ChannelMessage} ChannelMessage
 * @typedef {import('./tasks.mjs').OutboxEntry} OutboxEntry
 * @typedef {{ instanceId: string, targetId: string }} SessionBinding  what a worker session's `start` binds to (A10)
 * @typedef {{ kind: 'accepted' | 'duplicate', key: string } | { kind: 'dropped', reason: string } | { kind: 'invalid', error: string }} ReceiveResult
 *   every result is final: the gateway acknowledges the event once `receive` returns, and redelivers only if it throws
 * @typedef {import('./effects.mjs').Channel & {
 *   receive(raw: unknown): Promise<ReceiveResult>, binding(): Promise<SessionBinding>, status(): string | null,
 *   owner: import('./store.mjs').ChannelOwner,
 * }} ChatChannel
 *   status is the refusal from the last instance check, or null while the instance serves the owner;
 *   owner is the instance's owner at open
 */

/** Notification titles show on a lock screen (A9), so they are fixed text with no task content. */
export const CHANNEL_TITLES = Object.freeze({ message: '伴侣：有新消息', choice: '伴侣：有件事请你选' })
const NEW_TASK_LABEL = '新建任务'
const MAX_CANDIDATES = 32

/**
 * Channel event kind to the signal it becomes. Each returns the kind-specific signal fields or the
 * reason it is dropped; origin, source and event id are added by `receive`.
 * @type {Record<ChannelEvent['kind'], (event: any, outboxByMessage: (id: string) => OutboxEntry | undefined) => Record<string, unknown> | { drop: string }>}
 */
const EVENT_TO_SIGNAL = {
  message: (event, outboxByMessage) => (event.text.trim() ? { kind: 'message', text: event.text, ...quoted(event, outboxByMessage) } : { drop: 'message has no text' }),
  cardAction: (event, outboxByMessage) => click(event, outboxByMessage(event.messageId)),
  groupJoin: () => ({ drop: 'not a private message or card click' }),
  reaction: () => ({ drop: 'not a private message or card click' }),
}

/**
 * A quote of one task's message names that task. A quote of a message about several tasks, or of a
 * choice card (whose question a typed answer belongs to, not the worker), limits the judge to them.
 */
function quoted(event, outboxByMessage) {
  const row = event.quotedMessageId ? outboxByMessage(event.quotedMessageId) : undefined
  if (!row || row.taskIds.length === 0) return {}
  if (row.taskIds.length === 1 && !row.card) return { replyTo: row.taskIds[0] }
  return { candidates: row.taskIds.slice(0, MAX_CANDIDATES) }
}

/** Card click value to signal. Only choice cards carry actions today, rendered as `pick:<taskId|new>`. */
function click(event, row) {
  if (!row) return { drop: 'card is not a companion message' }
  if (!row.card || !event.value.startsWith('pick:')) return { drop: 'card action is not one the companion rendered' }
  return { kind: 'choice', card: row.deliveryKey, pick: event.value.slice('pick:'.length) }
}

/** @param {import('./effects.mjs').Outbound} message @returns {ChannelMessage} */
export function render(message) {
  const body = message.detail ? `${message.text}\n\n${message.detail}` : message.text
  if (!message.card) return { blocks: [{ kind: 'card', title: CHANNEL_TITLES.message, body }] }
  const actions = message.card.options.map((o) => ({ id: `pick:${o.taskId}`, label: o.title }))
  if (message.card.allowNew) actions.push({ id: 'pick:new', label: NEW_TASK_LABEL })
  return { blocks: [{ kind: 'card', title: CHANNEL_TITLES.choice, body, actions }] }
}

/**
 * Opens the adapter on the `channelInstance` setting, or refuses with the status to show the owner.
 * @param {{
 *   settings: import('./settings.mjs').Settings, gateway: ChannelGateway, store: import('./store.mjs').Store,
 *   receive: (signal: unknown) => { kind: string, key?: string, error?: string } | Promise<{ kind: string, key?: string, error?: string }>,
 * }} deps receive = the engine's `receive`
 * @returns {Promise<{ ok: true, channel: ChatChannel } | { ok: false, status: string }>}
 */
export async function openChannel({ settings, gateway, store, receive }) {
  const instanceId = settings.channelInstance
  if (!instanceId) return { ok: false, status: 'channelInstance is not set' }
  if (!INSTANCE_ID.test(instanceId)) return { ok: false, status: `channelInstance ${JSON.stringify(instanceId)} is not a channel instance id` }
  const info = await gateway.instance(instanceId)
  if (!info) return { ok: false, status: `channel instance ${instanceId} is not available` }
  if (!info.running) return { ok: false, status: `channel instance ${instanceId} is not running` }
  if (!isInstanceOwner(info.owner)) return { ok: false, status: `channel instance ${instanceId} has no bound owner` }
  const owner = info.owner
  const source = `channel:${instanceId}`
  /** @type {string | null} */
  let status = null
  /** @returns {Promise<string | null>} why the instance cannot serve the owner bound at open, or null */
  const refusal = async () => {
    const now = await gateway.instance(instanceId)
    if (!now) status = `channel instance ${instanceId} is not available`
    else if (!now.running) status = `channel instance ${instanceId} is not running`
    else if (!isInstanceOwner(now.owner)) status = `channel instance ${instanceId} has no bound owner`
    else if (now.owner.userId !== owner.userId || now.owner.chatId !== owner.chatId || now.owner.targetId !== owner.targetId)
      status = `channel instance ${instanceId} was rebound to another owner; restart the companion service to serve the new owner`
    else status = null
    return status
  }
  /** @param {string} messageId @returns {OutboxEntry | undefined} */
  const outboxByMessage = (messageId) => store.scan('outbox/').find((row) => row.value.messageId === messageId)?.value

  /** @type {ChatChannel} */
  const channel = {
    async receive(raw) {
      const parsed = parseChannelEvent(raw)
      if (!parsed.ok) return { kind: 'invalid', error: parsed.error }
      const event = parsed.event
      const refused = await refusal()
      if (refused) return { kind: 'dropped', reason: refused }
      // Strangers stop here, before the inbox, so their volume cannot fill the store.
      if (event.chat.type !== 'dm' || event.chat.id !== owner.chatId || event.sender.userId !== owner.userId) return { kind: 'dropped', reason: 'not from the owner' }
      const fields = EVENT_TO_SIGNAL[event.kind](event, outboxByMessage)
      if ('drop' in fields) return { kind: 'dropped', reason: /** @type {string} */ (fields.drop) }
      const result = await receive({ source, eventId: event.eventId, at: event.at, origin: 'owner', ...fields })
      if (result.kind === 'accepted' || result.kind === 'duplicate') return { kind: result.kind, key: /** @type {string} */ (result.key) }
      return { kind: 'invalid', error: result.error ?? 'refused by the engine' }
    },

    // Asks the ledger before every send, so a redelivery after a crash never sends twice even when
    // the chat platform has no idempotency key of its own.
    async deliver(message) {
      const key = message.deliveryKey
      const refused = await refusal()
      if (refused) throw new Error(refused)
      const before = await gateway.delivery(instanceId, key)
      if (before.state === 'delivered') return { messageId: before.messageId }
      if (before.state === 'pending') throw new Error(`delivery ${key} is still pending at the channel`)
      try {
        return await gateway.send(instanceId, { chatId: owner.chatId, deliveryKey: key }, render(message))
      } catch (error) {
        const after = await gateway.delivery(instanceId, key)
        if (after.state === 'delivered') return { messageId: after.messageId }
        throw error
      }
    },

    async binding() {
      const refused = await refusal()
      if (refused) throw new Error(refused)
      return { instanceId, targetId: owner.targetId }
    },

    status: () => status,

    owner: Object.freeze({ instanceId, userId: owner.userId }),
  }
  return { ok: true, channel: Object.freeze(channel) }
}
