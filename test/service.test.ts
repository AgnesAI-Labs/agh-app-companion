import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startEngine } from '../index.mjs'
import { LIMITS } from '../limits.mjs'
import { REFUSALS } from '../platform-sessions.mjs'
import { ROLES } from '../sessions.mjs'
import { DEFAULT_SETTINGS } from '../settings.mjs'
import { fakeGateway, OWNER } from './fake-gateway.js'
import { fakeSessions } from './fake-sessions.js'
import { decisions, readJudgeInput, SETTINGS } from './harness.js'
import { HOST_ROWS, memoryOwnedStore } from './owned-store.js'

type Shutdown = (reason: 'disable' | 'upgrade' | 'exit') => Promise<{ state: 'settled' | 'unknown' }>

function scripted() {
  return fakeSessions({
    reply(request, input) {
      if (request.bundle === ROLES.worker.bundle) return { outcome: 'completed', text: '改好了，测试通过' }
      const { batch } = readJudgeInput(input)
      return {
        outcome: 'completed',
        text: decisions({ kind: 'create', messages: [batch[0]!.id], workspace: 'api', title: '修登录报错' }),
      }
    },
  })
}

function service(
  options: {
    store?: ReturnType<typeof memoryOwnedStore>
    sessions?: unknown
    gateway?: ReturnType<typeof fakeGateway> | null
    config?: unknown
  } = {},
) {
  const store = options.store ?? memoryOwnedStore()
  const controller = new AbortController()
  let shutdown: Shutdown | undefined
  const init = {
    signal: controller.signal,
    store,
    wakes: {} as never,
    config: (options.config ?? SETTINGS) as never,
    listeners: {},
    assertCurrent: () => {},
    ready: vi.fn(),
    onShutdown: vi.fn((handler: Shutdown) => {
      shutdown = handler
    }),
    ...(options.sessions ? { sessions: options.sessions } : {}),
  }
  const gateway = options.gateway
  const started = startEngine(init as never, { resolveGateway: () => gateway?.port })
  return {
    store,
    init,
    started,
    shutdown: (reason: 'disable' | 'upgrade' | 'exit' = 'exit') => shutdown!(reason),
  }
}

const tick = () => vi.advanceTimersByTimeAsync(LIMITS.tickIntervalMs)
const bodies = (gateway: ReturnType<typeof fakeGateway>) =>
  gateway.shown.map((m) => m.message.blocks[0].body as string)

describe('companion service', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T08:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the owner caps from settings: the desk shows them and unset caps stay off', async () => {
    const withCaps = await service({ sessions: scripted().port, config: { ...SETTINGS, caps: { dailyCost: 4, taskCost: null, taskTokens: 5000 } } }).started
    expect(((await withCaps.desk()) as any).usage.caps).toMatchObject({ dailyCost: 4, taskCost: null, taskTokens: 5000 })
    const without = await service({ sessions: scripted().port, config: SETTINGS }).started
    expect(((await without.desk()) as any).usage.caps).toMatchObject({ dailyCost: null, taskCost: null, taskTokens: null })
    const old = await service({ sessions: scripted().port, config: (({ caps, ...rest }) => rest)(SETTINGS as any) }).started
    expect(((await old.desk()) as any).usage.caps).toMatchObject({ dailyCost: null })
  })

  it('runs the whole loop: a chat message becomes a task, its worker runs, and the result comes back', async () => {
    const sessions = scripted()
    const gateway = fakeGateway()
    const s = service({ sessions: sessions.port, gateway })
    const svc = await s.started
    expect(s.init.ready).toHaveBeenCalledOnce()
    expect(svc.status()).toEqual({ running: true, problems: [] })
    expect(await svc.receive(gateway.message('登录页报错了，修一下'))).toMatchObject({ kind: 'accepted' })
    await tick()
    await tick()
    const [judge] = sessions.byRole('judge')
    expect(judge!.request).toMatchObject({
      permission: 'default',
      retention: 'ephemeral',
      memoryWrites: false,
      skillInstalls: false,
      workspace: '/w/companion',
    })
    const [worker] = sessions.byRole('worker')
    expect(worker!.request).toMatchObject({
      permission: 'full-access',
      retention: 'task',
      memoryWrites: false,
      skillInstalls: false,
      workspace: '/w/api',
      startKey: 'T-0001:0',
    })
    expect(worker!.request).not.toHaveProperty('model')
    expect(bodies(gateway)).toEqual([
      '已新建 T-0001（api）修登录报错：进行中',
      'T-0001（api）修登录报错：完成\n\n改好了，测试通过',
    ])
    expect(gateway.shown.every((m) => m.chatId === OWNER.chatId)).toBe(true)
    expect(s.store.get('meta')).toMatchObject({ channelOwner: { instanceId: 'im-1', userId: OWNER.userId } })
    await s.shutdown()
  })

  it('starts on the namespace the Host prepared and leaves its rows alone', async () => {
    const s = service({ sessions: scripted().port, gateway: fakeGateway() })
    const svc = await s.started
    expect(s.init.ready).toHaveBeenCalledOnce()
    expect(svc.status()).toEqual({ running: true, problems: [] })
    for (const [key, value] of HOST_ROWS) expect(s.store.rows.get(key)).toEqual(value)
    await s.shutdown()
  })

  it('registers its shutdown handler before a refused store throws, and that handler settles', async () => {
    const owned = memoryOwnedStore()
    owned.set('task/t1', { id: 't1' })
    const s = service({ store: owned })
    await expect(s.started).rejects.toThrow(/unreadable/)
    expect(s.init.onShutdown).toHaveBeenCalledOnce()
    expect(s.init.ready).not.toHaveBeenCalled()
    expect(owned.get('meta')).toBeUndefined()
    await expect(s.shutdown()).resolves.toEqual({ state: 'settled' })
  })

  it('becomes ready without init.sessions and says which platform capability is missing', async () => {
    const gateway = fakeGateway()
    const s = service({ gateway })
    const svc = await s.started
    expect(s.init.ready).toHaveBeenCalledOnce()
    expect(svc.status()).toMatchObject({
      running: false,
      problems: [{ kind: 'capability', missing: 'managedSessions' }],
    })
    expect(await svc.receive(gateway.message('在吗'))).toMatchObject({
      kind: 'dropped',
      reason: expect.stringContaining('init.sessions'),
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(await s.shutdown()).toEqual({ state: 'settled' })
  })

  it('reports unfinished settings instead of running, and touches no session', async () => {
    const sessions = scripted()
    const s = service({ sessions: sessions.port, gateway: fakeGateway(), config: DEFAULT_SETTINGS })
    const svc = await s.started
    expect(svc.status()).toEqual({
      running: false,
      problems: [
        {
          kind: 'settings',
          missing: ['ownerName', 'workspaces', 'dedicatedWorkspace', 'channelInstance'],
          text: expect.any(String),
        },
      ],
    })
    expect(sessions.calls).toEqual({ start: 0, send: 0 })
    await s.shutdown()
  })

  it('reports a model route it cannot pass on instead of replacing it with the default', async () => {
    const config = {
      ...SETTINGS,
      models: { judge: { route: 'local-small', local: true }, worker: { route: '', local: false } },
    }
    const s = service({ sessions: scripted().port, gateway: fakeGateway(), config })
    expect((await s.started).status()).toMatchObject({
      running: false,
      problems: [{ kind: 'model', roles: ['judge'] }],
    })
    await s.shutdown()
  })

  it('runs without a channel when no gateway resolves, keeps replies pending and says so', async () => {
    const sessions = scripted()
    const s = service({ sessions: sessions.port, gateway: null })
    const svc = await s.started
    expect(svc.status()).toMatchObject({
      running: true,
      problems: [{ kind: 'channel', text: expect.stringContaining('gateway is not available') }],
    })
    expect(await svc.receive({ kind: 'message' })).toMatchObject({ kind: 'dropped' })
    expect(s.store.get('meta')).not.toHaveProperty('channelOwner')
    await s.shutdown()
  })

  it('reports the channel refusing at open', async () => {
    const s = service({ sessions: scripted().port, gateway: fakeGateway({ running: false }) })
    expect((await s.started).status().problems).toEqual([
      { kind: 'channel', text: 'channel instance im-1 is not running' },
    ])
    await s.shutdown()
  })

  it('tells the owner once when the platform refuses full access, parks the task and shows the refusal in status', async () => {
    const sessions = scripted()
    sessions.gate(({ bundle }) =>
      bundle === ROLES.worker.bundle
        ? { reason: 'FULL_ACCESS_UNAVAILABLE', missing: 'outward-checkpoint' }
        : undefined,
    )
    const gateway = fakeGateway()
    const s = service({ sessions: sessions.port, gateway })
    const svc = await s.started
    await svc.receive(gateway.message('登录页报错了，修一下'))
    for (let n = 0; n < 5; n++) await tick()
    const refusals = bodies(gateway).filter((b) => b.includes('完全访问'))
    expect(refusals).toEqual([
      `T-0001（api）修登录报错：已暂停。${REFUSALS.FULL_ACCESS_UNAVAILABLE!.text({ workspace: '/w/api', missing: 'outward-checkpoint' })}`,
    ])
    expect(gateway.shown).toHaveLength(2)
    expect(sessions.byRole('worker')).toHaveLength(0)
    expect(svc.store.getTask('T-0001')).toMatchObject({ state: 'paused', reason: 'platform' })
    expect(svc.status().problems).toEqual([
      expect.objectContaining({
        kind: 'refusal',
        role: 'worker',
        code: 'FULL_ACCESS_UNAVAILABLE',
        missing: 'outward-checkpoint',
        taskIds: ['T-0001'],
      }),
    ])
    await s.shutdown()
  })

  it('reports a port that refuses every call, as one whose declaration was not granted', async () => {
    const denied = new Proxy(
      {},
      {
        get: () => async () =>
          Promise.reject({ code: -32010, message: 'CAPABILITY_DENIED', data: { code: 'CAPABILITY_DENIED' } }),
      },
    )
    const s = service({ sessions: denied, gateway: fakeGateway() })
    const svc = await s.started
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.status().problems).toEqual([
      { kind: 'capability', missing: 'managedSessions', text: expect.stringContaining('not granted') },
    ])
    await s.shutdown()
  })

  it('delivers a pending reply once after a restart with the same owner', async () => {
    const owned = memoryOwnedStore()
    const gateway = fakeGateway()
    const first = service({ store: owned, sessions: scripted().port, gateway })
    const svc = await first.started
    gateway.setMode('down')
    await svc.receive(gateway.message('登录页报错了，修一下'))
    await tick()
    expect(gateway.shown).toHaveLength(0)
    await first.shutdown()
    gateway.setMode('ok')
    const second = service({ store: owned, sessions: scripted().port, gateway })
    await second.started
    await tick()
    await tick()
    expect(bodies(gateway).filter((b) => b.startsWith('已新建 T-0001'))).toHaveLength(1)
    await second.shutdown()
  })

  it('after a long gap the service reads what the platform did meanwhile before its first pass, and repeats nothing', async () => {
    const owned = memoryOwnedStore()
    const gateway = fakeGateway()
    const sessions = fakeSessions({
      reply(request, input) {
        if (request.bundle === ROLES.worker.bundle) return undefined
        const { batch } = readJudgeInput(input)
        return { outcome: 'completed', text: decisions({ kind: 'create', messages: [batch[0]!.id], workspace: 'api', title: '修登录报错' }) }
      },
    })
    const first = service({ store: owned, sessions: sessions.port, gateway })
    const svc = await first.started
    await svc.receive(gateway.message('登录页报错了，修一下'))
    await tick()
    await tick()
    await first.shutdown()
    const [worker] = sessions.byRole('worker')
    sessions.finish(worker!.sessionId, 'completed', '改好了')
    await vi.advanceTimersByTimeAsync(9 * 60 * 60 * 1000)
    const second = service({ store: owned, sessions: sessions.port, gateway })
    const again = await second.started
    await vi.advanceTimersByTimeAsync(0)
    expect(((await again.desk()) as any).tasks.recent).toEqual([expect.objectContaining({ id: 'T-0001', state: 'done' })])
    await tick()
    await tick()
    expect(bodies(gateway).filter((b) => b.includes('：完成'))).toHaveLength(1)
    expect(sessions.byRole('worker')).toHaveLength(1)
    expect(sessions.byRole('judge')).toHaveLength(1)
    expect(worker!.inputs).toHaveLength(1)
    await second.shutdown()
  })

  it('refuses a store bound to another owner: nothing delivered, no status answered, nothing deleted', async () => {
    const owned = memoryOwnedStore()
    const gateway = fakeGateway()
    const first = service({ store: owned, sessions: scripted().port, gateway })
    const svc = await first.started
    gateway.setMode('down')
    await svc.receive(gateway.message('登录页报错了，修一下'))
    await tick()
    await first.shutdown()
    const rows = owned.rows.size
    gateway.setMode('ok')
    gateway.rebind(gateway.nextOwner)
    const sessions = scripted()
    const second = service({ store: owned, sessions: sessions.port, gateway })
    const next = await second.started
    await tick()
    expect(next.status()).toMatchObject({
      running: false,
      problems: [
        {
          kind: 'owner',
          recorded: { userId: OWNER.userId },
          current: { userId: gateway.nextOwner.userId },
          text: expect.stringContaining('clear the companion'),
        },
      ],
    })
    const status = gateway.message('状态', {
      chat: { id: gateway.nextOwner.chatId, type: 'dm' },
      sender: { userId: gateway.nextOwner.userId },
    })
    expect(await next.receive(status)).toMatchObject({ kind: 'dropped' })
    expect(gateway.shown).toHaveLength(0)
    expect(sessions.calls).toEqual({ start: 0, send: 0 })
    expect(owned.rows.size).toBe(rows)
    expect(owned.get('meta')).toMatchObject({ channelOwner: { userId: OWNER.userId } })
    await second.shutdown()
  })

  it('leaves no timer and no listener after shutdown', async () => {
    const s = service({ sessions: scripted().port, gateway: fakeGateway() })
    await s.started
    await tick()
    expect(vi.getTimerCount()).toBe(1)
    const added = vi.spyOn(s.init.signal, 'addEventListener')
    const removed = vi.spyOn(s.init.signal, 'removeEventListener')
    expect(await s.shutdown('disable')).toEqual({ state: 'settled' })
    expect(vi.getTimerCount()).toBe(0)
    expect(added).not.toHaveBeenCalled()
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
    await vi.advanceTimersByTimeAsync(10 * LIMITS.tickIntervalMs)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for a pass in flight at shutdown, and reports unknown when it outlasts the settle time', async () => {
    const sessions = scripted()
    let release = () => {}
    const list = sessions.port.list
    sessions.port.list = () =>
      new Promise((resolve) => {
        release = () => resolve(list())
      })
    const s = service({ sessions: sessions.port, gateway: fakeGateway() })
    await s.started
    const settling = s.shutdown()
    await vi.advanceTimersByTimeAsync(LIMITS.shutdownSettleMs)
    expect(await settling).toEqual({ state: 'unknown' })
    expect(vi.getTimerCount()).toBe(0)
    release()
    await vi.advanceTimersByTimeAsync(LIMITS.tickIntervalMs)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('takes the desk\'s message with no chat channel, creates the task, and keeps the reply for the chat', async () => {
    const sessions = scripted()
    const s = service({ sessions: sessions.port, gateway: null })
    const svc = await s.started
    expect(await svc.desk()).toMatchObject({ running: true, canSubmit: true, submitBlock: null, problems: [{ kind: 'channel' }] })
    expect(svc.submit({ kind: 'message', text: '登录页报错了，修一下' }, 'op-1')).toEqual({ ok: true, result: 'accepted' })
    await tick()
    await tick()
    const view: any = await svc.desk()
    expect(view.tasks.recent).toMatchObject([{ id: 'T-0001', state: 'done', workspace: 'api' }])
    expect(view.messages).toMatchObject([{ state: 'created', taskIds: ['T-0001'], replies: [{ text: '已新建 T-0001（api）修登录报错：进行中', sent: false }] }])
    expect(s.store.get('inbox/desk:op-1')).toMatchObject({ signal: { source: 'desk', origin: 'owner' } })
    await s.shutdown()
  })

  it('answers the desk with the problems and no tasks when settings are unfinished, and refuses its input', async () => {
    const s = service({ sessions: scripted().port, gateway: fakeGateway(), config: DEFAULT_SETTINGS })
    const svc = await s.started
    expect(await svc.desk()).toMatchObject({ running: false, canSubmit: false, problems: [{ kind: 'settings' }], tasks: { running: [], needsYou: [] } })
    expect(svc.submit({ kind: 'message', text: '在吗' }, 'op-1')).toMatchObject({ ok: false, code: 'not-running' })
    expect([...s.store.rows.keys()].filter((key) => key.startsWith('inbox/'))).toEqual([])
    await s.shutdown()
  })

  it('stops taking desk input once shut down', async () => {
    const s = service({ sessions: scripted().port, gateway: null })
    const svc = await s.started
    await s.shutdown()
    expect(svc.submit({ kind: 'message', text: '在吗' }, 'op-1')).toMatchObject({ ok: false, code: 'not-running' })
  })
})
