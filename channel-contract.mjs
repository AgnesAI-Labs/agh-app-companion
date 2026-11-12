/**
 * The chat channel as the companion codes against it: the platform's managed channel targets
 * (Extension API 5.13, `init.channels`), narrowed to the gateway the companion needs. The
 * companion ships no chat client of its own: the owner pairs this service to a chat on the AGH
 * channel page, and every message in either direction goes through the platform.
 *
 * What the companion assumes, to check against the platform when it changes:
 *   A1  Inbound is at-most-once with bounded retry. The platform hands each owner message to the
 *       `onEvent` handler, retries a few times if the handler throws or the service is not running,
 *       then tells the owner the message was not received and drops it. No durable inbound queue
 *       exists, so `receive` returns a final result and throws only when it could not record the
 *       event. Events carry the platform's own `eventId`, stable across a retry.
 *   A2  Identity: `sender.userId` and `chat.id` come from the platform's pairing record, never from
 *       a display name. The companion still compares them with the pairing it opened on.
 *   A3  Owner: the service has at most one pairing (one private chat). `pairing()` reports it with
 *       the platform's `id`, the chat's `userId` and `chatId`, whether the channel instance runs,
 *       and `textChars`, the longest text one `send` accepts. It is read before every event and
 *       send, so an unpair or a re-pair is seen at once. `onPairingChange` is only a hint to read it
 *       again. The pairing id replaces the old `targetId`.
 *   A4  Instance ids are the platform's; the companion keeps `instanceId` only to bind its store to
 *       one owner.
 *   A5  Quotes: a message event carries `quotedMessageId`, the platform id of the message it replies
 *       to, when the chat app reports one. It is the id `send` returned, so a quote of one of the
 *       companion's own messages finds that message's outbox row and its task.
 *   A6  Clicks: `send` takes `title` and 1 to 6 `actions` (`id` of at most 64 characters from
 *       `[A-Za-z0-9:_-]`, `label` of at most 40, no line break). With actions the chat shows a card
 *       and a click arrives as `{ kind: 'action', messageId, actionId }`, `messageId` being the
 *       message the click was on. The platform does not keep the button list: the companion checks
 *       the `actionId` against that message's own options. A channel without cards gets the labels
 *       as a numbered text list, so the companion does not add its own list.
 *   A7  Send: `send` resolves `{ messageId }` for one platform message. A rejection means the
 *       outcome is unknown, not that nothing was sent.
 *   A8  Ledger: `delivery(pairingId, deliveryKey)` answers delivered (with the message id), pending
 *       (a send in this platform process has not finished), or unknown. Step 1 never answers
 *       failed, because an adapter error cannot tell "not sent" from "sent without a receipt".
 *       The platform keeps the record across restarts for 7 days; the key it hands the adapter is
 *       scoped to this package, so only the companion's own keys collide. A key resent after an
 *       `unknown` is the same key, so the chat platform may drop it as a duplicate.
 *   A9  Lock screen: the first line is the `title`, sent as a field so the chat shows it bold, and
 *       the body is previewed on the owner's own phone.
 *   A10 Binding: watchSession observes a session owned by this service. The platform sends native
 *       questions and approvals, admits the actual owner callback, and reconciles Web settlement.
 *   A11 Event ids are at most 128 characters.
 *   A12 Text only: attachments never arrive, and a message without text is dropped.
 *   A13 Delivery to the plugin: `init.channels.onEvent(handler)` registers the one handler of this
 *       service. The platform unregisters it when the resource exits. `onPairingChange` likewise.
 *   A14 Errors carry a fixed `code`: `NOT_PAIRED` (the service has no pairing, or never had this
 *       one), `TOO_LARGE`, `CHANNEL_UNAVAILABLE`, `CAPABILITY_DENIED`, or an adapter code such as
 *       `TARGET_UNCONFIRMED`: the chat platform only lets the bot write to a chat after the owner
 *       has written in the current connection, so after a restart sends fail until the owner sends
 *       one message. `TOO_LARGE`, `NOT_PAIRED` and `CAPABILITY_DENIED` do not clear by retrying; the rest may.
 *
 * @typedef {{ id: string, type: 'dm' }} ChatRef
 * @typedef {{ userId: string }} Sender
 * @typedef {{ id: string, label: string, style?: 'primary' | 'default' | 'danger' }} ChannelAction
 * @typedef {{
 *   kind: 'message', origin: 'owner', pairingId: string, instanceId: string, eventId: string,
 *   messageId: string, at: string, chat: ChatRef, sender: Sender, text: string, quotedMessageId?: string,
 * } | {
 *   kind: 'action', origin: 'owner', pairingId: string, instanceId: string, eventId: string,
 *   messageId: string, at: string, chat: ChatRef, sender: Sender, actionId: string,
 * }} ChannelEvent  the platform's ChannelTargetEvent
 * @typedef {{
 *   id: string, instanceId: string, provider: string, userId: string, chatId: string, label: string,
 *   running: boolean, textChars: number,
 * }} Pairing
 * @typedef {{ state: 'delivered', messageId: string } | { state: 'pending' } | { state: 'failed' } | { state: 'unknown' }} Delivery
 * @typedef {{
 *   pairing(): Promise<Pairing | undefined>,
 *   send(pairingId: string, input: { deliveryKey: string, text: string, title?: string, actions?: ChannelAction[] }): Promise<{ messageId: string }>,
 *   watchSession?(pairingId: string, sessionId: string): Promise<void>,
 *   update?(pairingId: string, messageId: string, input: { text: string, title?: string, actions?: ChannelAction[] }): Promise<void>,
 *   delivery(pairingId: string, deliveryKey: string): Promise<Delivery>,
 *   unpair(pairingId: string): Promise<void>,
 *   onEvent(handler: (event: unknown) => Promise<void>): void,
 *   onPairingChange(handler: () => void): void,
 * }} ChannelGateway
 */

export const REFUSAL_CODES = Object.freeze(['NOT_PAIRED', 'TOO_LARGE', 'CHANNEL_UNAVAILABLE', 'CAPABILITY_DENIED', 'TARGET_UNCONFIRMED'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max

/** Parses one platform event, keeping only the fields the companion reads. @param {unknown} raw @returns {{ ok: true, event: ChannelEvent } | { ok: false, error: string }} */
export function parseChannelEvent(raw) {
  if (!isObject(raw)) return { ok: false, error: 'event is not an object' }
  const v = /** @type {Record<string, any>} */ (raw)
  if (v.kind !== 'message' && v.kind !== 'action') return { ok: false, error: `event kind ${String(v.kind)} is not a message or a click` }
  if (v.origin !== 'owner') return { ok: false, error: 'event is not from the owner' }
  if (!text(v.eventId, 128)) return { ok: false, error: 'eventId is missing or too long' }
  if (!text(v.pairingId, 256)) return { ok: false, error: 'pairingId is missing' }
  if (!text(v.at, 64) || Number.isNaN(Date.parse(v.at))) return { ok: false, error: 'at is not a time' }
  if (!isObject(v.chat) || !text(v.chat.id, 256) || v.chat.type !== 'dm') return { ok: false, error: 'chat is not a private chat' }
  if (!isObject(v.sender) || !text(v.sender.userId, 256)) return { ok: false, error: 'sender has no verified id' }
  if (!text(v.messageId, 256)) return { ok: false, error: 'messageId is invalid' }
  const common = {
    origin: /** @type {const} */ ('owner'), pairingId: v.pairingId, instanceId: typeof v.instanceId === 'string' ? v.instanceId : '',
    eventId: v.eventId, messageId: v.messageId, at: v.at, chat: { id: v.chat.id, type: /** @type {const} */ ('dm') }, sender: { userId: v.sender.userId },
  }
  if (v.kind === 'action') {
    if (!text(v.actionId, 64)) return { ok: false, error: 'actionId is invalid' }
    return { ok: true, event: { kind: 'action', ...common, actionId: v.actionId } }
  }
  if (typeof v.text !== 'string') return { ok: false, error: 'message fields are invalid' }
  if (v.quotedMessageId !== undefined && !text(v.quotedMessageId, 256)) return { ok: false, error: 'quotedMessageId is invalid' }
  return { ok: true, event: { kind: 'message', ...common, text: v.text, ...(v.quotedMessageId ? { quotedMessageId: v.quotedMessageId } : {}) } }
}

/** @param {unknown} value @returns {value is Pairing} */
export function isPairing(value) {
  return (
    isObject(value) && text(value.id, 256) && typeof value.instanceId === 'string' && typeof value.provider === 'string' &&
    text(value.userId, 256) && text(value.chatId, 256) && typeof value.label === 'string' && typeof value.running === 'boolean' &&
    Number.isInteger(value.textChars) && /** @type {number} */ (value.textChars) > 0
  )
}
