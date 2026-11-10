import { describe, expect, it } from 'vitest'
import { CHANNEL_TITLES, openChannel } from '../channel.mjs'
import { LIMITS } from '../limits.mjs'
import { enqueueMessage } from '../tasks.mjs'
import { OWNER, fakeGateway } from './fake-gateway.js'
import { decisions, harness, SETTINGS } from './harness.js'

const inboxKey = (eventId: string) => `inbox/channel:im-1:${eventId}`

async function setup() {
  const gw = fakeGateway()
  let channel: any
  const h = harness({ channel: { deliver: (m) => channel.deliver(m) } })
  const opened = await openChannel({ settings: SETTINGS, gateway: gw.port, store: h.store, receive: (s: unknown) => h.engine.receive(s) })
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
      await channel.receive(gw.click('om-1', 'pick:new', { sender: gw.stranger })),
    ]
    expect(results.map((r) => r.kind)).toEqual(['dropped', 'dropped', 'dropped'])
    expect(h.store.scan('inbox/')).toEqual([])
    await h.tick()
    expect(h.judgeInputs).toEqual([])
  })

  it('refuses an event that does not match the contract shape', async () => {
    const { h, gw, channel } = await setup()
    const { sender: _sender, ...noSender } = gw.message('hi')
    expect((await channel.receive(noSender)).kind).toBe('invalid')
    expect((await channel.receive({ ...gw.message('hi'), eventId: 'x'.repeat(129) })).kind).toBe('invalid')
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
    const card = gw.shown.find((m) => m.message.blocks[0].actions)!
    h.setJudge(({ batch }) => decisions({ kind: 'answer', message: batch[0]!.id, text: '好的' }))
    const typed = gw.message('是的', { quotedMessageId: card.messageId })
    await channel.receive(typed)
    await h.tick()
    expect(h.judgeInputs.at(-1)!.batch[0]).toMatchObject({ id: inboxKey(typed.eventId), candidates: [a] })
  })
})

describe('chat channel card buttons', () => {
  it('turns a click on a choice card into the owner pick', async () => {
    const { h, gw, channel } = await setup()
    const a = await h.create('任务甲', 'api')
    h.setJudge(({ batch }) => decisions({ kind: 'ask', message: batch[0]!.id, candidates: [a] }))
    await channel.receive(gw.message('那个也改一下'))
    await h.tick()
    const card = gw.shown.find((m) => m.message.blocks[0].actions)!
    expect(card.message.blocks[0].actions.map((x: any) => x.id)).toEqual([`pick:${a}`, 'pick:new'])
    const click = gw.click(card.messageId, `pick:${a}`)
    expect((await channel.receive(click)).kind).toBe('accepted')
    await h.tick()
    expect(h.entry(inboxKey(click.eventId)).disposition).toMatchObject({ kind: 'control', taskIds: [a] })
  })

  it('drops a click on a card the companion did not send or with an action it did not render', async () => {
    const { h, gw, channel, shownFor } = await setup()
    const a = await h.create('任务甲', 'api')
    const ack = shownFor(a).at(-1)!
    const results = [
      await channel.receive(gw.click('om-unknown', `pick:${a}`)),
      await channel.receive(gw.click(ack.messageId, `pick:${a}`)),
      await channel.receive(gw.click(ack.messageId, `stop:${a}`)),
    ]
    expect(results.map((r) => r.kind)).toEqual(['dropped', 'dropped', 'dropped'])
    await h.tick()
    expect(h.task(a).state).not.toBe('abandoned')
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

  it('does not resend while a delivery is still pending at the gateway', async () => {
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

  it('titles every message with fixed generic text and keeps task content in the body', async () => {
    const { h, gw, channel } = await setup()
    const a = await h.create('修首页标题', 'api')
    await channel.deliver({ deliveryKey: 'c1', text: '接到哪个？', detail: null, card: { options: [{ taskId: a, title: '修首页标题' }], allowNew: true } })
    await channel.deliver(outbound('t1'))
    expect(gw.shown.length).toBeGreaterThan(2)
    for (const { message } of gw.shown) {
      expect(Object.keys(message)).toEqual(['blocks'])
      expect(message.blocks).toHaveLength(1)
      expect(message.blocks[0].kind).toBe('card')
      expect(Object.values(CHANNEL_TITLES)).toContain(message.blocks[0].title)
    }
    expect(gw.shown.at(-1)!.message.blocks[0].body).toContain('改了 src/app.ts')
  })
})

describe('chat channel setup', () => {
  it('refuses to run with a clear status when the channel instance is missing or unusable', async () => {
    const h = harness()
    const receive = () => ({ kind: 'invalid' })
    const open = (settings: typeof SETTINGS, gw = fakeGateway()) => openChannel({ settings, gateway: gw.port, store: h.store, receive })
    expect(await open({ ...SETTINGS, channelInstance: '' })).toEqual({ ok: false, status: 'channelInstance is not set' })
    expect(await open({ ...SETTINGS, channelInstance: 'Bad Name' })).toMatchObject({ ok: false, status: expect.stringContaining('not a channel instance id') })
    expect(await open({ ...SETTINGS, channelInstance: 'im-2' })).toMatchObject({ ok: false, status: expect.stringContaining('not available') })
    expect(await open(SETTINGS, fakeGateway({ running: false }))).toMatchObject({ ok: false, status: expect.stringContaining('not running') })
    expect(await open(SETTINGS, fakeGateway({ owner: null }))).toMatchObject({ ok: false, status: expect.stringContaining('no bound owner') })
  })

  it('exposes the owner conversation a worker session binds to, and nothing about approvals', async () => {
    const { channel } = await setup()
    expect(await channel.binding()).toEqual({ instanceId: 'im-1', targetId: OWNER.targetId })
  })
})

describe('chat channel owner changes while running', () => {
  const outbound = (deliveryKey: string) => ({ deliveryKey, text: 'T-0001 修首页标题：完成', detail: '改了 src/app.ts', card: null })

  it('drops a message from the owner sender in a chat other than the owner chat', async () => {
    const { h, gw, channel } = await setup()
    const result = await channel.receive(gw.message('帮我看看登录页', { chat: { id: 'dm-other', type: 'dm' } }))
    expect(result).toMatchObject({ kind: 'dropped' })
    expect(h.store.scan('inbox/')).toEqual([])
  })

  it('refuses everything after a rebind, to the old owner and the new one, and says a restart is needed', async () => {
    const { h, gw, channel } = await setup()
    const id = await h.create('修首页标题')
    const shownBefore = gw.shown.length
    const inboxBefore = h.store.scan('inbox/').length
    gw.rebind(gw.nextOwner)

    const fromOld = await channel.receive(gw.message('继续'))
    const fromNew = await channel.receive(gw.message('我是新主人', { sender: { userId: gw.nextOwner.userId }, chat: { id: gw.nextOwner.chatId, type: 'dm' } }))
    expect(fromOld).toMatchObject({ kind: 'dropped' })
    expect(fromNew).toMatchObject({ kind: 'dropped', reason: expect.stringContaining('rebound') })
    expect(h.store.scan('inbox/')).toHaveLength(inboxBefore)

    await expect(channel.deliver(outbound('after-rebind'))).rejects.toThrow(/rebound/)
    await expect(channel.binding()).rejects.toThrow(/rebound/)
    enqueueMessage({ store: h.store, at: h.now(), limits: LIMITS, workspaces: ['api'] }, { deliveryKey: 'late:1', text: '结果', taskIds: [id] })
    await h.tick()
    expect(gw.shown).toHaveLength(shownBefore)
    expect(gw.shown.filter((m) => m.chatId === OWNER.chatId)).toHaveLength(shownBefore)
    expect(h.store.get('outbox/late:1').sentAt).toBeNull()
    expect(channel.status()).toMatch(/rebound.*restart/)
  })

  it('treats a change of any one owner field as a rebind', async () => {
    const { gw, channel } = await setup()
    gw.rebind({ ...OWNER, userId: 'u-other' })
    expect(await channel.receive(gw.message('继续'))).toMatchObject({ kind: 'dropped', reason: expect.stringContaining('rebound') })
    gw.rebind({ ...OWNER, chatId: 'dm-new' })
    await expect(channel.deliver(outbound('k-chat'))).rejects.toThrow(/rebound/)
    gw.rebind({ ...OWNER, targetId: 'c'.repeat(32) })
    await expect(channel.binding()).rejects.toThrow(/rebound/)
    expect(gw.shown).toHaveLength(0)
  })

  it('drops inbound and fails delivery while the instance is stopped or removed, and resumes when it runs again', async () => {
    const { h, gw, channel } = await setup()
    expect(channel.status()).toBeNull()
    for (const [change, status] of [[() => gw.setRunning(false), /not running/], [() => gw.rebind(null), /no bound owner/]] as const) {
      change()
      expect(await channel.receive(gw.message('在吗'))).toMatchObject({ kind: 'dropped', reason: expect.stringMatching(status) })
      await expect(channel.deliver(outbound(`k-${String(status)}`))).rejects.toThrow(status)
      expect(channel.status()).toMatch(status)
      gw.setRunning(true)
      gw.rebind(OWNER)
    }
    expect((await channel.receive(gw.message('又在了'))).kind).toBe('accepted')
    expect(channel.status()).toBeNull()

    gw.remove()
    expect(await channel.receive(gw.message('在吗'))).toMatchObject({ kind: 'dropped', reason: expect.stringContaining('not available') })
    await expect(channel.deliver(outbound('k-removed'))).rejects.toThrow(/not available/)
    await expect(channel.binding()).rejects.toThrow(/not available/)
    expect(gw.shown).toHaveLength(0)
    expect(h.store.scan('inbox/')).toHaveLength(1)
  })
})
