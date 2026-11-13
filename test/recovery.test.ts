import { describe, expect, it } from 'vitest'
import { decisions, harness } from './harness.js'

const createJudge = ({ batch }: { batch: { id: string }[] }) =>
  decisions({ kind: 'create', messages: [batch[0]!.id], workspace: 'api', title: '修登录' })

/** Each crash point leaves exactly one task, one worker session and one acknowledgement. */
function expectNoDuplicates(h: ReturnType<typeof harness>) {
  expect(h.tasks()).toHaveLength(1)
  expect(h.workers()).toHaveLength(1)
  expect(h.workers()[0]!.inputs).toHaveLength(1)
  expect(h.channel.texts().filter((t) => t.startsWith('已新建'))).toHaveLength(1)
  expect(h.store.scan('op/')).toEqual([])
}

describe('crash points (spec §4.2 step 6, §6, §8 idempotency)', () => {
  it('before the commit: nothing is kept and the batch is judged again', async () => {
    const h = harness({ judge: createJudge })
    const set = h.owned.set
    let armed = true
    h.owned.set = (key, value) => {
      if (armed && key === 'task/T-0001') {
        armed = false
        throw new Error('crash')
      }
      return set(key, value)
    }
    await h.say('修一下登录')
    await expect(h.tick()).rejects.toThrow('crash')
    expect(h.tasks()).toEqual([])
    expect(h.store.scan('outbox/')).toEqual([])
    h.restart()
    await h.tick()
    expectNoDuplicates(h)
  })

  it('after the commit, before the effects run: effects run once on restart', async () => {
    const h = harness({ judge: createJudge })
    const list = h.sessions.port.list
    let calls = 0
    // The first list() after the judge's commit is reconcile's, which runs before any op.
    h.sessions.port.list = async () => {
      if (++calls === 2) throw new Error('crash')
      return list()
    }
    await h.say('修一下登录')
    await expect(h.tick()).rejects.toThrow('crash')
    expect(h.tasks()).toHaveLength(1)
    expect(h.workers()).toHaveLength(0)
    expect(h.store.scan('op/')).toHaveLength(1)
    h.restart()
    await h.tick()
    expectNoDuplicates(h)
  })

  it('during the effects, after the call and before its mark: replay by key does not repeat it', async () => {
    const h = harness({ judge: createJudge })
    const start = h.sessions.port.start
    const deliver = h.channel.port.deliver
    let startArmed = true
    let deliverArmed = true
    h.sessions.port.start = async (request) => {
      const result = await start(request)
      if (startArmed && request.role === 'worker') {
        startArmed = false
        throw new Error('crash')
      }
      return result
    }
    h.channel.port.deliver = async (message) => {
      const receipt = await deliver(message)
      if (deliverArmed) {
        deliverArmed = false
        throw new Error('crash')
      }
      return receipt
    }
    await h.say('修一下登录')
    await h.tick()
    h.restart()
    await h.tick()
    await h.tick()
    expectNoDuplicates(h)
    expect(h.channel.calls).toBeGreaterThan(h.channel.delivered.size)
  })

  it('a message sent into a session but not marked is not sent twice', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    h.sessions.finish(sid, 'completed', 'ok')
    await h.tick()
    const admit = h.sessions.port.admitInput
    let armed = true
    h.sessions.port.admitInput = async (sessionId, input) => {
      const result = await admit(sessionId, input)
      if (armed) {
        armed = false
        throw new Error('crash')
      }
      return result
    }
    await h.say('再改一下', { replyTo: id })
    await h.tick()
    h.restart()
    await h.tick()
    expect(h.sessions.sessions.get(sid)!.inputs.filter((i) => i === '再改一下')).toHaveLength(1)
    expect(h.store.scan('op/')).toEqual([])
  })

  it('an enqueued reply is not consumed until the running turn ends', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    await h.say('顺便改下文案', { replyTo: id })
    await h.tick()
    await h.tick()
    expect(h.store.scan('op/')[0]?.value.host).toMatchObject({ state: 'enqueued' })
    expect(h.sessions.sessions.get(sid)!.inputs).toHaveLength(1)
    h.sessions.finish(sid, 'completed', 'ok')
    await h.tick()
    expect(h.sessions.sessions.get(sid)!.inputs.at(-1)).toBe('顺便改下文案')
    expect(h.task(id).state).toBe('running')
  })

  it('the inbox drops a repeated event id', async () => {
    const h = harness()
    expect(await h.say('一', { eventId: 'x' })).toMatchObject({ kind: 'accepted' })
    expect(await h.say('一', { eventId: 'x' })).toMatchObject({ kind: 'duplicate' })
    expect(h.store.scan('inbox/')).toHaveLength(1)
  })

  it('refuses a malformed signal and an event id too long for a store key at the boundary', async () => {
    const h = harness()
    expect(h.signal({ kind: 'message' })).toMatchObject({ kind: 'invalid' })
    expect(h.signal({ kind: 'message', text: 'x', origin: 'boss' })).toMatchObject({ kind: 'invalid' })
    expect(h.signal({ kind: 'message', text: 'x', eventId: 'e'.repeat(129) })).toMatchObject({ kind: 'invalid' })
    expect(h.store.scan('inbox/')).toEqual([])
  })
})

describe('Host-owned input obligations', () => {
  it('saves every busy pending body separately and lets another task finish across restart and inbox TTL', async () => {
    const h = harness()
    const waiting = await h.create('任务一', 'api')
    const independent = await h.create('任务二', 'web')
    const sid = h.sessionOf(waiting)
    await h.say('第一条完整原话', { eventId: 'pending-one', replyTo: waiting })
    await h.say('第二条完整原话', { eventId: 'pending-two', replyTo: waiting })
    await h.tick()
    h.sessions.finish(h.sessionOf(independent), 'completed', 'Independent result.')
    h.advance(8 * 24 * 60 * 60 * 1000)
    h.restart()
    await h.tick()
    const pending = h.store.scan('op/').filter(({ value }) => value.taskId === waiting)
    expect(pending.map(({ value }) => value.originalText)).toEqual(['第一条完整原话', '第二条完整原话'])
    expect(pending.map(({ value }) => value.target)).toEqual([
      { sessionId: sid, taskId: waiting, taskGeneration: 0, startKey: `${waiting}:0` },
      { sessionId: sid, taskId: waiting, taskGeneration: 0, startKey: `${waiting}:0` },
    ])
    expect(pending.map(({ value }) => value.host.state)).toEqual(['enqueued', 'enqueued'])
    expect(h.store.get('inbox/im:pending-one')).toBeDefined()
    expect(h.store.get('inbox/im:pending-two')).toBeDefined()
    expect(h.task(independent).state).toBe('done')
    expect(h.sessions.sessions.get(sid)!.inputs).toHaveLength(1)
    expect(h.sessions.calls.send).toBe(0)
  })

  it('keeps legacy unknown with its original body instead of borrowing the current generation', async () => {
    const h = harness()
    const id = await h.create('历史任务')
    const sid = h.sessionOf(id)
    h.store.putTask({ ...h.task(id), generation: 1 })
    h.store.set('op/000000900', { seq: 900, taskId: id, kind: 'send', input: '历史未确认原话',
      key: `${id}:old`, inbox: null, busyNoticed: false })
    h.restart()
    await h.tick()
    const old = h.store.get('op/000000900')
    expect(old).toMatchObject({ kind: 'ownerInput', key: `${id}:old`, originalText: '历史未确认原话',
      target: null, request: null, legacy: true })
    expect(h.sessions.sessions.get(sid)!.inputs).toHaveLength(1)
    h.restart()
    await h.tick()
    expect(h.store.get('op/000000900')).toEqual(old)
    expect(h.sessions.calls.send).toBe(0)
  })

  it('rejects changed payload under a persisted source key and keeps its dedupe identity after history pruning', async () => {
    const h = harness()
    const original = { source: 'im', eventId: 'immutable', at: h.now(), kind: 'message', origin: 'owner',
      text: 'Original body.', receiptId: 'host-receipt' }
    expect(await h.engine.receive(original)).toMatchObject({ kind: 'accepted' })
    expect(await h.engine.receive({ ...original, text: 'Other body.' })).toMatchObject({ kind: 'invalid' })
    h.store.delete('inbox/im:immutable')
    h.restart()
    expect(await h.engine.receive(original)).toMatchObject({ kind: 'duplicate' })
    expect(await h.engine.receive({ ...original, receiptId: 'other-receipt' })).toMatchObject({ kind: 'invalid' })
  })
})
