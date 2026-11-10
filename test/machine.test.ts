import { describe, expect, it } from 'vitest'
import { LIMITS } from '../limits.mjs'
import { TRANSITIONS } from '../machine.mjs'
import { createTask, TEXT } from '../tasks.mjs'
import { harness } from './harness.js'

const DAY = 24 * 60 * 60 * 1000
const waitingFlag = { kind: 'active' as const, flags: ['waitingOnApproval' as const] }

async function running(limits = {}) {
  const h = harness({ limits })
  const id = await h.create('修一下登录页的报错')
  return { h, id, sid: h.sessionOf(id) }
}

async function waiting(limits = {}) {
  const r = await running(limits)
  r.h.sessions.set(r.sid, waitingFlag)
  await r.h.tick()
  expect(r.h.task(r.id).state).toBe('waiting')
  return r
}

function proposed() {
  const h = harness()
  const tx = { store: h.store, at: h.now(), limits: LIMITS, workspaces: ['api', 'web'] }
  const id = h.store.transaction(() => {
    const task = createTask(tx, { title: '升级依赖', workspace: 'api', inbox: [], brief: '升级依赖', hops: 0 })
    h.store.putTask({ ...h.task(task.id), state: 'proposed' })
    return task.id
  })
  return { h, id }
}

async function paused(kind: 'budget' | 'sessionLost') {
  const r = await running({ taskTokens: 100 })
  if (kind === 'budget') r.h.sessions.setUsage(r.sid, { tokens: 150, cost: null })
  else r.h.sessions.lose(r.sid)
  await r.h.tick()
  expect(r.h.task(r.id)).toMatchObject({ state: 'paused', reason: kind })
  return r
}

const button = (h: ReturnType<typeof harness>, action: string, taskId: string) =>
  h.signal({ kind: 'button', action, taskId })

describe('state table (spec §4.3), one test per row', () => {
  it('has a row for every spec row plus the queue and return rows', () => {
    expect(TRANSITIONS.map((r) => `${r.from.join('|')} ${r.on}`)).toHaveLength(20)
  })

  it('proposed, owner confirms: running, and its session starts', async () => {
    const { h, id } = proposed()
    await h.tick()
    expect(h.workers()).toHaveLength(0)
    await button(h, 'confirm', id)
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect(h.workers().map((s) => s.request.startKey)).toEqual([`${id}:0`])
  })

  it('proposed, owner refuses: abandoned, no session', async () => {
    const { h, id } = proposed()
    await button(h, 'refuse', id)
    await h.tick()
    expect(h.task(id).state).toBe('abandoned')
    expect(h.workers()).toHaveLength(0)
  })

  it('proposed, past its 3-day validity: expired', async () => {
    const { h, id } = proposed()
    h.advance(3 * DAY - 1000)
    await h.tick()
    expect(h.task(id).state).toBe('proposed')
    h.advance(2000)
    await h.tick()
    expect(h.task(id).state).toBe('expired')
  })

  it('running, session waits on approval or an answer: waiting', async () => {
    const { h, id, sid } = await running()
    h.sessions.set(sid, { kind: 'active', flags: ['waitingOnUserInput'] })
    await h.tick()
    expect(h.task(id).state).toBe('waiting')
  })

  it.each([
    ['approval granted', { kind: 'approval', state: 'answered', decision: 'approved' }],
    ['approval refused', { kind: 'approval', state: 'answered', decision: 'refused' }],
  ] as const)('waiting, %s: running, and the session handles it', async (_name, event) => {
    const { h, id, sid } = await waiting()
    h.sessions.emit(sid, event)
    h.sessions.set(sid, { kind: 'active', flags: [] })
    await h.tick()
    expect(h.task(id).state).toBe('running')
  })

  it('waiting, owner answers under the task: running, the answer goes into the same session', async () => {
    const { h, id, sid } = await waiting()
    h.sessions.set(sid, { kind: 'idle', flags: ['waitingOnUserInput'] })
    await h.say('用方案二', { replyTo: id })
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toBe('用方案二')
  })

  it('waiting, approval expires: failed (approval expired)', async () => {
    const { h, id, sid } = await waiting()
    h.sessions.emit(sid, { kind: 'approval', state: 'expired' })
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'failed', reason: 'approvalExpired' })
  })

  it('running, session completes: done, and the owner gets the result', async () => {
    const { h, id, sid } = await running()
    h.sessions.finish(sid, 'completed', '改好了，测试通过')
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'done', reason: null })
    expect([...h.channel.delivered.values()].some((m) => m.text.includes(id) && m.text.includes('完成') && m.detail === '改好了，测试通过')).toBe(true)
  })

  it('running, session fails: failed', async () => {
    const { h, id, sid } = await running()
    h.sessions.finish(sid, 'failed')
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'failed', reason: 'sessionFailed' })
  })

  it.each(['running', 'waiting'] as const)('%s, over the task budget: paused (budget), owner told', async (from) => {
    const r = from === 'running' ? await running({ taskTokens: 100 }) : await waiting({ taskTokens: 100 })
    r.h.sessions.setUsage(r.sid, { tokens: 150, cost: null })
    await r.h.tick()
    expect(r.h.task(r.id)).toMatchObject({ state: 'paused', reason: 'budget' })
    expect(r.h.channel.texts().some((t) => t.includes('已暂停（超预算）'))).toBe(true)
  })

  it.each(['running', 'waiting'] as const)('%s, over the hop limit: paused (hops)', async (from) => {
    const r = from === 'running' ? await running() : await waiting()
    r.h.store.putTask({ ...r.h.task(r.id), hops: LIMITS.maxHops + 1 })
    await r.h.tick()
    expect(r.h.task(r.id)).toMatchObject({ state: 'paused', reason: 'hops' })
  })

  it.each(['running', 'waiting'] as const)('%s, session missing on reconcile: paused (session lost)', async (from) => {
    const r = from === 'running' ? await running() : await waiting()
    r.h.sessions.lose(r.sid)
    await r.h.tick()
    expect(r.h.task(r.id)).toMatchObject({ state: 'paused', reason: 'sessionLost' })
  })

  it('running, turn interrupted: resumed once with a fixed key, still running', async () => {
    const { h, id, sid } = await running()
    h.sessions.finish(sid, 'interrupted')
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect([...h.sessions.sessions.get(sid)!.keys]).toEqual([`${id}:g0:resume`])
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toBe(TEXT.resume)
  })

  it('running, interrupted again after the resume: paused (turn interrupted)', async () => {
    const { h, id, sid } = await running()
    h.sessions.finish(sid, 'interrupted')
    await h.tick()
    h.sessions.finish(sid, 'interrupted')
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'turnInterrupted' })
    expect(h.sessions.sessions.get(sid)!.keys.size).toBe(1)
  })

  it.each(['running', 'waiting'] as const)('%s, three refused approvals in a row: paused (refused)', async (from) => {
    const r = from === 'running' ? await running() : await waiting()
    for (let n = 0; n < 2; n++) r.h.sessions.emit(r.sid, { kind: 'approval', state: 'answered', decision: 'refused' })
    r.h.sessions.emit(r.sid, { kind: 'approval', state: 'answered', decision: 'approved' })
    await r.h.tick()
    expect(r.h.task(r.id).state).not.toBe('paused')
    for (let n = 0; n < 2; n++) r.h.sessions.emit(r.sid, { kind: 'approval', state: 'answered', decision: 'refused' })
    await r.h.tick()
    expect(r.h.task(r.id).state).not.toBe('paused')
    if (from === 'waiting') r.h.sessions.set(r.sid, waitingFlag)
    r.h.sessions.emit(r.sid, { kind: 'approval', state: 'answered', decision: 'refused' })
    await r.h.tick()
    expect(r.h.task(r.id)).toMatchObject({ state: 'paused', reason: 'refused' })
  })

  it('paused, owner continues: running in the same session', async () => {
    const { h, id, sid } = await paused('budget')
    h.sessions.set(sid, { kind: 'idle', flags: [] })
    await button(h, 'continue', id)
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toBe(TEXT.continue)
    expect(h.workers()).toHaveLength(1)
  })

  it('paused (session lost), owner continues: running in a new session generation', async () => {
    const { h, id } = await paused('sessionLost')
    await h.say(`继续 ${id}`)
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'running', generation: 1 })
    expect(h.workers().map((s) => s.request.startKey)).toEqual([`${id}:1`])
  })

  it.each(['completed', 'failed'] as const)('%s task, owner speaks under it: running again in the original session', async (outcome) => {
    const { h, id, sid } = await running()
    h.sessions.finish(sid, outcome, 'ok')
    await h.tick()
    await h.say('再把错误提示改短一点', { replyTo: id })
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect(h.sessionOf(id)).toBe(sid)
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toBe('再把错误提示改短一点')
  })

  it.each(['proposed', 'queued', 'running', 'waiting', 'paused'] as const)('%s, owner stops it: abandoned', async (from) => {
    let h: ReturnType<typeof harness>
    let id: string
    if (from === 'proposed') ({ h, id } = proposed())
    else if (from === 'queued') {
      ;({ h } = await running())
      id = await h.create('另一个接口任务')
      expect(h.task(id).state).toBe('queued')
    } else if (from === 'running') ({ h, id } = await running())
    else if (from === 'waiting') ({ h, id } = await waiting())
    else ({ h, id } = await paused('budget'))
    await h.say(`停掉 ${id}`)
    await h.tick()
    expect(h.task(id).state).toBe('abandoned')
    expect(h.store.scan('op/').filter((r) => r.value.taskId === id)).toEqual([])
  })

  it('stopping a running task interrupts its session', async () => {
    const { h, id, sid } = await running()
    await button(h, 'stop', id)
    await h.tick()
    expect(h.sessions.sessions.get(sid)!.events.at(-1)).toEqual({ kind: 'turn', outcome: 'interrupted' })
  })

  it.each(['abandoned', 'expired'] as const)('%s, owner speaks under it: not reopened, asked to create anew', async (end) => {
    const { h, id } = proposed()
    if (end === 'abandoned') await button(h, 'refuse', id)
    else h.advance(3 * DAY + 1000)
    await h.tick()
    expect(h.task(id).state).toBe(end)
    await h.say('还是做一下吧', { replyTo: id })
    await h.tick()
    expect(h.task(id).state).toBe(end)
    expect(h.channel.texts()).toContain(TEXT.ended)
    expect(h.workers()).toHaveLength(0)
  })

  it('queued, the workspace slot frees: running (see queue tests for the full flow)', async () => {
    const { h, sid } = await running()
    const second = await h.create('另一个接口任务')
    expect(h.task(second).state).toBe('queued')
    h.sessions.finish(sid, 'completed', 'ok')
    await h.tick()
    expect(h.task(second).state).toBe('running')
  })

  it('a command that does not apply in the state is refused and changes nothing', async () => {
    const { h, id } = await running()
    await h.say(`继续 ${id}`)
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect(h.channel.texts().some((t) => t.includes('这个操作不适用'))).toBe(true)
  })
})
