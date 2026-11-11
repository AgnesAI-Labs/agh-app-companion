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
    expect(TRANSITIONS.map((r) => `${r.from.join('|')} ${r.on}`)).toHaveLength(23)
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

  it('waiting, approval answered: running, and the session handles it', async () => {
    const { h, id, sid } = await waiting()
    h.sessions.emit(sid, { kind: 'approval', state: 'decided' })
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

  describe('publish ends in pr-failed', () => {
    const PR = 'https://git.example.test/org/api/pull/12'
    const prFailed = JSON.stringify({
      status: 'refused',
      reason: 'pr-failed',
      detail: 'the branch is pushed; opening the pull request failed: gh: not logged in',
      branch: 'companion/x',
      commit: 'abc',
    })
    const published = JSON.stringify({ status: 'published', prUrl: PR, branch: 'companion/x', commit: 'abc', remote: 'r', files: ['a'] })

    it('running, session completes without a PR: paused (pr failed) with the reason, never done; continue asks for the publish again', async () => {
      const { h, id, sid } = await running()
      h.sessions.resolve(sid, h.sessions.call(sid, 'publish'), prFailed, true)
      h.sessions.finish(sid, 'completed', '分支已推送，PR 没开成')
      await h.tick()
      expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'prFailed', prUrl: null })
      const told = [...h.channel.delivered.values()].filter((m) => m.text.includes(id) && m.text.includes('没开成 PR'))
      expect(told).toHaveLength(1)
      expect(told[0]!.detail).toContain('gh: not logged in')
      await h.tick()
      expect([...h.channel.delivered.values()].filter((m) => m.text.includes('没开成 PR'))).toHaveLength(1)
      await button(h, 'continue', id)
      await h.tick()
      expect(h.task(id).state).toBe('running')
      expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toBe(TEXT.continuePr)
      h.sessions.resolve(sid, h.sessions.call(sid, 'publish'), published)
      h.sessions.finish(sid, 'completed', 'PR 开好了')
      await h.tick()
      expect(h.task(id)).toMatchObject({ state: 'done', prUrl: PR })
    })

    it('a pr-failed result read in an earlier pass still pauses the task when the turn ends after a restart', async () => {
      const { h, id, sid } = await running()
      h.sessions.resolve(sid, h.sessions.call(sid, 'publish'), prFailed, true)
      await h.tick()
      expect(h.task(id).state).toBe('running')
      h.restart()
      h.sessions.finish(sid, 'completed', '分支已推送，PR 没开成')
      await h.tick()
      expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'prFailed' })
    })

    it('a later publish that opens the PR in the same turn ends done', async () => {
      const { h, id, sid } = await running()
      h.sessions.resolve(sid, h.sessions.call(sid, 'publish'), prFailed, true)
      h.sessions.resolve(sid, h.sessions.call(sid, 'publish'), published)
      h.sessions.finish(sid, 'completed', 'PR 开好了')
      await h.tick()
      expect(h.task(id)).toMatchObject({ state: 'done', prUrl: PR })
    })
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
    h.sessions.finish(sid, 'cancelled')
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect([...h.sessions.sessions.get(sid)!.keys]).toEqual([`${id}:g0:resume`])
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toBe(TEXT.resume)
  })

  it('running, interrupted again after the resume: paused (turn interrupted)', async () => {
    const { h, id, sid } = await running()
    h.sessions.finish(sid, 'cancelled')
    await h.tick()
    h.sessions.finish(sid, 'cancelled')
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'turnInterrupted' })
    expect(h.sessions.sessions.get(sid)!.keys.size).toBe(1)
  })

  const ask = (r: { h: ReturnType<typeof harness>; sid: string }, outcome: 'allowed' | 'rejected' | 'expired', via: 'person' | 'full-access' | 'automatic') => {
    r.h.sessions.emit(r.sid, { kind: 'approval', state: 'pending' })
    r.h.sessions.outcome(r.sid, { outcome, via })
  }

  // Only the owner's own refusal counts: approvalOutcome with via person and outcome rejected (reconcile.mjs).
  it.each(['running', 'waiting'] as const)('%s, three refusals by the owner in a row: paused (refused), told once', async (from) => {
    const r = from === 'running' ? await running() : await waiting()
    ask(r, 'rejected', 'person')
    await r.h.tick()
    ask(r, 'rejected', 'person')
    await r.h.tick()
    expect(r.h.task(r.id)).toMatchObject({ state: 'running', refusals: 2 })
    ask(r, 'rejected', 'person')
    await r.h.tick()
    expect(r.h.task(r.id)).toMatchObject({ state: 'paused', reason: 'refused' })
    await r.h.tick()
    expect(r.h.channel.texts().filter((t) => t.includes(r.id) && t.includes('已暂停'))).toEqual([`${r.id}（api）修一下登录页的报错：已暂停（审批多次未见批准）`])
  })

  it('refusals not given by the owner, allowed or open requests and questions do not count; an owner allow ends the streak; continuing restarts the count', async () => {
    const r = await running()
    const { h, id, sid } = r
    for (let n = 0; n < 3; n++) ask(r, 'rejected', 'automatic')
    for (let n = 0; n < 3; n++) ask(r, 'rejected', 'full-access')
    for (let n = 0; n < 3; n++) ask(r, 'expired', 'automatic')
    for (let n = 0; n < 3; n++) ask(r, 'allowed', 'full-access')
    for (let n = 0; n < 3; n++) h.sessions.emit(sid, { kind: 'approval', state: 'pending', category: 'question' })
    for (let n = 0; n < 3; n++) h.sessions.emit(sid, { kind: 'approval', state: 'decided' })
    h.sessions.set(sid, { kind: 'active', flags: [] })
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'running', refusals: 0 })
    for (let n = 0; n < 3; n++) h.sessions.emit(sid, { kind: 'approval', state: 'pending' })
    h.sessions.set(sid, { kind: 'active', flags: [] })
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'running', refusals: 0 })
    ask(r, 'rejected', 'person')
    ask(r, 'rejected', 'person')
    ask(r, 'allowed', 'person')
    ask(r, 'rejected', 'person')
    ask(r, 'rejected', 'person')
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'running', refusals: 2 })
    ask(r, 'rejected', 'person')
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'refused' })
    h.sessions.set(sid, { kind: 'idle', flags: [] })
    await button(h, 'continue', id)
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'running', refusals: 0 })
  })

  it('a restart neither counts an owner refusal again nor misses one that arrived while it was down', async () => {
    const r = await running()
    ask(r, 'rejected', 'person')
    ask(r, 'rejected', 'person')
    await r.h.tick()
    r.h.restart()
    await r.h.tick()
    await r.h.tick()
    expect(r.h.task(r.id)).toMatchObject({ state: 'running', refusals: 2 })
    ask(r, 'rejected', 'person')
    r.h.restart()
    await r.h.tick()
    expect(r.h.task(r.id)).toMatchObject({ state: 'paused', reason: 'refused', refusals: 3 })
  })

  it('running, session asks for an approval: waiting, and the owner is told once to approve on the computer', async () => {
    const { h, id, sid } = await running()
    h.sessions.emit(sid, { kind: 'approval', state: 'pending', toolName: 'shell' })
    await h.tick()
    await h.tick()
    expect(h.task(id).state).toBe('waiting')
    h.restart()
    await h.tick()
    const notices = [...h.channel.delivered.values()].filter((m) => m.text.includes(TEXT.approvalWaiting))
    expect(notices.map((m) => ({ text: m.text, detail: m.detail, card: m.card }))).toEqual([
      { text: `${id}（api）修一下登录页的报错：${TEXT.approvalWaiting}`, detail: null, card: null },
    ])
    h.sessions.emit(sid, { kind: 'approval', state: 'pending' })
    await h.tick()
    expect([...h.channel.delivered.values()].filter((m) => m.text.includes(TEXT.approvalWaiting))).toHaveLength(2)
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
    expect(h.sessions.sessions.get(sid)!.events.at(-1)).toMatchObject({ kind: 'turn', status: 'cancelled' })
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
