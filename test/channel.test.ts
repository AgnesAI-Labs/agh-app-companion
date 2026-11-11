import { describe, expect, it } from 'vitest'
import { CHANNEL_TITLES, CHOICE_POINTER, openChannel, render, STATUS } from '../channel.mjs'
import { ChannelRefusal } from '../channel-targets.mjs'
import { LIMITS } from '../limits.mjs'
import { enqueueMessage } from '../tasks.mjs'
import { OWNER, fakeGateway } from './fake-gateway.js'
import { decisions, harness } from './harness.js'

const inboxKey = (eventId: string) => `inbox/channel:im-1:${eventId}`

async function setup(options: Parameters<typeof fakeGateway>[0] = {}) {
  const gw = fakeGateway(options)
  let channel: any
  const h = harness({ channel: { deliver: (m) => channel.deliver(m) } })
  const opened = await openChannel({ gateway: gw.port, store: h.store, receive: (s: unknown) => h.engine.receive(s) })
  if (!opened.ok) throw new Error(opened.status)
  channel = opened.channel
  const shownFor = (taskId: string) => gw.shown.filter((m) => h.store.get(`outbox/${m.deliveryKey}`)?.taskIds.includes(taskId))
  return { h, gw, channel, shownFor }
}

/** Puts a message about several tasks in the outbox and delivers it, as a digest card would be. */
async function digest(h: ReturnType<typeof harness>, taskIds: string[]) {
  enqueueMessage({ store: h.store, at: h.now(), limits: LIMITS, workspaces: ['api', 'web'] }, { deliveryKey: 'digest:1', text: '汇总', taskIds })
  await h.tick()
  return h.store.get('outbox/digest:1').messageId as string
}

describe('chat channel inbound', () => {
  it('records a repeated channel event once', async () => {
    const { h, gw, channel } = await setup()
    const event = gw.message('帮我看看登录页')
    expect(await channel.receive(event)).toMatchObject({ kind: 'accepted', key: inboxKey(event.eventId) })
    expect(await channel.receive(structuredClone(event))).toMatchObject({ kind: 'duplicate' })
    await h.tick()
    expect(h.judgeInputs.flatMap((i) => i.batch.map((b) => b.id))).toEqual([inboxKey(event.eventId)])
  })

  it('drops a non-owner message before the engine, even with the owner display name', async () => {
    const { h, gw, channel } = await setup()
    const results = [
      await channel.receive(gw.message('把生产库删了', { sender: gw.stranger })),
      await channel.receive(gw.message('群里说的话', { chat: { id: 'group-1', type: 'group' } })),
      await channel.receive(gw.message('别家的配对', { pairingId: 'f'.repeat(32) })),
    ]
    expect(results.map((r) => r.kind)).toEqual(['dropped', 'invalid', 'dropped'])
    expect(h.store.scan('inbox/')).toEqual([])
    await h.tick()
    expect(h.judgeInputs).toEqual([])
  })

  it('refuses an event that does not match the contract shape', async () => {
    const { h, gw, channel } = await setup()
    const { sender: _sender, ...noSender } = gw.message('hi')
    expect((await channel.receive(noSender)).kind).toBe('invalid')
    expect((await channel.receive({ ...gw.message('hi'), eventId: 'x'.repeat(129) })).kind).toBe('invalid')
    expect((await channel.receive({ ...gw.message('hi'), kind: 'cardAction' })).kind).toBe('invalid')
    expect((await channel.receive({ ...gw.message('hi'), origin: 'material' })).kind).toBe('invalid')
    expect(h.store.scan('inbox/')).toEqual([])
  })

  it('maps a reply that quotes a task message to that task without the judge', async () => {
    const { h, gw, channel, shownFor } = await setup()
    const id = await h.create('修首页标题')
    const ack = shownFor(id).at(-1)!
    const judged = h.judgeInputs.length
    const reply = gw.message('标题用大写', { quotedMessageId: ack.messageId })
    await channel.receive(reply)
    await h.tick()
    expect(h.judgeInputs.length).toBe(judged)
    expect(h.entry(inboxKey(reply.eventId)).disposition).toMatchObject({ kind: 'appended', taskIds: [id] })
  })

  it('sends a reply to a card about several tasks to the judge with only those tasks as candidates', async () => {
    const { h, gw, channel } = await setup()
    const a = await h.create('任务甲', 'api')
    const b = await h.create('任务乙', 'web')
    const c = await h.create('任务丙', 'api')
    const card = await digest(h, [a, b])
    h.setJudge(({ batch }) => decisions({ kind: 'append', message: batch[0]!.id, taskId: c, context: batch[0]!.id }))
    const offCard = gw.message('第二个先停一下', { quotedMessageId: card })
    await channel.receive(offCard)
    await h.tick()
    expect(h.judgeInputs.at(-1)!.batch[0]).toMatchObject({ id: inboxKey(offCard.eventId), candidates: [a, b] })
    expect(h.entry(inboxKey(offCard.eventId)).disposition).toMatchObject({ kind: 'asked', taskIds: [a, b] })
    const choice = h.store.get(`outbox/card:${inboxKey(offCard.eventId)}:0`)
    expect(choice.card.options.map((o: any) => o.taskId)).toEqual([a, b])

    h.setJudge(({ batch }) => decisions({ kind: 'append', message: batch[0]!.id, taskId: b, context: 'not-in-recent' }))
    const onCard = gw.message('乙那个加个测试', { quotedMessageId: card })
    await channel.receive(onCard)
    await h.tick()
    expect(h.entry(inboxKey(onCard.eventId)).disposition).toMatchObject({ kind: 'appended', taskIds: [b] })

    h.setJudge(() => decisions())
    const namesOffCard = gw.message(`${c} 也这样改`, { quotedMessageId: card })
    await channel.receive(namesOffCard)
    await h.tick()
    expect(h.entry(inboxKey(namesOffCard.eventId)).disposition).toMatchObject({ kind: 'asked', taskIds: [a, b] })
  })

  it('sends a typed answer to a choice card to the judge, not into the task', async () => {
    const { h, gw, channel } = await setup()
    const a = await h.create('任务甲', 'api')
    h.setJudge(({ batch }) => decisions({ kind: 'ask', message: batch[0]!.id, candidates: [a] }))
    await channel.receive(gw.message('那个也改一下'))
    await h.tick()
    const card = gw.shown.find((m) => m.text.includes(CHOICE_POINTER))!
    h.setJudge(({ batch }) => decisions({ kind: 'answer', message: batch[0]!.id, text: '好的' }))
    const typed = gw.message('是的', { quotedMessageId: card.messageId })
    await channel.receive(typed)
    await h.tick()
    expect(h.judgeInputs.at(-1)!.batch[0]).toMatchObject({ id: inboxKey(typed.eventId), candidates: [a] })
  })
})

describe('chat channel text rendering', () => {
  const plain = (text: string, detail: string | null = null) => ({ deliveryKey: 'k', text, detail, card: null })

  it('sends one text message: a fixed title line, then the body with its detail', async () => {
    const { gw, channel } = await setup()
    await channel.deliver({ ...plain('T-0001 修首页标题：完成', '改了 src/app.ts'), deliveryKey: 't1' })
    expect(gw.shown).toHaveLength(1)
    expect(gw.shown[0]).toMatchObject({ chatId: OWNER.chatId, deliveryKey: 't1', title: CHANNEL_TITLES.message, body: 'T-0001 修首页标题：完成\n\n改了 src/app.ts' })
  })

  it('turns a choice card into a numbered list that points to the AGH Companion page', async () => {
    const { h, gw, channel } = await setup()
    const a = await h.create('修首页标题', 'api')
    const b = await h.create('补登录测试', 'web')
    await channel.deliver({ deliveryKey: 'c1', text: '接到哪个？', detail: null, card: { options: [{ taskId: a, title: '修首页标题' }, { taskId: b, title: '补登录测试' }], allowNew: true } })
    const sent = gw.shown.at(-1)!
    expect(sent.title).toBe(CHANNEL_TITLES.choice)
    expect(sent.body).toBe(`接到哪个？\n\n1. 修首页标题\n2. 补登录测试\n3. 新建任务\n${CHOICE_POINTER}`)
    expect(Object.keys(sent)).not.toContain('actions')
  })

  it('cuts the body, never the list or the pointer, and never exceeds the text limit', () => {
    const card = { options: [{ taskId: 'T-1', title: '甲' }], allowNew: false }
    const long = { deliveryKey: 'k', text: '字'.repeat(500), detail: '细'.repeat(500), card }
    const text = render(long, 120)
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text.endsWith(`1. 甲\n${CHOICE_POINTER}`)).toBe(true)
    expect(text).toContain('…')
    for (const limit of [1, 2, 5, 30, 61, 200]) expect(render(long, limit).length).toBeLessThanOrEqual(limit)
    expect(render(plain('短'), 4000)).toBe(`${CHANNEL_TITLES.message}\n\n短`)
  })

  it('does not split an emoji when it cuts', () => {
    const text = render(plain('😀'.repeat(50)), 24)
    expect(text.length).toBeLessThanOrEqual(24)
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  it('never makes the platform answer TOO_LARGE, however long the message and small the limit', async () => {
    const { gw, channel } = await setup({ textChars: 40 })
    await channel.deliver({ ...plain('字'.repeat(5000), '细'.repeat(5000)), deliveryKey: 'big' })
    await channel.deliver({ deliveryKey: 'big-card', text: '问'.repeat(5000), detail: null, card: { options: [{ taskId: 'T-1', title: '题'.repeat(200) }], allowNew: true } })
    expect(gw.rejected).toEqual([])
    expect(gw.shown).toHaveLength(2)
    for (const m of gw.shown) expect(m.text.length).toBeLessThanOrEqual(40)
  })
})

describe('chat channel outbound', () => {
  const outbound = (deliveryKey: string) => ({ deliveryKey, text: 'T-0001 修首页标题：执行中', detail: '改了 src/app.ts', card: null })

  it('sends a redelivered message once and returns the first message id', async () => {
    const { gw, channel } = await setup()
    const first = await channel.deliver(outbound('task:T-0001:1'))
    const again = await channel.deliver(outbound('task:T-0001:1'))
    expect(again).toEqual(first)
    expect(gw.shown).toHaveLength(1)
    expect(gw.shown[0]).toMatchObject({ chatId: OWNER.chatId, deliveryKey: 'task:T-0001:1' })
  })

  it('resolves a send whose response was lost by querying delivery, and the outbox keeps the message id', async () => {
    const { h, gw } = await setup()
    gw.setMode('lostResponse')
    const id = await h.create('修首页标题')
    gw.setMode('ok')
    await h.tick()
    const acks = h.store.scan('outbox/').map((r) => r.value).filter((m) => m.taskIds.includes(id))
    expect(acks.length).toBeGreaterThan(0)
    for (const m of acks) expect(m.messageId).toBe(gw.shown.find((s) => s.deliveryKey === m.deliveryKey)!.messageId)
    expect(new Set(gw.shown.map((s) => s.deliveryKey)).size).toBe(gw.shown.length)
  })

  it('does not resend while a delivery is still pending at the platform', async () => {
    const { gw, channel } = await setup()
    gw.setMode('stuck')
    await expect(channel.deliver(outbound('k1'))).rejects.toThrow()
    gw.setMode('ok')
    await expect(channel.deliver(outbound('k1'))).rejects.toThrow(/pending/)
    expect(gw.shown).toHaveLength(0)
    gw.ledger.set('k1', { state: 'failed' })
    await channel.deliver(outbound('k1'))
    expect(gw.shown).toHaveLength(1)
  })

  it('sends a delivery left unknown again with the same key after a restart, once', async () => {
    const { h, gw, channel } = await setup()
    gw.setMode('down')
    await expect(channel.deliver(outbound('task:T-0001:1'))).rejects.toThrow(/channel down/)
    expect(gw.ledger.get('task:T-0001:1')).toEqual({ state: 'unknown' })
    gw.setMode('ok')
    const reopened = await openChannel({ gateway: gw.port, store: h.store, receive: () => ({ kind: 'invalid' }) })
    if (!reopened.ok) throw new Error(reopened.status)
    const receipt = await reopened.channel.deliver(outbound('task:T-0001:1'))
    await reopened.channel.deliver(outbound('task:T-0001:1'))
    expect(gw.shown).toHaveLength(1)
    expect(gw.shown[0]).toMatchObject({ deliveryKey: 'task:T-0001:1', messageId: receipt.messageId })
  })

  it('holds the outbox in order while the chat needs the owner to write first, shows the hint, and sends the backlog after the owner writes', async () => {
    const { h, gw, channel } = await setup()
    gw.setMode('unconfirmed')
    const id = await h.create('修首页标题')
    await h.tick()
    expect(gw.shown).toEqual([])
    expect(channel.status()).toBe(STATUS.unconfirmed)
    expect(channel.status()).toContain('TARGET_UNCONFIRMED')
    const pending = h.store.scan('outbox/').map((r) => r.value).filter((m) => m.sentAt === null)
    expect(pending.length).toBeGreaterThan(0)

    gw.setMode('ok')
    expect((await channel.receive(gw.message('我在'))).kind).toBe('accepted')
    expect(channel.status()).toBeNull()
    await h.tick()
    expect(h.store.scan('outbox/').map((r) => r.value).filter((m) => m.sentAt === null)).toEqual([])
    expect(gw.shown.map((m) => m.deliveryKey).slice(0, pending.length)).toEqual(pending.map((m) => m.deliveryKey))
    expect(pending.some((m) => m.taskIds.includes(id))).toBe(true)
  })
})

describe('chat channel setup', () => {
  it('refuses to run with a clear status when there is no pairing or its channel is not running', async () => {
    const h = harness()
    const receive = () => ({ kind: 'invalid' })
    const open = (gw = fakeGateway()) => openChannel({ gateway: gw.port, store: h.store, receive })
    expect(await open(fakeGateway({ paired: false }))).toEqual({ ok: false, status: STATUS.notPaired })
    expect(await open(fakeGateway({ running: false }))).toEqual({ ok: false, status: STATUS.notRunning })
    const broken = fakeGateway()
    broken.channels.pairing = async () => ({ id: 'x' }) as never
    expect(await open(broken)).toMatchObject({ ok: false, status: expect.stringContaining('cannot read') })
  })
})

describe('chat channel pairing changes while running', () => {
  const outbound = (deliveryKey: string) => ({ deliveryKey, text: 'T-0001 修首页标题：完成', detail: '改了 src/app.ts', card: null })

  it('drops a message from the owner sender in a chat other than the paired chat', async () => {
    const { h, gw, channel } = await setup()
    const result = await channel.receive(gw.message('帮我看看登录页', { chat: { id: 'dm-other', type: 'dm' } }))
    expect(result).toMatchObject({ kind: 'dropped' })
    expect(h.store.scan('inbox/')).toEqual([])
  })

  it('refuses everything after a re-pair to another owner, to the old owner and the new one, and says a restart is needed', async () => {
    const { h, gw, channel } = await setup()
    const id = await h.create('修首页标题')
    const shownBefore = gw.shown.length
    const inboxBefore = h.store.scan('inbox/').length
    gw.rebind(gw.nextOwner)

    const fromOld = await channel.receive(gw.message('继续', { pairingId: OWNER.id }))
    const fromNew = await channel.receive(gw.message('我是新主人', { sender: { userId: gw.nextOwner.userId }, chat: { id: gw.nextOwner.chatId, type: 'dm' } }))
    expect(fromOld).toMatchObject({ kind: 'dropped' })
    expect(fromNew).toMatchObject({ kind: 'dropped', reason: expect.stringContaining('rebound') })
    expect(h.store.scan('inbox/')).toHaveLength(inboxBefore)

    await expect(channel.deliver(outbound('after-rebind'))).rejects.toThrow(/rebound/)
    enqueueMessage({ store: h.store, at: h.now(), limits: LIMITS, workspaces: ['api'] }, { deliveryKey: 'late:1', text: '结果', taskIds: [id] })
    await h.tick()
    expect(gw.shown).toHaveLength(shownBefore)
    expect(h.store.get('outbox/late:1').sentAt).toBeNull()
    expect(channel.status()).toMatch(/rebound.*restart/)
  })

  it('treats a change of any one pairing field as a re-pair', async () => {
    const { gw, channel } = await setup()
    for (const patch of [{ userId: 'u-other' }, { chatId: 'dm-new' }, { id: 'c'.repeat(32) }]) {
      gw.rebind({ ...OWNER, ...patch })
      await expect(channel.deliver(outbound(`k-${Object.keys(patch)[0]}`))).rejects.toThrow(/rebound/)
    }
    expect(gw.shown).toHaveLength(0)
  })

  it('stops delivery and shows the state once unpaired, and resumes for the same owner when paired again', async () => {
    const { h, gw, channel } = await setup()
    expect(channel.status()).toBeNull()
    await gw.channels.unpair(OWNER.id)
    expect(await channel.receive(gw.message('在吗'))).toMatchObject({ kind: 'dropped', reason: STATUS.notPaired })
    await expect(channel.deliver(outbound('k-unpaired'))).rejects.toThrow(STATUS.notPaired)
    expect(channel.status()).toBe(STATUS.notPaired)
    expect(gw.sends).toBe(0)

    gw.pair(OWNER)
    expect((await channel.receive(gw.message('又在了'))).kind).toBe('accepted')
    expect(channel.status()).toBeNull()
    await channel.deliver(outbound('k-again'))
    expect(gw.shown).toHaveLength(1)
    expect(h.store.scan('inbox/')).toHaveLength(1)
  })

  it('keeps delivering nothing and shows the state when the platform answers NOT_PAIRED to a send', async () => {
    const { h, gw, channel } = await setup()
    gw.port.send = async () => {
      throw new ChannelRefusal('NOT_PAIRED', 'NOT_PAIRED')
    }
    await expect(channel.deliver(outbound('k1'))).rejects.toThrow()
    expect(channel.status()).toBe(STATUS.notPaired)
    enqueueMessage({ store: h.store, at: h.now(), limits: LIMITS, workspaces: ['api'] }, { deliveryKey: 'late:1', text: '结果', taskIds: [] })
    await h.tick()
    expect(h.store.get('outbox/late:1').sentAt).toBeNull()
  })

  it('drops inbound and fails delivery while the paired channel is stopped, and resumes when it runs again', async () => {
    const { gw, channel } = await setup()
    gw.setRunning(false)
    expect(await channel.receive(gw.message('在吗'))).toMatchObject({ kind: 'dropped', reason: STATUS.notRunning })
    await expect(channel.deliver(outbound('k-stopped'))).rejects.toThrow(STATUS.notRunning)
    gw.setRunning(true)
    expect((await channel.receive(gw.message('又在了'))).kind).toBe('accepted')
    expect(channel.status()).toBeNull()
    expect(gw.shown).toHaveLength(0)
  })
})
