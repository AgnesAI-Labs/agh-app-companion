import { describe, expect, it } from 'vitest'
import { askOwnerTool } from '../ask-owner.mjs'
import { label, TEXT } from '../tasks.mjs'
import { decisions, harness } from './harness.js'

const OPTIONS = ['方案一，北京天气走公开接口', '方案二，只做每日提醒', '方案三，先不做']

type H = ReturnType<typeof harness>

const structured = (r: unknown) => (r as { structured: { status: string; reason?: string; taskId?: string } }).structured
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true

/** The tool as the platform calls it, over the harness engine and a session key. */
function asker(h: H) {
  const tool = askOwnerTool(async () => ({ askOwner: (key: string, input: unknown) => h.engine.askOwner(key, input as never) }))
  return (key: string, args: Record<string, unknown>) =>
    tool.execute(args as never, { session: { key }, signal: new AbortController().signal, log: { info() {} } } as never)
}

async function asking(h: H, text = '新建一个北京天气查询任务', workspace = 'api') {
  const id = await h.create(text, workspace)
  const sid = h.sessionOf(id)
  const ask = asker(h)
  const result = await ask(sid, { question: '怎么做？', options: OPTIONS })
  expect(structured(result).status).toBe('asked')
  h.sessions.finish(sid, 'completed', '我把问题交给伴侣了')
  await h.tick()
  return { id, sid, ask }
}

const toJudge = (h: H) => h.judgeInputs.length

describe('ask_owner', () => {
  it('worker asks, its turn ends: the task waits, and the owner gets one message with the numbered options', async () => {
    const h = harness()
    const { id } = await asking(h)
    expect(h.task(id)).toMatchObject({ state: 'waiting', reason: null })
    const sent = [...h.channel.delivered.values()].filter((m) => m.text.includes('等你回答'))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe(`${label(h.task(id))}：等你回答`)
    expect(sent[0]!.detail).toBe('怎么做？')
    expect(sent[0]!.ask).toEqual({ options: OPTIONS, at: expect.any(String) })
    expect(h.channel.texts().some((t) => t.includes('完成'))).toBe(false)
    await h.tick()
    await h.tick()
    expect([...h.channel.delivered.values()].filter((m) => m.text.includes('等你回答'))).toHaveLength(1)
  })

  it('retains a mixed native and ask_owner completion until the native question closes', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    await asker(h)(sid, { question: '下一步怎么做？', options: OPTIONS })
    h.sessions.finish(sid, 'completed', 'Questions published')
    h.sessions.set(sid, { kind: 'active', flags: ['waitingOnUserInput'] })
    await h.tick()
    expect(h.task(id).state).toBe('waiting')
    expect(h.channel.texts().some((text) => text.includes('等你回答'))).toBe(false)
    h.sessions.set(sid, { kind: 'idle', flags: [] })
    await h.tick()
    await h.tick()
    expect(h.task(id).state).toBe('waiting')
    expect([...h.channel.delivered.values()].filter((m) => m.text.includes('等你回答'))).toHaveLength(1)
    expect(h.channel.texts().some((text) => text.includes('完成'))).toBe(false)
  })

  it('a bare option number reaches the same session without the judge, and the task runs again', async () => {
    const h = harness()
    const { id, sid } = await asking(h)
    const judged = toJudge(h)
    await h.say('1')
    await h.tick()
    expect(toJudge(h)).toBe(judged)
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toBe(`${TEXT.attach}\n\n1`)
    expect(h.task(id)).toMatchObject({ state: 'running', question: null })
    expect(h.entry('inbox/im:e2').disposition).toMatchObject({ kind: 'appended', taskIds: [id] })
  })

  it.each(['选2', ' 2。 ', '2.', OPTIONS[2]!])('"%s" is an explicit answer too', async (answer) => {
    const h = harness()
    const { id, sid } = await asking(h)
    const judged = toJudge(h)
    await h.say(answer)
    await h.tick()
    expect(toJudge(h)).toBe(judged)
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toContain(answer)
    expect(h.task(id).state).toBe('running')
  })

  it('a worker that asks again after the answer waits again with the new question', async () => {
    const h = harness()
    const { id, sid, ask } = await asking(h)
    await h.say('1')
    await h.tick()
    await ask(sid, { question: '要带周末吗？' })
    h.sessions.finish(sid, 'completed', '又问了一个')
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'waiting', question: { text: '要带周末吗？', options: [] } })
  })

  it('an owner message that reaches the task before its turn ends answers the pending question, so the task is not asked again', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    await asker(h)(sid, { question: '怎么做？', options: OPTIONS })
    await h.say(`#${id} 用方案一`)
    await h.tick()
    expect(h.task(id).question).toBeNull()
    h.sessions.finish(sid, 'completed', '做完了')
    await h.tick()
    expect(h.channel.texts().some((t) => t.includes('等你回答'))).toBe(false)
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toContain('用方案一')
    expect(h.task(id).question).toBeNull()
  })

  it('an unrelated request while one question waits goes to the judge and becomes a new task', async () => {
    const h = harness()
    const { id } = await asking(h)
    h.setJudge(({ batch }) => decisions({ kind: 'create', messages: [batch[0]!.id], workspace: 'web', title: '看 PR' }))
    await h.say('帮我看看 agh 的 PR')
    await h.tick()
    expect(h.tasks()).toHaveLength(2)
    expect(h.task(id).state).toBe('waiting')
    expect(h.task(id).question).not.toBeNull()
  })

  it('an out-of-range number goes to the judge', async () => {
    const h = harness()
    const { id } = await asking(h)
    const judged = toJudge(h)
    for (const text of ['0', '4', '12']) await h.say(text)
    await h.tick()
    expect(toJudge(h)).toBe(judged + 1)
    expect(h.judgeInputs.at(-1)!.batch.map((b) => b.text)).toEqual(['0', '4', '12'])
    expect(h.task(id).state).toBe('waiting')
  })

  it('two tasks waiting on a question: "1" goes to the judge', async () => {
    const h = harness()
    await asking(h)
    await asking(h, '另一个任务', 'web')
    const judged = toJudge(h)
    await h.say('1')
    await h.tick()
    expect(toJudge(h)).toBe(judged + 1)
    expect(h.tasks().map((t) => t.state)).toEqual(['waiting', 'waiting'])
  })

  it('the judge sees which task asks, and an unanchored answer it appends reaches that task', async () => {
    const h = harness()
    const { id, sid } = await asking(h)
    h.setJudge(({ recent, batch }) =>
      decisions({ kind: 'append', message: batch[0]!.id, taskId: id, context: recent.find((r) => r.taskIds.includes(id) && r.text.includes('等你回答')).id }),
    )
    await h.say('就用第一个吧')
    await h.tick()
    expect(h.judgeInputs.at(-1)!.snapshot.tasks.find((t: { id: string }) => t.id === id)).toMatchObject({ state: 'waiting', asking: true })
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toContain('就用第一个吧')
    expect(h.task(id)).toMatchObject({ state: 'running', question: null })
  })

  it('a task not waiting on a question is not marked asking', async () => {
    const h = harness()
    const id = await h.create('修登录')
    h.sessions.set(h.sessionOf(id), { kind: 'active', flags: ['waitingOnApproval'] })
    await h.tick()
    await h.say('1')
    await h.tick()
    expect(h.judgeInputs.at(-1)!.snapshot.tasks.find((t: { id: string }) => t.id === id)).not.toHaveProperty('asking')
  })

  it('a status pass with no flags does not flip a task waiting on its question to running', async () => {
    const h = harness()
    const { id, sid } = await asking(h)
    h.sessions.set(sid, { kind: 'idle', flags: [] })
    for (let n = 0; n < 3; n++) await h.tick()
    expect(h.task(id).state).toBe('waiting')
  })

  it('a worker that only writes the question in its reply still finishes, as before', async () => {
    const h = harness()
    const id = await h.create('修登录')
    h.sessions.finish(h.sessionOf(id), 'completed', '要哪个？\n1. 甲\n2. 乙')
    await h.tick()
    expect(h.task(id).state).toBe('done')
  })

  it('the question is dropped when its task stops, so a later turn is not read as a new question', async () => {
    const h = harness()
    const { id } = await asking(h)
    await h.say(`停止 ${id}`)
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'abandoned', question: null })
  })

  it('tells the worker how native questions and ask_owner differ', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const first = h.sessions.sessions.get(h.sessionOf(id))!.inputs[0]!
    expect(first).toContain('ask_user_question')
    expect(first).toContain('ask_owner')
    expect(first).toContain('主人的回答会作为下一条消息送来')
    expect(first).toContain('同一个问题不要同时调用两种工具')
    expect(first).not.toContain('在回复里直接写出问题和编号选项')
  })
})

describe('ask_owner tool', () => {
  it('refuses a session that is not a running task session', async () => {
    const h = harness()
    const ask = asker(h)
    const stranger = await ask('managed-other', { question: '行吗？' })
    expect(structured(stranger)).toMatchObject({ status: 'refused', reason: 'not-a-task-session' })
    expect(isError(stranger)).toBe(true)

    const id = await h.create('修登录')
    h.sessions.finish(h.sessionOf(id), 'completed', '好了')
    await h.tick()
    expect(structured(await ask(h.sessionOf(id), { question: '行吗？' })).reason).toBe('not-a-task-session')
    expect(h.task(id).question ?? null).toBeNull()
  })

  it('refuses when the companion service is not running', async () => {
    const tool = askOwnerTool(async () => {
      throw new Error('stopped')
    })
    const result = await tool.execute({ question: '行吗？' } as never, { session: { key: 'x' }, signal: new AbortController().signal, log: { info() {} } } as never)
    expect(structured(result)).toMatchObject({ status: 'refused', reason: 'not-running' })
  })

  it.each([
    ['no question', {}],
    ['an empty question', { question: '' }],
    ['a question over 2000 characters', { question: 'a'.repeat(2001) }],
    ['one option', { question: 'q', options: ['甲'] }],
    ['seven options', { question: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] }],
    ['an empty option', { question: 'q', options: ['甲', ''] }],
    ['an option over 200 characters', { question: 'q', options: ['甲', 'a'.repeat(201)] }],
    ['an option with a line break', { question: 'q', options: ['甲', '乙\n丙'] }],
    ['a non-string option', { question: 'q', options: ['甲', 2] }],
    ['an unknown parameter', { question: 'q', extra: true }],
  ])('refuses %s and records nothing', async (_name, args) => {
    const h = harness()
    const id = await h.create('修登录')
    const result = await asker(h)(h.sessionOf(id), args)
    expect(structured(result)).toMatchObject({ status: 'refused', reason: 'invalid-input' })
    expect(h.task(id).question ?? null).toBeNull()
  })

  it('the last call in a turn wins, and the result tells the worker to end its turn', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const ask = asker(h)
    await ask(h.sessionOf(id), { question: '先问这个', options: ['甲', '乙'] })
    const result = await ask(h.sessionOf(id), { question: '改问这个', options: ['丙', '丁'] })
    expect(h.task(id).question).toMatchObject({ text: '改问这个', options: ['丙', '丁'], generation: 0 })
    expect(JSON.stringify(result)).toContain('结束本轮')
  })
})
