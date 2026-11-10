import { describe, expect, it } from 'vitest'
import { assertLocalOwner, buildDesk, DESK_CAPABILITIES, deskServices, submitDesk } from '../desk.mjs'
import { platformSessions } from '../platform-sessions.mjs'
import { decisions, harness } from './harness.js'

type H = ReturnType<typeof harness>
const DAY = 24 * 60 * 60 * 1000

function deskOf(h: H, extra: Record<string, unknown> = {}) {
  const sessions = platformSessions(h.sessions.port)!
  const deps = () =>
    ({
      engine: h.engine,
      store: h.store,
      limits: h.limits,
      now: h.now,
      status: { running: true, problems: [] },
      sessions,
      prRepo: () => undefined,
      workspaces: ['api', 'web'],
      ...extra,
    }) as never
  return {
    view: (input?: { taskId?: string }) => buildDesk(deps(), input) as Promise<any>,
    submit: (input: Record<string, unknown>, operationId: string) => submitDesk(deps(), input, operationId) as any,
  }
}

/** The owner at the desk says something and the judge, scripted, answers. */
async function ask(h: H, desk: ReturnType<typeof deskOf>, text: string, op: string) {
  expect(desk.submit({ kind: 'message', text }, op)).toEqual({ ok: true, result: 'accepted' })
  await h.tick()
}

const PR = 'https://git.example.test/org/api/pull/12'
const published = (prUrl = PR) => JSON.stringify({ status: 'published', prUrl, branch: 'companion/x', commit: 'abc', remote: 'https://git.example.test/org/api.git', files: ['a.txt'] })

describe('PR link from the publish tool result', () => {
  const taskRepo = (task: any) => task.repo ?? undefined

  it('writes prUrl and repo once publish is done, and the desk then links it', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    const call = h.sessions.call(sid, 'publish')
    await h.tick()
    expect(h.task(id)).toMatchObject({ prUrl: null, repo: null })
    h.restart()
    h.sessions.resolve(sid, call, published())
    await h.tick()
    expect(h.task(id)).toMatchObject({ prUrl: PR, repo: 'git.example.test/org/api' })
    const row = (await deskOf(h, { prRepo: taskRepo }).view()).tasks.running[0]
    expect(row).toMatchObject({ prUrl: PR, prLink: PR })
    h.restart()
    await h.tick()
    expect(h.task(id)).toMatchObject({ prUrl: PR, repo: 'git.example.test/org/api' })
  })

  it('writes both when the result is already there the first time the call is seen', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    h.sessions.resolve(sid, h.sessions.call(sid, 'publish'), published())
    await h.tick()
    expect(h.task(id)).toMatchObject({ prUrl: PR, repo: 'git.example.test/org/api' })
  })

  it.each([
    ['a refusal', JSON.stringify({ status: 'refused', reason: 'no-human-approval' }), true],
    ['a result with no output', '', false],
    ['text that is not JSON', `done: ${PR}`, false],
    ['a URL that is not a pull request page', published('https://git.example.test/org/api/pull/12/files'), false],
    ['a URL on a plain http page', published('http://git.example.test/org/api/pull/12'), false],
  ])('%s writes nothing', async (_name, text, isError) => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessions.call(h.sessionOf(id), 'publish')
    h.sessions.resolve(h.sessionOf(id), sid, text, isError)
    await h.tick()
    expect(h.task(id)).toMatchObject({ prUrl: null, repo: null })
  })

  it('reads only the publish tool', async () => {
    const h = harness()
    const id = await h.create('修登录')
    h.sessions.resolve(h.sessionOf(id), h.sessions.call(h.sessionOf(id), 'shell'), published())
    await h.tick()
    expect(h.task(id)).toMatchObject({ prUrl: null, repo: null })
  })
})

describe('companion.desk query', () => {
  it('groups tasks as the page shows them and carries what each row needs', async () => {
    const h = harness()
    const desk = deskOf(h)
    // api: a finished, a failed, an abandoned and a paused task, then one running with two queued behind it.
    const done = await h.create('改文档')
    h.sessions.finish(h.sessionOf(done), 'completed', '改好了')
    await h.tick()
    const failed = await h.create('修构建')
    h.sessions.finish(h.sessionOf(failed), 'failed')
    await h.tick()
    const stopped = await h.create('加缓存')
    await h.signal({ kind: 'button', action: 'stop', taskId: stopped })
    await h.tick()
    const paused = await h.create('升依赖')
    h.sessions.lose(h.sessionOf(paused))
    await h.tick()
    const running = await h.create('修登录')
    const queuedA = await h.create('加日志')
    const queuedB = await h.create('加指标')
    // web: one task waiting on an approval, one behind it.
    const waiting = await h.create('改样式', 'web')
    h.sessions.emit(h.sessionOf(waiting), { kind: 'approval', state: 'pending' })
    await h.tick()
    const behind = await h.create('改图标', 'web')
    const view = await desk.view()
    const ids = (list: any[]) => list.map((t) => t.id)
    expect(ids(view.tasks.needsYou)).toEqual([waiting])
    expect(view.tasks.needsYou[0]).toMatchObject({ state: 'waiting', wait: 'approval', sessionState: 'ok', session: { flags: ['waitingOnApproval'] } })
    expect(ids(view.tasks.running)).toEqual([running])
    expect(view.tasks.queued).toEqual([
      { workspace: 'api', tasks: [expect.objectContaining({ id: queuedA, queue: { holder: running, position: 1 } }), expect.objectContaining({ id: queuedB, queue: { holder: running, position: 2 } })] },
      { workspace: 'web', tasks: [expect.objectContaining({ id: behind, queue: { holder: waiting, position: 1 } })] },
    ])
    expect(ids(view.tasks.paused)).toEqual([paused])
    expect(view.tasks.paused[0]).toMatchObject({ reason: 'sessionLost', sessionState: 'missing', session: null })
    expect(ids(view.tasks.recent).sort()).toEqual([done, failed].sort())
    expect(ids(view.tasks.older)).toEqual([stopped])
    expect(view.workspaces).toEqual(['api', 'web'])
    expect(view).toMatchObject({ running: true, canSubmit: true, submitBlock: null, problems: [], sessionsReadable: true })
    // A question is told from an approval by the session's flag.
    h.sessions.set(h.sessionOf(waiting), { kind: 'active', flags: ['waitingOnUserInput'] })
    expect((await desk.view()).tasks.needsYou[0].wait).toBe('question')
    h.sessions.lose(h.sessionOf(waiting))
    expect((await desk.view()).tasks.needsYou[0]).toMatchObject({ wait: 'unreadable', sessionState: 'missing' })
    // Ended tasks leave "recent results" after 7 days and then sit in the collapsed group.
    h.advance(8 * DAY)
    const later = await desk.view()
    expect(ids(later.tasks.recent)).toEqual([])
    expect(ids(later.tasks.older).sort()).toEqual([done, failed, stopped].sort())
    expect(later.tasks.olderTotal).toBe(3)
  })

  it('never shows the v1b states', async () => {
    const h = harness()
    const desk = deskOf(h)
    const a = await h.create('修登录')
    const b = await h.create('加日志')
    h.store.putTask({ ...h.task(a), state: 'proposed' })
    h.store.putTask({ ...h.task(b), state: 'expired', endedAt: h.now() })
    const view = await desk.view()
    const shown = Object.values(view.tasks).flat().flatMap((g: any) => (g.tasks ? g.tasks : [g]))
    expect(shown.filter((t: any) => t && t.id)).toEqual([])
  })

  it('reports usage the engine has, unknown as null and never as 0', async () => {
    const h = harness()
    const desk = deskOf(h)
    const id = await h.create('修登录')
    h.sessions.setUsage(h.sessionOf(id), { tokens: null, cost: null })
    await h.tick()
    let view = await desk.view()
    expect(view.tasks.running[0].usage).toEqual({ tokens: null, cost: null })
    expect(view.usage.top).toEqual([{ id, tokens: null, cost: null }])
    expect(view.usage.today).toMatchObject({ date: '2026-11-10', basis: 'UTC', unknown: true })
    h.sessions.setUsage(h.sessionOf(id), { tokens: 120, cost: 0.4 })
    await h.tick()
    view = await desk.view()
    expect(view.tasks.running[0].usage).toEqual({ tokens: 120, cost: 0.4 })
    expect(view.usage).toMatchObject({ today: { tokens: 120, cost: 0.4, unknown: true }, caps: { dailyCost: null, taskCost: null, taskTokens: null, maxHops: 8 } })
    // A day with no report is absent, not a zero.
    h.advance(DAY)
    expect((await desk.view()).usage.today).toBeNull()
  })

  it('links a PR only when it is a pull request page of the task\'s repository', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const link = async (prUrl: string | null, repo: string | undefined) => {
      h.store.putTask({ ...h.task(id), prUrl })
      const view = await deskOf(h, { prRepo: () => repo }).view()
      return view.tasks.running[0]
    }
    expect(await link('https://git.example.test/org/api/pull/12', 'git.example.test/org/api')).toMatchObject({ prLink: 'https://git.example.test/org/api/pull/12' })
    expect(await link('https://GIT.example.test/Org/API/pull/12', 'git.example.test/org/api')).toMatchObject({ prLink: 'https://GIT.example.test/Org/API/pull/12' })
    for (const bad of [
      'https://evil.example.test/org/api/pull/12',
      'https://git.example.test/org/api/pull/12/files',
      'https://git.example.test/org/api/pull/0',
      'https://git.example.test/org/api2/pull/12',
      'http://git.example.test/org/api/pull/12',
      'javascript:alert(1)//git.example.test/org/api/pull/12',
    ]) {
      const row = await link(bad, 'git.example.test/org/api')
      expect(row.prUrl).toBe(bad)
      expect(row.prLink).toBeNull()
    }
    // No known repository: fail closed.
    expect((await link('https://git.example.test/org/api/pull/12', undefined)).prLink).toBeNull()
    expect((await link(null, 'git.example.test/org/api')).prLink).toBeNull()
  })

  it('lists unanswered choice cards with the handed-back ones told apart, and drops answered ones', async () => {
    const h = harness()
    const desk = deskOf(h)
    const one = await h.create('修登录')
    const two = await h.create('改样式', 'web')
    h.setJudge(({ batch }) => decisions({ kind: 'ask', message: batch[0]!.id, candidates: [one, two] }))
    await ask(h, desk, '再改一下', 'op-1')
    let view = await desk.view()
    expect(view.cards).toHaveLength(1)
    expect(view.cards[0]).toMatchObject({
      kind: 'ask',
      original: '再改一下',
      options: [{ taskId: one }, { taskId: two }],
      allowNew: true,
      sentAt: expect.any(String),
    })
    expect(view.messages).toMatchObject([{ key: 'inbox/desk:op-1', text: '再改一下', state: 'asked', taskIds: [one, two] }])
    expect(desk.submit({ kind: 'choice', card: view.cards[0].key, pick: one }, 'op-2')).toEqual({ ok: true, result: 'accepted' })
    // Answered, though the engine has not yet processed it: the card is no longer offered.
    expect((await desk.view()).cards).toEqual([])
    await h.tick()
    expect((await desk.view()).cards).toEqual([])
  })

  it('gives a task\'s detail on request: the frozen brief, the last reply and the record', async () => {
    const h = harness()
    const desk = deskOf(h)
    const id = await h.create('修登录\n<img src=x onerror=alert(1)>', 'api', '修登录')
    h.sessions.finish(h.sessionOf(id), 'completed', '改好了 <b>bold</b>')
    await h.tick()
    const view = await desk.view({ taskId: id })
    expect(view.detail).toMatchObject({
      id,
      brief: '修登录\n<img src=x onerror=alert(1)>',
      briefHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      note: '改好了 <b>bold</b>',
    })
    expect(view.detail.events.map((e: any) => e.kind)).toEqual(['created', 'state', 'state'])
    expect((await desk.view({ taskId: 'T-9999' })).detail).toBeUndefined()
  })

  it('shows one status and no tasks when the engine is not there', async () => {
    const h = harness()
    await h.create('修登录')
    const problems = [{ kind: 'settings', missing: ['ownerName'], text: 'settings to fill in: ownerName' }]
    const view = await buildDesk({ engine: null, store: h.store, limits: h.limits, now: h.now, status: { running: false, problems }, sessions: null, prRepo: () => undefined, workspaces: [] } as never)
    expect(view).toMatchObject({ running: false, canSubmit: false, submitBlock: 'not-running', problems })
    expect(view.tasks.running).toEqual([])
    expect(view.cards).toEqual([])
  })

  it('turns the composer off for a rebound channel and a full store, but not for a missing channel', async () => {
    const h = harness()
    const block = async (problems: unknown[], limits = h.limits) => (await deskOf(h, { status: { running: true, problems }, limits }).view()).submitBlock
    expect(await block([{ kind: 'channel', text: 'the chat channel gateway is not available on this platform' }])).toBeNull()
    expect(await block([{ kind: 'channel', text: 'channel instance im-1 was rebound to another owner; restart the companion service to serve the new owner' }])).toBe('rebound')
    expect(await block([], { ...h.limits, storeRefuseRatio: 0 })).toBe('store-full')
  })
})

describe('companion.submit', () => {
  it('a desk message takes the same route as the same text from the chat', async () => {
    const script = ({ batch }: any) => decisions({ kind: 'create', messages: [batch[0].id], workspace: 'api', title: '修登录' })
    const chat = harness({ judge: script })
    const desk = harness({ judge: script })
    await chat.say('给 api 仓修登录报错')
    await chat.tick()
    deskOf(desk).submit({ kind: 'message', text: '给 api 仓修登录报错' }, 'op-1')
    await desk.tick()
    const strip = ({ origin, ...task }: any) => task
    expect(desk.tasks().map(strip)).toEqual(chat.tasks().map(strip))
    expect(desk.tasks()[0].origin.inbox).toEqual(['inbox/desk:op-1'])
    expect(desk.channel.texts()).toEqual(chat.channel.texts())
    expect(desk.workers().map((s) => s.inputs)).toEqual(chat.workers().map((s) => s.inputs))
    expect(desk.judgeInputs.map((i) => i.batch.map((b) => ({ origin: b.origin, text: b.text })))).toEqual(chat.judgeInputs.map((i) => i.batch.map((b) => ({ origin: b.origin, text: b.text }))))
    expect(desk.entry('inbox/desk:op-1')).toMatchObject({ signal: { source: 'desk', eventId: 'op-1', origin: 'owner', kind: 'message' }, disposition: { kind: 'created' } })
  })

  it('routes a message that names a task or replies to one without the judge, as in the chat', async () => {
    const h = harness()
    const desk = deskOf(h)
    const id = await h.create('修登录')
    h.sessions.finish(h.sessionOf(id), 'completed', 'ok')
    await h.tick()
    const judged = h.judgeInputs.length
    expect(desk.submit({ kind: 'message', text: '再补一个单测', replyTo: id }, 'op-1')).toEqual({ ok: true, result: 'accepted' })
    await h.tick()
    expect(h.judgeInputs).toHaveLength(judged)
    expect(h.task(id).state).toBe('running')
    expect(h.sessions.sessions.get(h.sessionOf(id))!.inputs.at(-1)).toBe('再补一个单测')
  })

  it('a repeated operation id executes once, and says the same thing the second time', async () => {
    const h = harness()
    const desk = deskOf(h)
    const first = desk.submit({ kind: 'message', text: '给 api 仓修登录报错' }, 'op-1')
    expect(first).toEqual({ ok: true, result: 'accepted' })
    expect(desk.submit({ kind: 'message', text: '给 api 仓修登录报错' }, 'op-1')).toEqual({ ok: true, result: 'duplicate' })
    expect(h.store.scan('inbox/')).toHaveLength(1)
    await h.tick()
    expect(h.judgeInputs).toHaveLength(1)
    // After the engine has disposed it, a retry is still a duplicate, even for a choice whose card is now answered.
    expect(desk.submit({ kind: 'message', text: '给 api 仓修登录报错' }, 'op-1')).toEqual({ ok: true, result: 'duplicate' })
    const one = await h.create('修登录')
    const two = await h.create('改样式', 'web')
    h.setJudge(({ batch }) => decisions({ kind: 'ask', message: batch[0]!.id, candidates: [one, two] }))
    await ask(h, desk, '再改一下', 'op-2')
    const card = (await desk.view()).cards[0].key
    expect(desk.submit({ kind: 'choice', card, pick: one }, 'op-3')).toEqual({ ok: true, result: 'accepted' })
    await h.tick()
    expect(desk.submit({ kind: 'choice', card, pick: one }, 'op-3')).toEqual({ ok: true, result: 'duplicate' })
    expect(desk.submit({ kind: 'choice', card, pick: one }, 'op-4')).toMatchObject({ ok: false, code: 'card-answered' })
  })

  it('the reply to a desk message goes to the owner\'s chat through the outbox, and the desk shows it', async () => {
    const h = harness({ judge: ({ batch }) => decisions({ kind: 'answer', message: batch[0]!.id, text: '现在有 0 个任务' }) })
    const desk = deskOf(h)
    await ask(h, desk, '现在有几个任务？', 'op-1')
    expect(h.channel.texts()).toEqual(['现在有 0 个任务'])
    expect(h.store.get('outbox/answer:inbox/desk:op-1')).toMatchObject({ about: 'inbox/desk:op-1', sentAt: expect.any(String) })
    expect((await desk.view()).messages).toMatchObject([{ state: 'answered', replies: [{ text: '现在有 0 个任务', sent: true }] }])
  })

  describe('a choice card answered on the desk and in the chat', () => {
    async function card(h: H) {
      const desk = deskOf(h)
      const one = await h.create('修登录')
      const two = await h.create('改样式', 'web')
      h.setJudge(({ batch }) => decisions({ kind: 'ask', message: batch[0]!.id, candidates: [one, two] }))
      await ask(h, desk, '再改一下', 'op-ask')
      return { desk, one, two, key: (await desk.view()).cards[0].key as string }
    }
    const chatPick = (h: H, key: string, pick: string) => h.signal({ kind: 'choice', card: key, pick })

    it('the desk answers first: the chat answer is rejected and the desk answer takes effect', async () => {
      const h = harness()
      const { desk, one, two, key } = await card(h)
      expect(desk.submit({ kind: 'choice', card: key, pick: one }, 'op-pick')).toEqual({ ok: true, result: 'accepted' })
      h.advance(1000)
      const late = (await chatPick(h, key, two)) as { key: string }
      await h.tick()
      expect(h.store.get(`outbox/${key}`).chosen).toBe(one)
      expect(h.entry('inbox/desk:op-pick').disposition).toMatchObject({ kind: 'control', taskIds: [one] })
      expect(h.entry(late.key).disposition).toMatchObject({ kind: 'rejected' })
      expect(h.sessions.sessions.get(h.sessionOf(two))!.inputs).toHaveLength(1)
    })

    it('the chat answers first: the desk is refused at once, and a desk answer already waiting loses to it', async () => {
      const h = harness()
      const { desk, one, two, key } = await card(h)
      await chatPick(h, key, two)
      expect(desk.submit({ kind: 'choice', card: key, pick: one }, 'op-pick')).toMatchObject({ ok: false, code: 'card-answered' })
      await h.tick()
      expect(h.store.get(`outbox/${key}`).chosen).toBe(two)
      expect(h.store.get('inbox/desk:op-pick')).toBeUndefined()
      // Both signals landed before the engine ran, the chat's first and the desk's later (as a client that raced the check would send).
      const racing = harness()
      const r = await card(racing)
      await chatPick(racing, r.key, r.two)
      racing.advance(1000)
      racing.engine.receive({ source: 'desk', eventId: 'op-late', at: racing.now(), origin: 'owner', kind: 'choice', card: r.key, pick: r.one })
      await racing.tick()
      expect(racing.store.get(`outbox/${r.key}`).chosen).toBe(r.two)
    })

    it('whoever answered first wins even when the other source sorts first by key', async () => {
      const h = harness()
      const { one, two, key } = await card(h)
      // 'channel:' sorts before 'desk:', so a key-ordered engine would pick the chat's answer.
      h.engine.receive({ source: 'desk', eventId: 'op-early', at: h.now(), origin: 'owner', kind: 'choice', card: key, pick: one })
      h.advance(1000)
      h.engine.receive({ source: 'channel:im-1', eventId: 'ev-late', at: h.now(), origin: 'owner', kind: 'choice', card: key, pick: two })
      await h.tick()
      expect(h.store.get(`outbox/${key}`).chosen).toBe(one)
    })

    it('refuses a pick that is not on the card, a card that is gone, and the "new" pick works', async () => {
      const h = harness()
      const { desk, key } = await card(h)
      expect(desk.submit({ kind: 'choice', card: key, pick: 'T-9999' }, 'op-1')).toMatchObject({ ok: false, code: 'invalid' })
      expect(desk.submit({ kind: 'choice', card: 'card:nope:0', pick: 'new' }, 'op-2')).toMatchObject({ ok: false, code: 'unknown-card' })
      expect(desk.submit({ kind: 'choice', card: key, pick: 'new' }, 'op-3')).toEqual({ ok: true, result: 'accepted' })
    })
  })

  describe('stop and continue are the chat buttons', () => {
    it('stop drives the same rows as the chat button', async () => {
      const chat = harness()
      const desk = harness()
      const a = await chat.create('修登录')
      const b = await desk.create('修登录')
      await chat.signal({ kind: 'button', action: 'stop', taskId: a })
      await chat.tick()
      expect(deskOf(desk).submit({ kind: 'button', action: 'stop', taskId: b }, 'op-1')).toEqual({ ok: true, result: 'accepted' })
      await desk.tick()
      const record = (h: H, id: string) => ({
        state: h.task(id).state,
        events: h.store.readEvents(id).map((e: any) => [e.kind, e.data.event, e.data.from, e.data.to]),
        interrupted: h.sessions.sessions.get(h.sessionOf(id))!.ended,
        texts: h.channel.texts(),
      })
      expect(record(desk, b)).toEqual(record(chat, a))
      expect(record(desk, b).state).toBe('abandoned')
      expect(desk.entry('inbox/desk:op-1').disposition).toMatchObject({ kind: 'control', taskIds: [b] })
    })

    it('continue drives the same rows as the chat button', async () => {
      const make = async () => {
        const h = harness()
        const id = await h.create('修登录')
        h.sessions.lose(h.sessionOf(id))
        await h.tick()
        expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'sessionLost' })
        return { h, id }
      }
      const chat = await make()
      const desk = await make()
      await chat.h.signal({ kind: 'button', action: 'continue', taskId: chat.id })
      await chat.h.tick()
      expect(deskOf(desk.h).submit({ kind: 'button', action: 'continue', taskId: desk.id }, 'op-1')).toEqual({ ok: true, result: 'accepted' })
      await desk.h.tick()
      const record = ({ h, id }: typeof chat) => ({ state: h.task(id).state, generation: h.task(id).generation, workers: h.workers().map((s) => s.request.startKey) })
      expect(record(desk)).toEqual(record(chat))
      expect(record(desk)).toMatchObject({ state: 'running', generation: 1 })
    })

    it('a button that does not apply is told the way the chat tells it', async () => {
      const h = harness()
      const id = await h.create('修登录')
      deskOf(h).submit({ kind: 'button', action: 'continue', taskId: id }, 'op-1')
      await h.tick()
      expect(h.entry('inbox/desk:op-1').disposition).toMatchObject({ kind: 'rejected', taskIds: [id] })
      expect(h.channel.texts().at(-1)).toContain('这个操作不适用')
    })
  })

  it('refuses what is not a valid input, and every button the desk does not offer', async () => {
    const h = harness()
    const desk = deskOf(h)
    const id = await h.create('修登录')
    const before = h.store.scan('inbox/').length
    const code = (input: Record<string, unknown>) => desk.submit(input, `op-${Math.random()}`).code
    expect(code({ kind: 'message', text: '   ' })).toBe('invalid')
    expect(code({ kind: 'message', text: '好', replyTo: 'T-9999' })).toBe('unknown-task')
    expect(code({ kind: 'button', action: 'confirm', taskId: id })).toBe('invalid')
    expect(code({ kind: 'button', action: 'refuse', taskId: id })).toBe('invalid')
    expect(code({ kind: 'button', action: 'pause', taskId: id })).toBe('invalid')
    expect(code({ kind: 'button', action: 'stop', taskId: 'T-9999' })).toBe('unknown-task')
    expect(code({ kind: 'nope' })).toBe('invalid')
    expect(code({ kind: 'choice', card: 'x' })).toBe('invalid')
    expect(h.store.scan('inbox/')).toHaveLength(before)
    expect(submitDesk({ engine: null, store: h.store, now: h.now }, { kind: 'message', text: '在吗' }, 'op-x')).toMatchObject({ ok: false, code: 'not-running' })
  })

  it('the client cannot supply the source, event id or origin', () => {
    const schema = DESK_CAPABILITIES.submit.inputSchema
    expect(Object.keys(schema.properties).sort()).toEqual(['action', 'card', 'kind', 'pick', 'replyTo', 'taskId', 'text'])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.action.enum).toEqual(['continue', 'stop'])
  })
})

describe('who may call the desk', () => {
  const resource = async () => ({ desk: async () => ({ ok: 'desk' }), submit: (_: unknown, op: string) => ({ ok: true, op }) })
  const [query, effect] = deskServices(resource) as any[]
  const owner = { source: 'client-web', actor: { id: 'me', org: 'local', role: 'owner', deptPath: [], attrs: {} }, scope: { kind: 'profile', profileId: 'p', activationId: 'a' } }
  const call = { ...owner, admission: { operationId: 'op-1' } }

  it('answers the owner on the local Web', async () => {
    expect(() => assertLocalOwner(owner as never)).not.toThrow()
    expect(await query.handler({}, owner)).toEqual({ ok: 'desk' })
    expect(await effect.handler({ kind: 'message', text: 'hi' }, call)).toEqual({ ok: true, op: 'op-1' })
  })

  it.each([
    ['an agent', { ...call, actor: { ...owner.actor, role: 'agent' } }],
    ['another role', { ...call, actor: { ...owner.actor, role: 'member' } }],
    ['a node client', { ...call, source: 'surface:report-bot' }],
    ['no source', { ...call, source: undefined }],
    ['no profile scope', { ...call, scope: undefined }],
  ])('refuses %s, for the read and for the effect, and runs nothing', async (_name, ctx) => {
    let ran = 0
    const [q, e] = deskServices(async () => {
      ran++
      return resource()
    }) as any[]
    await expect(q.handler({}, ctx)).rejects.toThrow('only the owner on the local Web')
    await expect(e.handler({ kind: 'message', text: 'hi' }, ctx)).rejects.toThrow('only the owner on the local Web')
    expect(ran).toBe(0)
  })

  it('needs the host\'s operation id for an effect, and says so when the service is not ready', async () => {
    await expect(effect.handler({ kind: 'message', text: 'hi' }, owner)).rejects.toThrow('operation id')
    const [q, e] = deskServices(async () => {
      throw new Error('resource is not ready')
    }) as any[]
    expect(await q.handler({}, owner)).toMatchObject({ running: false, canSubmit: false, problems: [{ kind: 'engine', unavailable: true, text: 'resource is not ready' }] })
    expect(await e.handler({ kind: 'message', text: 'hi' }, call)).toMatchObject({ ok: false, code: 'not-running' })
  })

  it('declares the effect as the same kind of effect DevBoard\'s page writes are, and the query as a plain read', () => {
    expect(DESK_CAPABILITIES.submit.effectPolicy).toEqual({ isDestructive: false, isOpenWorld: false, replay: 'idempotent', requiresApproval: 'never', approvalScopes: [] })
    expect(DESK_CAPABILITIES.query).not.toHaveProperty('effectPolicy')
    expect([query.name, effect.name]).toEqual(['companion.desk', 'companion.submit'])
  })
})
