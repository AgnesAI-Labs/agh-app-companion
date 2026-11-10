import { describe, expect, it } from 'vitest'
import { harness } from './harness.js'

describe('one workspace runs its tasks one at a time (decision round 16)', () => {
  it('a second task in the same workspace queues without a session and starts when the first finishes', async () => {
    const h = harness()
    const first = await h.create('修登录')
    const second = await h.create('加日志')
    expect(h.task(second).state).toBe('queued')
    expect(h.channel.texts()).toContain(`已新建 ${second}（api）加日志：排队中`)
    await h.tick()
    expect(h.workers().map((s) => s.request.startKey)).toEqual([`${first}:0`])
    h.sessions.finish(h.sessionOf(first), 'completed', 'ok')
    await h.tick()
    expect(h.task(second).state).toBe('running')
    expect(h.workers().map((s) => s.request.startKey)).toEqual([`${first}:0`, `${second}:0`])
  })

  it('another workspace runs at the same time', async () => {
    const h = harness()
    await h.create('修登录', 'api')
    const web = await h.create('改样式', 'web')
    expect(h.task(web).state).toBe('running')
    expect(h.workers()).toHaveLength(2)
  })

  it('reopening a finished task waits for the workspace slot too', async () => {
    const h = harness()
    const first = await h.create('修登录')
    h.sessions.finish(h.sessionOf(first), 'completed', 'ok')
    await h.tick()
    const second = await h.create('加日志')
    await h.say('再改一下', { replyTo: first })
    await h.tick()
    expect(h.task(first).state).toBe('queued')
    expect(h.sessions.sessions.get(h.sessionOf(first))!.inputs).toHaveLength(1)
    h.sessions.finish(h.sessionOf(second), 'completed', 'ok')
    await h.tick()
    expect(h.task(first).state).toBe('running')
    expect(h.sessions.sessions.get(h.sessionOf(first))!.inputs.at(-1)).toBe('再改一下')
  })

  it('a paused task gives up the slot', async () => {
    const h = harness({ limits: { taskTokens: 10 } })
    const first = await h.create('修登录')
    const second = await h.create('加日志')
    h.sessions.setUsage(h.sessionOf(first), { tokens: 20, cost: null })
    await h.tick()
    expect(h.task(first).state).toBe('paused')
    expect(h.task(second).state).toBe('running')
  })

  it('the concurrency number is the only knob', async () => {
    const h = harness({ limits: { workspaceConcurrency: 2 } })
    await h.create('修登录')
    const second = await h.create('加日志')
    expect(h.task(second).state).toBe('running')
  })
})

describe('budget from session usage', () => {
  it('unknown usage stays unknown, is never read as 0, and pauses nothing', async () => {
    const h = harness({ limits: { taskTokens: 10, dailyCost: 1 } })
    const id = await h.create('修登录')
    h.sessions.setUsage(h.sessionOf(id), { tokens: null, cost: null })
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'running', usage: { tokens: null, cost: null } })
    expect(h.store.get('usage/2026-11-10')).toEqual({ tokens: 0, cost: 0, unknown: true })
  })

  it('sums usage per task and per day from session readings', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    h.sessions.setUsage(sid, { tokens: 100, cost: 0.5 })
    await h.tick()
    h.sessions.setUsage(sid, { tokens: 250, cost: 1 })
    await h.tick()
    expect(h.task(id).usage).toEqual({ tokens: 250, cost: 1 })
    expect(h.store.get('usage/2026-11-10')).toMatchObject({ tokens: 250, cost: 1 })
  })

  it('continuing a budget pause grants the task cap again from that point', async () => {
    const h = harness({ limits: { taskTokens: 100 } })
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    h.sessions.setUsage(sid, { tokens: 150, cost: null })
    await h.tick()
    h.sessions.set(sid, { kind: 'idle', flags: [] })
    await h.signal({ kind: 'button', action: 'continue', taskId: id })
    await h.tick()
    expect(h.task(id).state).toBe('running')
    h.sessions.setUsage(sid, { tokens: 260, cost: null })
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'budget' })
  })
})
