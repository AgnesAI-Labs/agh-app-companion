import { describe, expect, it } from 'vitest'
import { TEXT } from '../tasks.mjs'
import { decisions, harness } from './harness.js'

const DAY = 24 * 60 * 60 * 1000

describe('store cleanup and thresholds (spec §4.3)', () => {
  it('deletes disposed inbox entries and delivered messages after 7 days, keeps the rest', async () => {
    const h = harness({ judge: ({ batch }) => decisions({ kind: 'answer', message: batch[0]!.id, text: '好' }) })
    await h.say('你好')
    await h.tick()
    h.channel.setDown(true)
    h.setJudge(() => ({ outcome: 'failed' }))
    await h.say('还在吗')
    await h.tick()
    h.advance(7 * DAY + 1000)
    await h.tick()
    expect(h.store.scan('inbox/').map((r) => r.value.signal.text)).toEqual(['还在吗'])
    expect(h.store.scan('outbox/')).toEqual([])
  })

  it('keeps an undelivered message past 7 days', async () => {
    const h = harness({ judge: ({ batch }) => decisions({ kind: 'answer', message: batch[0]!.id, text: '好' }) })
    h.channel.setDown(true)
    await h.say('你好')
    await h.tick()
    h.advance(8 * DAY)
    await h.tick()
    expect(h.store.scan('outbox/').map((r) => r.value.text)).toEqual(['好'])
  })

  it('compacts the events of a task ended 30 days ago into its summary', async () => {
    const h = harness()
    const id = await h.create('修登录')
    h.sessions.finish(h.sessionOf(id), 'completed', 'ok')
    await h.tick()
    const count = h.store.readEvents(id).length
    h.advance(30 * DAY - 1000)
    await h.tick()
    expect(h.store.readEvents(id)).toHaveLength(count)
    h.advance(2000)
    await h.tick()
    expect(h.store.readEvents(id)).toEqual([])
    expect(h.task(id)).toMatchObject({ state: 'done', eventChunks: 0, compacted: { events: count } })
  })

  it('warns the owner once past 80%', async () => {
    const h = harness({ limits: { storeWarnRatio: 0.0003 } })
    await h.tick()
    await h.say('状态')
    await h.tick()
    await h.tick()
    expect(h.channel.texts().filter((t) => t === TEXT.storeWarn)).toHaveLength(1)
  })

  it('refuses new tasks past 95% and lets existing tasks finish', async () => {
    const h = harness()
    const id = await h.create('修登录')
    h.limits.storeRefuseRatio = 0
    h.setJudge(({ batch }) => decisions({ kind: 'create', messages: [batch[0]!.id], workspace: 'web', title: '加日志' }))
    await h.say('加日志')
    await h.tick()
    expect(h.tasks().map((t) => t.id)).toEqual([id])
    expect(h.channel.texts()).toContain(TEXT.storeFull)
    h.sessions.finish(h.sessionOf(id), 'completed', 'ok')
    await h.tick()
    expect(h.task(id).state).toBe('done')
  })
})
