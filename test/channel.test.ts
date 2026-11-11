import { describe, expect, it } from 'vitest'
import { CHANNEL_TITLES, CHOICE_POINTER, compose, openChannel, showLinks, STATUS } from '../channel.mjs'
import { ChannelRefusal } from '../channel-targets.mjs'
import { LIMITS } from '../limits.mjs'
import { enqueueMessage, label } from '../tasks.mjs'
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
    const card = gw.shown.find((m) => m.title === CHANNEL_TITLES.choice)!
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

  it('sends a choice card as one button per task and one for a new task, with no list in the text', async () => {
    const { h, gw, channel } = await setup()
    const a = await h.create('修首页标题', 'api')
    const b = await h.create('补登录测试', 'web')
    await channel.deliver({ deliveryKey: 'c1', text: '接到哪个？', detail: null, card: { options: [{ taskId: a, title: '修首页标题' }, { taskId: b, title: '补登录测试' }], allowNew: true } })
    expect(gw.inputs.at(-1)).toEqual({
      deliveryKey: 'c1',
      title: CHANNEL_TITLES.choice,
      text: `接到哪个？\n\n点按钮选择，或直接回复你的意思。`,
      actions: [
        { id: `pick:${a}`, label: `${a} 修首页标题` },
        { id: `pick:${b}`, label: `${b} 补登录测试` },
        { id: 'pick:new', label: '新建任务' },
      ],
    })
  })

  it('falls back to the numbered list and the AGH page when the buttons would not fit one card', () => {
    const options = Array.from({ length: 6 }, (_, i) => ({ taskId: `T-000${i + 1}`, title: `任务${i + 1}` }))
    const sent = compose({ deliveryKey: 'k', text: '接到哪个？', detail: null, card: { options, allowNew: true } }, 4000)
    expect(sent.actions).toBeUndefined()
    expect(sent.text.endsWith(`7. 新建任务\n${CHOICE_POINTER}`)).toBe(true)
  })

  it('cuts the body, never the tail, and never exceeds the text limit', () => {
    const card = { options: [{ taskId: 'T-1', title: '甲' }], allowNew: false }
    const long = { deliveryKey: 'k', text: '字'.repeat(500), detail: '细'.repeat(500), card }
    const sent = compose(long, 120)
    expect(sent.text.length).toBeLessThanOrEqual(120)
    expect(sent.text.endsWith('点按钮选择，或直接回复你的意思。')).toBe(true)
    expect(sent.text).toContain('…')
    for (const limit of [1, 2, 5, 30, 61, 200]) expect(compose(long, limit).text.length).toBeLessThanOrEqual(limit)
    expect(compose(plain('短'), 4000)).toEqual({ title: CHANNEL_TITLES.message, text: '短' })
  })

  it('rewrites a Markdown link in worker content so the real address shows, and leaves the judge text alone', { timeout: 1000 }, () => {
    expect(showLinks('看 [这里](https://evil.example/x) 和 [https://ok.example](https://ok.example)')).toBe('看 这里（https://evil.example/x） 和 https://ok.example')
    expect(showLinks('![图](https://a.example/p.png) [w](https://a.example/A_(b) "t") [](https://b.example)')).toBe('图（https://a.example/p.png） w（https://a.example/A_(b)） https://b.example')
    expect(showLinks('没有链接 [a] (b) 和 `code`')).toBe('没有链接 [a] (b) 和 `code`')
    for (const input of ['[a\\]b](https://evil.invalid)', '[a][r]\n\n[r]: https://evil.invalid', '[a]\n[r]: https://evil.invalid']) expect(showLinks(input)).not.toMatch(/\]\(|\]\[|\]:/)
    const sent = compose({ deliveryKey: 'k', text: '标题 [判断](https://j.example)', detail: '[点我](https://evil.example)', card: null }, 4000)
    expect(sent.text).toBe('标题 [判断](https://j.example)\n\n点我（https://evil.example）')
    for (const tail of ['', '](https://x.invalid)']) expect(showLinks('['.repeat(100000) + tail)).not.toMatch(/\]\(/)
  })

  it('rewrites links in every worker-influenced string, including the numbered fallback lists', () => {
    const evil = '[选我](https://evil.example)'
    const ask = compose({ deliveryKey: 'k', text: '问', detail: '问题', card: null, ask: { options: [evil, 'b'.repeat(50)], at: 't' } }, 4000)
    expect(ask.text).toContain('1. 选我（https://evil.example）')
    expect(ask.text).not.toContain('](')
    const options = Array.from({ length: 6 }, (_, i) => ({ taskId: `T-000${i + 1}`, title: i === 0 ? evil : `任务${i}` }))
    const card = compose({ deliveryKey: 'k', text: '接到哪个？', detail: null, card: { options, allowNew: true } }, 4000)
    expect(card.text).toContain('1. 选我（https://evil.example）')
    expect(card.text).not.toContain('](')
  })

  it('does not split an emoji when it cuts', () => {
    const { text } = compose(plain('😀'.repeat(50)), 24)
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

describe('chat channel buttons', () => {
  const OPTIONS = ['方案一，北京天气走公开接口', '方案二，只做每日提醒', '方案三，先不做']

  /** A choice card about one message, sent through the gateway. */
  async function cardFor(ctx: Awaited<ReturnType<typeof setup>>) {
    const { h, gw, channel } = ctx
    const a = await h.create('任务甲', 'api')
    h.setJudge(({ batch }) => decisions({ kind: 'ask', message: batch[0]!.id, candidates: [a] }))
    const original = gw.message('那个也改一下')
    await channel.receive(original)
    await h.tick()
    const card = gw.shown.find((m) => m.title === CHANNEL_TITLES.choice)!
    return { a, original, card }
  }

  async function question(ctx: Awaited<ReturnType<typeof setup>>, options: string[] = OPTIONS, workspace = 'api') {
    const { h, gw } = ctx
    const id = await h.create('新建一个北京天气查询任务', workspace)
    const sid = h.sessionOf(id)
    expect(h.engine.askOwner(sid, { text: '怎么做？', options }).ok).toBe(true)
    h.sessions.finish(sid, 'completed', '我把问题交给伴侣了')
    await h.tick()
    const sent = gw.shown.find((m) => m.deliveryKey.startsWith('ask:'))!
    return { id, sid, sent }
  }

  it('sends a worker question with one button per option and no numbered list', async () => {
    const ctx = await setup()
    const { id, sent } = await question(ctx)
    expect(ctx.gw.inputs.find((i) => i.deliveryKey === sent.deliveryKey)).toEqual({
      deliveryKey: sent.deliveryKey,
      title: CHANNEL_TITLES.message,
      text: `${label(ctx.h.task(id))}：等你回答\n\n怎么做？`,
      actions: OPTIONS.map((option, i) => ({ id: `answer:${i + 1}`, label: option })),
    })
  })

  it('lists the options in full when a button label has to cut one', async () => {
    const ctx = await setup()
    const long = '很'.repeat(60)
    const { sent } = await question(ctx, ['短的', long])
    expect(sent.actions!.map((a) => a.label)).toEqual(['短的', `${'很'.repeat(39)}…`])
    expect(sent.text.endsWith(`1. 短的\n2. ${long}`)).toBe(true)
  })

  it('turns a click on a card button into the choice, attaching the original message to the task', async () => {
    const ctx = await setup()
    const { a, original, card } = await cardFor(ctx)
    expect(card.actions!.map((x) => x.id)).toEqual([`pick:${a}`, 'pick:new'])
    const click = ctx.gw.click(card.messageId, `pick:${a}`)
    expect(await ctx.channel.receive(click)).toMatchObject({ kind: 'accepted', key: inboxKey(click.eventId) })
    await ctx.h.tick()
    expect(ctx.h.store.get(inboxKey(click.eventId)).signal).toMatchObject({ kind: 'choice', card: card.deliveryKey, pick: a, origin: 'owner' })
    expect(ctx.h.entry(inboxKey(original.eventId)).disposition).toMatchObject({ kind: 'appended', taskIds: [a] })
    const again = ctx.gw.click(card.messageId, 'pick:new')
    await ctx.channel.receive(again)
    await ctx.h.tick()
    expect(ctx.h.entry(inboxKey(again.eventId)).disposition).toMatchObject({ kind: 'rejected' })
  })

  it('sends the original message to the judge as a new task on pick:new', async () => {
    const ctx = await setup()
    const { original, card } = await cardFor(ctx)
    const click = ctx.gw.click(card.messageId, 'pick:new')
    await ctx.channel.receive(click)
    await ctx.h.tick()
    expect(ctx.h.store.get(inboxKey(click.eventId)).newFrom).toBe(`${inboxKey(original.eventId)}`)
  })

  it('turns a click on a question button into an owner message to that task, replying to it', async () => {
    const ctx = await setup()
    const { id, sid, sent } = await question(ctx)
    const judged = ctx.h.judgeInputs.length
    const click = ctx.gw.click(sent.messageId, 'answer:2')
    await ctx.channel.receive(click)
    await ctx.h.tick()
    expect(ctx.h.store.get(inboxKey(click.eventId)).signal).toMatchObject({ kind: 'message', origin: 'owner', replyTo: id, text: '2' })
    expect(ctx.h.judgeInputs.length).toBe(judged)
    expect(ctx.h.sessions.sessions.get(sid)!.inputs.at(-1)).toContain('2')
    expect(ctx.h.task(id)).toMatchObject({ state: 'running', question: null })
    const stale = ctx.gw.click(sent.messageId, 'answer:1')
    expect(await ctx.channel.receive(stale)).toMatchObject({ kind: 'dropped', reason: expect.stringContaining('no longer waiting') })
  })

  it('attaches a typed quote of a worker question to that task without the judge', async () => {
    const ctx = await setup()
    const { id, sent } = await question(ctx)
    const judged = ctx.h.judgeInputs.length
    const reply = ctx.gw.message('先做方案二', { quotedMessageId: sent.messageId })
    await ctx.channel.receive(reply)
    await ctx.h.tick()
    expect(ctx.h.judgeInputs.length).toBe(judged)
    expect(ctx.h.entry(inboxKey(reply.eventId)).disposition).toMatchObject({ kind: 'appended', taskIds: [id] })
  })

  it('drops a click whose action is not an option of that message, or whose message is not in the outbox', async () => {
    const ctx = await setup()
    const { card } = await cardFor(ctx)
    const { sent } = await question(ctx, OPTIONS, 'web')
    const before = ctx.h.store.scan('inbox/').length
    const cases = [
      ctx.gw.click(card.messageId, 'pick:T-9999'),
      ctx.gw.click(card.messageId, 'answer:1'),
      ctx.gw.click(card.messageId, 'confirm'),
      ctx.gw.click(sent.messageId, 'pick:new'),
      ctx.gw.click(sent.messageId, 'answer:4'),
      ctx.gw.click(sent.messageId, 'answer:0'),
      ctx.gw.click(sent.messageId, 'answer:1x'),
      ctx.gw.click('om-unknown', 'pick:new'),
    ]
    for (const click of cases) expect(await ctx.channel.receive(click)).toMatchObject({ kind: 'dropped' })
    expect(ctx.h.store.scan('inbox/')).toHaveLength(before)
  })

  it('drops a click from a stranger, from another chat or from another pairing', async () => {
    const ctx = await setup()
    const { a, card } = await cardFor(ctx)
    const before = ctx.h.store.scan('inbox/').length
    const cases = [
      ctx.gw.click(card.messageId, `pick:${a}`, { sender: ctx.gw.stranger }),
      ctx.gw.click(card.messageId, `pick:${a}`, { chat: { id: 'dm-other', type: 'dm' } }),
      ctx.gw.click(card.messageId, `pick:${a}`, { pairingId: 'f'.repeat(32) }),
    ]
    for (const click of cases) expect(await ctx.channel.receive(click)).toMatchObject({ kind: 'dropped', reason: 'not from the owner' })
    expect(ctx.h.store.scan('inbox/')).toHaveLength(before)
  })
})
