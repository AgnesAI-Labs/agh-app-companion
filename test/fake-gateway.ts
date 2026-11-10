/**
 * The chat channel's gateway as channel-contract.mjs assumes it: one instance with a bound owner,
 * sends that return a message id, and a delivery ledger keyed by deliveryKey. `shown` is what the
 * owner's phone received; a send that lands but loses its response still shows once.
 */
type Delivery = { state: 'delivered'; messageId: string } | { state: 'pending' } | { state: 'failed' } | { state: 'unknown' }

export const OWNER = { userId: 'u-owner', chatId: 'dm-owner', targetId: 'a'.repeat(32) }

export function fakeGateway(options: { instance?: string; owner?: typeof OWNER | null; running?: boolean } = {}) {
  const instanceId = options.instance ?? 'im-1'
  const ledger = new Map<string, Delivery>()
  const shown: { chatId: string; deliveryKey: string; message: any; messageId: string }[] = []
  let state: { running: boolean; owner: typeof OWNER | null } | undefined = {
    running: options.running ?? true,
    owner: options.owner === undefined ? OWNER : options.owner,
  }
  let mode: 'ok' | 'down' | 'lostResponse' | 'stuck' = 'ok'
  let sends = 0
  let seq = 0
  const port = {
    async instance(id: string) {
      if (id !== instanceId || !state) return undefined
      return { running: state.running, owner: state.owner }
    },
    async send(id: string, target: { chatId: string; deliveryKey: string }, message: any) {
      sends++
      if (id !== instanceId) throw new Error('unknown instance')
      if (mode === 'down') {
        ledger.set(target.deliveryKey, { state: 'failed' })
        throw new Error('channel down')
      }
      if (mode === 'stuck') {
        ledger.set(target.deliveryKey, { state: 'pending' })
        throw new Error('timed out')
      }
      const messageId = `om-${++seq}`
      shown.push({ chatId: target.chatId, deliveryKey: target.deliveryKey, message, messageId })
      ledger.set(target.deliveryKey, { state: 'delivered', messageId })
      if (mode === 'lostResponse') throw new Error('read timed out')
      return { messageId }
    },
    async delivery(id: string, deliveryKey: string): Promise<Delivery> {
      if (id !== instanceId) return { state: 'unknown' }
      return ledger.get(deliveryKey) ?? { state: 'unknown' }
    },
  }
  let eventSeq = 0
  const base = (fields: Record<string, any>) => ({
    eventId: fields.eventId ?? `ev-${++eventSeq}`,
    accountId: 'bot',
    chat: fields.chat ?? { id: OWNER.chatId, type: 'dm' },
    sender: fields.sender ?? { userId: OWNER.userId, displayName: 'Owner', raw: {} },
    at: fields.at ?? '2026-11-10T08:00:00.000Z',
  })
  return {
    port,
    shown,
    ledger,
    get sends() {
      return sends
    },
    setMode(next: typeof mode) {
      mode = next
    },
    /** Changes the instance while the companion runs: bind another owner, stop or start it, or remove it. */
    rebind(owner: typeof OWNER | null) {
      if (state) state.owner = owner
    },
    setRunning(running: boolean) {
      if (state) state.running = running
    },
    remove() {
      state = undefined
    },
    /** A private message event in the draft contract's shape. */
    message(text: string, fields: Record<string, any> = {}) {
      const { quotedMessageId, ...rest } = fields
      return {
        ...base(rest),
        kind: 'message',
        messageId: rest.messageId ?? `in-${eventSeq}`,
        text,
        attachments: [],
        mentions: { bot: false, replyToBot: Boolean(quotedMessageId), quoteBot: false },
        ...(quotedMessageId ? { quotedMessageId } : {}),
      }
    },
    /** A card button click on the card message `messageId`. */
    click(messageId: string, value: string, fields: Record<string, any> = {}) {
      return { ...base(fields), kind: 'cardAction', cardBizId: `biz-${messageId}`, messageId, value }
    },
    stranger: { userId: 'u-stranger', displayName: 'Owner', raw: {} },
    nextOwner: { userId: 'u-next', chatId: 'dm-next', targetId: 'b'.repeat(32) },
  }
}
