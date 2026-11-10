import { describe, expect, it } from 'vitest'
import { TEXT } from '../tasks.mjs'
import { decisions, harness } from './harness.js'

const cards = (h: ReturnType<typeof harness>) => [...h.channel.delivered.values()].filter((m) => m.card)

async function doneTask(h: ReturnType<typeof harness>, text = '修登录', workspace = 'api') {
  const id = await h.create(text, workspace)
  h.sessions.finish(h.sessionOf(id), 'completed', 'ok')
  await h.tick()
  return id
}

describe('attaching unquoted messages to existing tasks (spec §4.19)', () => {
  it('a task id in the message attaches directly, without the judge, and the reply names the task', async () => {
    const h = harness()
    const id = await doneTask(h)
    const judged = h.judgeInputs.length
    await h.say(`#${id} 再加一个单测`)
    await h.tick()
    expect(h.judgeInputs).toHaveLength(judged)
    expect(h.task(id).state).toBe('running')
    const sid = h.sessionOf(id)
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toBe(`${TEXT.attach}\n\n#${id} 再加一个单测`)
    expect(h.channel.texts()).toContain(`已接到 ${id}（api）修登录`)
  })

  it('a task PR link attaches directly', async () => {
    const h = harness()
    const id = await doneTask(h)
    h.store.putTask({ ...h.task(id), prUrl: 'https://git.example/org/api/pull/12' })
    await h.say('https://git.example/org/api/pull/12 这个评论处理一下')
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect(h.entry('inbox/im:e2').disposition).toMatchObject({ kind: 'appended', taskIds: [id] })
  })

  it('"that one" attaches only when the judge names a task that is in the recent conversation', async () => {
    const h = harness()
    const id = await doneTask(h)
    const other = await doneTask(h, '改样式', 'web')
    h.store.transaction(() => {
      for (const { key, value } of h.store.scan('outbox/'))
        if (value.taskIds.includes(other)) h.store.delete(key)
    })
    h.setJudge(({ recent, batch }) => {
      const mention = recent.find((r) => r.taskIds.includes(id))
      return decisions(
        { kind: 'append', message: batch[0]!.id, taskId: other, context: mention.id },
      )
    })
    await h.say('刚才那个再改一下')
    await h.tick()
    expect(h.task(other).state).toBe('done')
    expect(h.channel.texts().at(-1)).toBe(TEXT.fallback)

    h.setJudge(({ recent, batch }) => decisions({ kind: 'append', message: batch[0]!.id, taskId: id, context: recent.find((r) => r.taskIds.includes(id)).id }))
    await h.say('刚才那个再改一下')
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect(h.channel.texts()).toContain(`已接到 ${id}（api）修登录`)
  })

  it('a close topic only pushes a choice card; without a click nothing is attached or created', async () => {
    const h = harness()
    const a = await doneTask(h, '修登录')
    const b = await doneTask(h, '改登录样式', 'web')
    h.setJudge(({ batch }) => decisions({ kind: 'ask', message: batch[0]!.id, text: '接到哪个？', candidates: [a, b] }))
    await h.say('登录那块再看看')
    await h.tick()
    expect(cards(h).at(-1)!.card).toEqual({ options: [{ taskId: a, title: '修登录' }, { taskId: b, title: '改登录样式' }], allowNew: true })
    await h.tick()
    expect(h.tasks().map((t) => t.state)).toEqual(['done', 'done'])
    expect(h.tasks()).toHaveLength(2)
  })

  it('a click on the card attaches to the picked task once', async () => {
    const h = harness()
    const a = await doneTask(h, '修登录')
    h.setJudge(({ batch }) => decisions({ kind: 'ask', message: batch[0]!.id, text: '接到哪个？', candidates: [a] }))
    await h.say('登录那块再看看')
    await h.tick()
    const card = cards(h).at(-1)!
    await h.signal({ kind: 'choice', card: card.deliveryKey, pick: a })
    await h.signal({ kind: 'choice', card: card.deliveryKey, pick: a })
    await h.tick()
    expect(h.task(a).state).toBe('running')
    expect(h.sessions.sessions.get(h.sessionOf(a))!.inputs.filter((i) => i.includes('登录那块再看看'))).toHaveLength(1)
  })

  it('"new" on the card sends the message to the judge to create a task', async () => {
    const h = harness()
    const a = await doneTask(h, '修登录')
    h.setJudge(({ batch }) => decisions({ kind: 'ask', message: batch[0]!.id, text: '接到哪个？', candidates: [a] }))
    await h.say('登录页加验证码')
    await h.tick()
    h.setJudge(({ batch }) => decisions({ kind: 'create', messages: [batch[0]!.id], workspace: 'api', title: '验证码' }))
    await h.signal({ kind: 'choice', card: cards(h).at(-1)!.deliveryKey, pick: 'new' })
    await h.tick()
    expect(h.judgeInputs.at(-1)!.batch).toEqual([expect.objectContaining({ text: '登录页加验证码', chosenNew: true })])
    expect(h.tasks().at(-1)).toMatchObject({ title: '验证码', brief: '登录页加验证码' })
  })

  it.each(['abandoned', 'expired'])('an %s task is not attached; the owner is asked to create anew', async (end) => {
    const h = harness()
    const id = await h.create('修登录')
    await h.say(`停掉 ${id}`)
    await h.tick()
    if (end === 'expired') h.store.putTask({ ...h.task(id), state: 'expired' })
    await h.say(`${id} 还是做吧`)
    await h.tick()
    expect(h.task(id).state).toBe(end)
    expect(h.channel.texts()).toContain(TEXT.ended)
  })

  it('a message naming another workspace and not the task own is not sent; a card asks instead', async () => {
    const h = harness()
    const id = await doneTask(h, '修登录', 'api')
    const sid = h.sessionOf(id)
    const inputs = h.sessions.sessions.get(sid)!.inputs.length
    await h.say(`#${id} 把 web 首页标题改了`)
    await h.tick()
    expect(h.sessions.sessions.get(sid)!.inputs).toHaveLength(inputs)
    expect(h.task(id).state).toBe('done')
    expect(cards(h).at(-1)!.card.options).toEqual([{ taskId: id, title: '修登录' }])
    await h.signal({ kind: 'choice', card: cards(h).at(-1)!.deliveryKey, pick: id })
    await h.tick()
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toContain('把 web 首页标题改了')
  })

  it('naming the task own workspace as well passes the check', async () => {
    const h = harness()
    const id = await doneTask(h, '修登录', 'api')
    await h.say(`#${id} api 里的 web 文案常量也改了`)
    await h.tick()
    expect(h.task(id).state).toBe('running')
  })
})

describe('the worker returns an attached message (退回)', () => {
  it('returns the task to its prior state and offers the other recent tasks plus new', async () => {
    const h = harness()
    const other = await doneTask(h, '改样式', 'web')
    const id = await doneTask(h, '修登录', 'api')
    await h.say(`#${id} 顺便看看部署脚本`)
    await h.tick()
    expect(h.task(id).state).toBe('running')
    h.sessions.finish(h.sessionOf(id), 'completed', '退回：部署脚本不在这个任务里\n其他说明')
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'done', attach: null })
    expect(h.store.readEvents(id).at(-1)!.data).toMatchObject({ event: 'handback', to: 'done', note: '退回：部署脚本不在这个任务里' })
    expect(cards(h).at(-1)!.card).toEqual({ options: [{ taskId: other, title: '改样式' }], allowNew: true })
  })

  it('a second return of the same message offers only new', async () => {
    const h = harness()
    await doneTask(h, '改样式', 'web')
    const id = await doneTask(h, '修登录', 'api')
    const other = h.tasks()[0].id
    await h.say(`#${id} 顺便看看部署脚本`)
    await h.tick()
    h.sessions.finish(h.sessionOf(id), 'completed', '退回：无关')
    await h.tick()
    await h.signal({ kind: 'choice', card: cards(h).at(-1)!.deliveryKey, pick: other })
    await h.tick()
    h.sessions.finish(h.sessionOf(other), 'completed', '退回：也无关')
    await h.tick()
    expect(h.task(other).state).toBe('done')
    expect(cards(h).at(-1)!.card).toEqual({ options: [], allowNew: true })
  })

  it('a reply under a task is not wrapped and cannot be returned', async () => {
    const h = harness()
    const id = await doneTask(h)
    await h.say('再改一下', { replyTo: id })
    await h.tick()
    expect(h.sessions.sessions.get(h.sessionOf(id))!.inputs.at(-1)).toBe('再改一下')
    h.sessions.finish(h.sessionOf(id), 'completed', '退回：无关')
    await h.tick()
    expect(h.task(id).state).toBe('done')
    expect(cards(h)).toHaveLength(0)
  })
})
