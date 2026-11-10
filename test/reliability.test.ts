import { describe, expect, it } from 'vitest'
import { harness } from './harness.js'

/** Reliability coverage of the v1a acceptance (A7); test/RELIABILITY.md maps every item to its tests. */

describe('a session operation the platform refuses does not stop the rest of the engine', () => {
  it('a refused interrupt leaves the task abandoned, lets other tasks and messages go on, and is retried until it works', async () => {
    const h = harness()
    const stopped = await h.create('修登录', 'api')
    const web = await h.create('改样式', 'web')
    const interrupt = h.sessions.port.interrupt
    h.sessions.port.interrupt = async () => {
      throw Object.assign(new Error('refused'), { data: { reason: 'CAPABILITY_DENIED' } })
    }
    await h.signal({ kind: 'button', action: 'stop', taskId: stopped })
    h.sessions.finish(h.sessionOf(web), 'completed', 'ok')
    await h.tick()
    await h.tick()
    expect(h.task(stopped).state).toBe('abandoned')
    expect(h.task(web).state).toBe('done')
    expect(h.channel.texts().some((t) => t.startsWith(web) && t.includes('完成'))).toBe(true)
    expect(h.store.scan('op/')).toHaveLength(1)
    h.sessions.port.interrupt = interrupt
    await h.tick()
    expect(h.sessions.sessions.get(h.sessionOf(stopped))!.status.kind).toBe('idle')
    expect(h.store.scan('op/')).toEqual([])
  })
})

describe('usage the platform sometimes cannot report', () => {
  it('a reading that goes unknown and comes back is counted once, not read as 0 in between', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    h.sessions.setUsage(sid, { tokens: 100, cost: 0.5 })
    await h.tick()
    h.sessions.setUsage(sid, { tokens: null, cost: null })
    await h.tick()
    expect(h.task(id).usage).toEqual({ tokens: 100, cost: 0.5 })
    h.sessions.setUsage(sid, { tokens: 150, cost: 0.75 })
    await h.tick()
    expect(h.task(id).usage).toEqual({ tokens: 150, cost: 0.75 })
    expect(h.store.get('usage/2026-11-10')).toMatchObject({ tokens: 150, cost: 0.75, unknown: true })
  })
})
