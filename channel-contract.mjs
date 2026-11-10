/**
 * The chat channel as the companion codes against it: the event and message shapes of the draft
 * channel contract (IM channel plan C1, `channel-contract.ts`), plus the narrowest gateway the
 * companion needs from a channel instance. The plugin-hosted target does not exist in the platform
 * yet; tests use test/fake-gateway.ts.
 *
 * Assumptions about the draft, to settle with the channel contract's owner:
 *   A1  Target: an instance can hand its owner's private messages and card clicks to a plugin's
 *       managed service instead of opening a session. The gateway calls `receive(event)` once per
 *       event of this instance, and redelivers until `receive` returns.
 *   A2  Identity: `sender.userId` is the platform-verified id taken from the signed callback by the
 *       runner, never a display name. The companion compares nothing else.
 *   A3  Owner: `instance(id)` reports whether the instance runs and its one bound owner:
 *       `userId`, the private `chatId` to send to, and the 32-hex `targetId` that `channel.bind`
 *       uses. Settings hold only the instance id. The owner can change while the companion runs,
 *       so `instance(id)` is read before every event, send and binding, and must be cheap enough
 *       for that. This file lists no notice that an instance was rebound, stopped or removed; if
 *       the draft has one, it would replace these reads.
 *   A4  Instance ids follow the channel config pattern `^[a-z][a-z0-9-]{0,47}$`.
 *   A5  Quotes: a message event carries `quotedMessageId`, the id of the message the owner replied
 *       to. The draft has only the mention booleans.
 *   A6  Clicks: a card action event carries `messageId`, the id `send` returned for that card. The
 *       draft has only `cardBizId`. `value` is the action id the card was rendered with.
 *   A7  Send: `send` resolves `{ messageId }` for every delivery, cards included. A rejection means
 *       the outcome is unknown, not that nothing was sent.
 *   A8  Ledger: `delivery(instance, deliveryKey)` answers delivered (with the message id), pending,
 *       failed or unknown. The gateway records the key before it hands the message to the platform,
 *       and keeps the record across restarts for at least the outbox lifetime (7 days).
 *   A9  Lock screen: the chat channel previews only a card's `title`, never its body.
 *   A10 Binding: the managed-sessions `start` accepts `{ instanceId, targetId }` for a worker session;
 *       the runner then pushes native approvals to that chat and verifies each click (C4). Approval
 *       clicks never reach `receive`. Contradicted by the platform today: `start` takes no binding,
 *       so `binding()` is not called and worker approvals are answered in the Web only.
 *   A13 Delivery to the plugin: the gateway reaches the companion's managed service through the
 *       `receive(event)` of the value its `start` returns. How the gateway finds that value is the
 *       gateway plugin's to define; index.mjs resolves the gateway in one function and gets nothing
 *       until that plugin exists.
 *   A11 Event ids are at most 128 characters and stable across redelivery.
 *   A12 Text only: attachments are ignored, and a message without text is dropped.
 *
 * @typedef {{ id: string, type: 'dm' | 'group' | 'thread', threadId?: string }} ChatRef
 * @typedef {{ userId: string, displayName?: string }} Sender  displayName is never read
 * @typedef {{ eventId: string, chat: ChatRef, sender: Sender, at: string }} EventBase
 * @typedef {EventBase & { kind: 'message', messageId: string, text: string, quotedMessageId?: string }} MessageEvent
 * @typedef {EventBase & { kind: 'cardAction', messageId: string, value: string }} CardActionEvent
 * @typedef {EventBase & { kind: 'groupJoin' | 'reaction' }} OtherEvent
 * @typedef {MessageEvent | CardActionEvent | OtherEvent} ChannelEvent
 *
 * @typedef {{ id: string, label: string, style?: 'primary' | 'danger' }} CardAction
 * @typedef {{ kind: 'card', title: string, body: string, actions?: CardAction[] }} CardBlock
 * @typedef {{ blocks: CardBlock[] }} ChannelMessage
 * @typedef {{ chatId: string, deliveryKey: string }} ChatTarget
 * @typedef {{ state: 'delivered', messageId: string } | { state: 'pending' } | { state: 'failed' } | { state: 'unknown' }} Delivery
 * @typedef {{ userId: string, chatId: string, targetId: string }} InstanceOwner
 * @typedef {{ running: boolean, owner: InstanceOwner | null }} InstanceInfo
 * @typedef {{
 *   instance(instanceId: string): Promise<InstanceInfo | undefined>,
 *   send(instanceId: string, target: ChatTarget, message: ChannelMessage): Promise<{ messageId: string }>,
 *   delivery(instanceId: string, deliveryKey: string): Promise<Delivery>,
 * }} ChannelGateway
 */

export const INSTANCE_ID = /^[a-z][a-z0-9-]{0,47}$/
export const TARGET_ID = /^[a-f0-9]{32}$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const KINDS = ['message', 'cardAction', 'groupJoin', 'reaction']
const CHAT_TYPES = ['dm', 'group', 'thread']

/** Parses one gateway event, keeping only the fields the companion reads. @param {unknown} raw @returns {{ ok: true, event: ChannelEvent } | { ok: false, error: string }} */
export function parseChannelEvent(raw) {
  if (!isObject(raw)) return { ok: false, error: 'event is not an object' }
  const v = /** @type {Record<string, any>} */ (raw)
  if (!KINDS.includes(v.kind)) return { ok: false, error: `event kind ${String(v.kind)} is unknown` }
  if (!text(v.eventId, 128)) return { ok: false, error: 'eventId is missing or too long' }
  if (!text(v.at, 64) || Number.isNaN(Date.parse(v.at))) return { ok: false, error: 'at is not a time' }
  if (!isObject(v.chat) || !text(v.chat.id, 256) || !CHAT_TYPES.includes(v.chat.type)) return { ok: false, error: 'chat is invalid' }
  if (!isObject(v.sender) || !text(v.sender.userId, 256)) return { ok: false, error: 'sender has no verified id' }
  const base = { eventId: v.eventId, at: v.at, chat: { id: v.chat.id, type: v.chat.type }, sender: { userId: v.sender.userId } }
  if (v.kind === 'message') {
    if (typeof v.text !== 'string' || !text(v.messageId, 256)) return { ok: false, error: 'message fields are invalid' }
    if (v.quotedMessageId !== undefined && !text(v.quotedMessageId, 256)) return { ok: false, error: 'quotedMessageId is invalid' }
    return { ok: true, event: { ...base, kind: 'message', messageId: v.messageId, text: v.text, ...(v.quotedMessageId ? { quotedMessageId: v.quotedMessageId } : {}) } }
  }
  if (v.kind === 'cardAction') {
    if (!text(v.messageId, 256) || !text(v.value, 256)) return { ok: false, error: 'card action fields are invalid' }
    return { ok: true, event: { ...base, kind: 'cardAction', messageId: v.messageId, value: v.value } }
  }
  return { ok: true, event: { ...base, kind: v.kind } }
}

/** @param {unknown} value @returns {value is InstanceOwner} */
export function isInstanceOwner(value) {
  return isObject(value) && text(value.userId, 256) && text(value.chatId, 256) && typeof value.targetId === 'string' && TARGET_ID.test(value.targetId)
}
