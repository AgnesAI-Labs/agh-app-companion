/**
 * The platform's managed channel targets (`init.channels`, design section 6.1) as a fake: one
 * service, at most one pairing, a send ledger keyed by deliveryKey, and refusals with the fixed
 * codes. `channels` is what the service receives; `port` is the companion's gateway over it.
 * `shown` is what the owner's phone received; a send that lands but loses its response still shows once.
 */
import { channelGateway } from '../channel-targets.mjs'

type Delivery = { state: 'delivered'; messageId: string } | { state: 'pending' } | { state: 'failed' } | { state: 'unknown' }
export type Pairing = {
  id: string
  instanceId: string
  provider: string
  userId: string
  chatId: string
  label: string
  running: boolean
  textChars: number
}

export const OWNER: Pairing = {
  id: 'a'.repeat(32),
  instanceId: 'im-1',
  provider: 'feishu',
  userId: 'u-owner',
  chatId: 'dm-owner',
  label: '小明',
  running: true,
  textChars: 4000,
}
export const CHAT_ID = OWNER.chatId

class Refusal extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function fakeGateway(options: { paired?: boolean; running?: boolean; textChars?: number } = {}) {
  const ledger = new Map<string, Delivery>()
  const shown: { chatId: string; deliveryKey: string; text: string; title: string; body: string; messageId: string }[] = []
  const rejected: { code: string; text: string }[] = []
  let pairing: Pairing | undefined =
    options.paired === false ? undefined : { ...OWNER, running: options.running ?? true, textChars: options.textChars ?? OWNER.textChars }
  let mode: 'ok' | 'down' | 'lostResponse' | 'stuck' | 'unconfirmed' = 'ok'
  let sends = 0
  let seq = 0
  let eventHandler: ((event: unknown) => Promise<void>) | undefined
  const changeHandlers: (() => void)[] = []
  const fire = () => changeHandlers.forEach((handler) => handler())
  const channels = {
    async pairing() {
      return pairing ? { ...pairing } : undefined
    },
    onEvent(handler: (event: unknown) => Promise<void>) {
      eventHandler = handler
    },
    onPairingChange(handler: () => void) {
      changeHandlers.push(handler)
    },
    async send(pairingId: string, input: { deliveryKey: string; text: string }) {
      sends++
      if (!pairing || pairingId !== pairing.id) throw new Refusal('NOT_PAIRED')
      if (!pairing.running) throw new Refusal('CHANNEL_UNAVAILABLE')
      if (!input.text || input.text.length > pairing.textChars) {
        rejected.push({ code: 'TOO_LARGE', text: input.text })
        throw new Refusal('TOO_LARGE')
      }
      if (mode === 'down') {
        ledger.set(input.deliveryKey, { state: 'unknown' })
        throw new Error('channel down')
      }
      if (mode === 'unconfirmed') {
        ledger.set(input.deliveryKey, { state: 'unknown' })
        throw new Refusal('TARGET_UNCONFIRMED')
      }
      if (mode === 'stuck') {
        ledger.set(input.deliveryKey, { state: 'pending' })
        throw new Error('timed out')
      }
      const messageId = `om-${++seq}`
      const [title = '', ...rest] = input.text.split('\n\n')
      shown.push({ chatId: pairing.chatId, deliveryKey: input.deliveryKey, text: input.text, title, body: rest.join('\n\n'), messageId })
      ledger.set(input.deliveryKey, { state: 'delivered', messageId })
      if (mode === 'lostResponse') throw new Error('read timed out')
      return { messageId }
    },
    async delivery(pairingId: string, deliveryKey: string): Promise<Delivery> {
      if (!pairing || pairingId !== pairing.id) throw new Refusal('NOT_PAIRED')
      return ledger.get(deliveryKey) ?? { state: 'unknown' }
    },
    async unpair(pairingId: string) {
      if (!pairing || pairingId !== pairing.id) throw new Refusal('NOT_PAIRED')
      pairing = undefined
      fire()
    },
  }
  let eventSeq = 0
  return {
    channels,
    port: channelGateway(channels)!,
    shown,
    rejected,
    ledger,
    get sends() {
      return sends
    },
    get handlerRegistered() {
      return eventHandler !== undefined
    },
    setMode(next: typeof mode) {
      mode = next
    },
    /** The owner pairs after the service started; the platform tells the service once. */
    pair(next: Pairing = OWNER, notify = true) {
      pairing = { ...next }
      if (notify) fire()
    },
    /** Another owner takes the pairing. */
    rebind(next: Partial<Pairing>) {
      if (pairing) pairing = { ...pairing, ...next }
    },
    setRunning(running: boolean) {
      if (pairing) pairing.running = running
    },
    /** Hands one event to the registered handler, as the platform does. */
    async emit(event: unknown) {
      if (!eventHandler) throw new Error('no handler registered')
      await eventHandler(event)
    },
    /** A private message event in the platform's ChannelTargetEvent shape. */
    message(text: string, fields: Record<string, any> = {}) {
      const id = fields.eventId ?? `ev-${++eventSeq}`
      return {
        kind: 'message',
        origin: 'owner',
        pairingId: fields.pairingId ?? pairing?.id ?? OWNER.id,
        instanceId: 'im-1',
        eventId: id,
        messageId: fields.messageId ?? `in-${eventSeq}`,
        at: fields.at ?? '2026-11-10T08:00:00.000Z',
        chat: fields.chat ?? { id: OWNER.chatId, type: 'dm' },
        sender: fields.sender ?? { userId: OWNER.userId },
        text,
        ...(fields.quotedMessageId ? { quotedMessageId: fields.quotedMessageId } : {}),
      }
    },
    stranger: { userId: 'u-stranger' },
    nextOwner: { ...OWNER, id: 'b'.repeat(32), userId: 'u-next', chatId: 'dm-next' },
  }
}
