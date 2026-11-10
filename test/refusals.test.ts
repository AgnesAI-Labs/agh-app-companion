import { describe, expect, it } from 'vitest'
import { REFUSALS, refusalOf } from '../platform-sessions.mjs'
import { ROLES } from '../sessions.mjs'
import { TEXT } from '../tasks.mjs'
import { harness } from './harness.js'

const MINUTE = 60 * 1000
const nonRetryable = Object.entries(REFUSALS)
  .filter(([, rule]) => !rule.retryable)
  .map(([code]) => code)
const worker =
  (reason: string, missing?: string) =>
  ({ bundle }: { bundle: string }) =>
    bundle === ROLES.worker.bundle ? { reason, ...(missing ? { missing } : {}) } : undefined

describe('platform refusals', () => {
  it.each(nonRetryable)(
    '%s on a worker start: the task parks and the owner gets exactly one message',
    async (code) => {
      const h = harness()
      h.sessions.gate(worker(code, code === 'FULL_ACCESS_UNAVAILABLE' ? 'os-boundary' : undefined))
      const id = await h.create('修登录')
      for (let n = 0; n < 4; n++) await h.tick()
      expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'platform' })
      expect(h.sessions.calls.start).toBe(2)
      const told = h.channel.texts().filter((t) => !t.startsWith('已新建'))
      expect(told).toHaveLength(1)
      expect(told[0]).toMatch(new RegExp(`^${id}（api）修登录：已暂停。`))
      expect(h.store.scan('op/')).toEqual([])
    },
  )

  it('a busy start is retried with the same key and tells the owner nothing', async () => {
    const h = harness()
    h.sessions.gate(worker('SESSION_BUSY'))
    const id = await h.create('修登录')
    await h.tick()
    h.sessions.gate(() => undefined)
    await h.tick()
    expect(h.task(id).state).toBe('running')
    expect(h.workers().map((s) => s.request.startKey)).toEqual([`${id}:0`])
    expect(h.channel.texts()).toEqual([`已新建 ${id}（api）修登录：进行中`])
  })

  it('an unauthorized workspace is told once; a task queued behind it gets only its own pause notice', async () => {
    const h = harness()
    h.sessions.gate(worker('WORKSPACE_NOT_AUTHORIZED'))
    const first = await h.create('修登录')
    const second = await h.create('改文案')
    for (let n = 0; n < 3; n++) await h.tick()
    expect([h.task(first).state, h.task(second).state]).toEqual(['paused', 'paused'])
    expect(h.channel.texts().filter((t) => t.includes('没有授权'))).toEqual([
      `${first}（api）修登录：已暂停。${REFUSALS.WORKSPACE_NOT_AUTHORIZED!.text({ workspace: '/w/api', missing: null })}`,
    ])
    expect(h.store.get('refusal/worker:workspace:/w/api')).toMatchObject({
      code: 'WORKSPACE_NOT_AUTHORIZED',
      taskIds: [first, second],
    })
    expect(h.channel.texts().filter((t) => t.startsWith(second) && !t.startsWith('已新建'))).toEqual([
      `${second}（api）改文案：已暂停（平台拒绝）`,
    ])
  })

  it('full access refused in two workspaces is one message', async () => {
    const h = harness()
    h.sessions.gate(worker('FULL_ACCESS_UNAVAILABLE', 'outward-checkpoint'))
    await h.create('修登录', 'api')
    await h.create('改首页', 'web')
    for (let n = 0; n < 3; n++) await h.tick()
    expect(h.channel.texts().filter((t) => t.includes('完全访问'))).toHaveLength(1)
    expect(h.channel.texts().filter((t) => t.includes('已暂停（平台拒绝）'))).toHaveLength(1)
  })

  it('continuing a parked task opens a new generation; a repeat refusal is told again', async () => {
    const h = harness()
    h.sessions.gate(worker('WORKSPACE_NOT_AUTHORIZED'))
    const id = await h.create('修登录')
    await h.tick()
    await h.say(`继续 ${id}`)
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'platform', generation: 1 })
    expect(h.channel.texts().filter((t) => t.includes('没有授权'))).toHaveLength(2)
    h.sessions.gate(() => undefined)
    await h.say(`继续 ${id}`)
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'running', generation: 2 })
    expect(h.workers().map((s) => s.request.startKey)).toEqual([`${id}:2`])
    expect(h.store.scan('refusal/')).toEqual([])
  })

  it('a refused send parks the task and keeps the owner message for after the continue', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    h.sessions.finish(sid, 'completed', 'ok')
    await h.tick()
    h.sessions.gate(worker('WORKSPACE_NOT_AUTHORIZED'))
    await h.say('再改一下', { replyTo: id })
    await h.tick()
    await h.tick()
    expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'platform', sessionId: sid })
    expect(h.channel.texts().filter((t) => t.includes('没有授权'))).toHaveLength(1)
    h.sessions.gate(() => undefined)
    await h.say(`继续 ${id}`)
    await h.tick()
    await h.tick()
    expect(h.sessions.sessions.get(sid)!.inputs).toContain('再改一下')
  })

  it('a refused judge start is told once, not as the model being down, and its messages stay queued', async () => {
    const h = harness()
    h.sessions.gate(({ bundle }) =>
      bundle === ROLES.judge.bundle ? { reason: 'WORKSPACE_NOT_AUTHORIZED' } : undefined,
    )
    await h.say('修一下登录')
    for (let n = 0; n < 6; n++) {
      await h.tick()
      h.advance(31 * MINUTE)
    }
    expect(h.channel.texts()).toEqual([
      `你的消息还在排队，伴侣现在不能判断。${REFUSALS.WORKSPACE_NOT_AUTHORIZED!.text({ workspace: '/w/companion', missing: null })}`,
    ])
    expect(h.channel.texts()).not.toContain(TEXT.judgeDown)
    h.sessions.gate(() => undefined)
    await h.tick()
    expect(h.store.scan('inbox/').every((row) => row.value.disposition !== null)).toBe(true)
    expect(h.store.scan('refusal/')).toEqual([])
  })

  it('a judge batch replayed after its session was archived runs under a new key', async () => {
    const h = harness()
    await h.say('你好')
    const result = h.sessions.port.result
    const transaction = h.owned.transaction
    let armed = true
    h.sessions.port.result = async (sessionId) => {
      const value = await result(sessionId)
      // Crash at the commit that follows the read, as if the process died there.
      if (armed && value.turn) {
        armed = false
        h.owned.transaction = () => {
          h.owned.transaction = transaction
          throw new Error('crash')
        }
      }
      return value
    }
    await expect(h.tick()).rejects.toThrow('crash')
    expect(h.store.get('judge/batch')).toMatchObject({ attempt: 0 })
    h.restart()
    await h.tick()
    expect(h.sessions.byRole('judge').map((s) => s.request.startKey.slice(-2))).toEqual([':0', ':1'])
    expect(h.store.get('judge/batch')).toBeUndefined()
    expect(h.store.scan('inbox/').every((row) => row.value.disposition !== null)).toBe(true)
  })

  it('reads the gate from the platform error, and treats an error without one as a lost call', () => {
    expect(
      refusalOf({
        code: -32010,
        message: 'CAPABILITY_DENIED',
        data: { reason: 'FULL_ACCESS_UNAVAILABLE', missing: 'os-boundary', code: 'CAPABILITY_DENIED' },
      }),
    ).toMatchObject({
      code: 'FULL_ACCESS_UNAVAILABLE',
      missing: 'os-boundary',
      retryable: false,
    })
    expect(
      refusalOf({ code: -32010, message: 'CAPABILITY_DENIED', data: { code: 'CAPABILITY_DENIED' } }),
    ).toMatchObject({ code: 'CAPABILITY_DENIED', retryable: false })
    expect(refusalOf({ data: { reason: 'SOMETHING_NEW', code: 'CAPABILITY_DENIED' } })).toMatchObject({
      code: 'SOMETHING_NEW',
      retryable: false,
    })
    expect(refusalOf(new Error('worker channel closed'))).toBeUndefined()
  })
})
