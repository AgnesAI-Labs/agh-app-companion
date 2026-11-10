import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ROLES, startRequest } from '../sessions.mjs'
import { platformSessions } from '../platform-sessions.mjs'
import { fakeSessions } from './fake-sessions.js'
import { reconcile } from '../reconcile.mjs'
import { harness } from './harness.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('session roles', () => {
  it('starts each role on its own Bundle of this package with the spec permission and retention', () => {
    expect(startRequest('judge', { workspace: '/work/companion', input: 'batch', startKey: 'b1' })).toEqual({
      bundle: `${pkg.name}#judge`,
      permission: 'default',
      retention: 'ephemeral',
      memoryWrites: false,
      skillInstalls: false,
      workspace: '/work/companion',
      input: 'batch',
      startKey: 'b1',
    })
    expect(
      startRequest('worker', { workspace: '/work/api', input: 'task', startKey: 't1', model: { route: 'r', model: 'big' } }),
    ).toEqual({
      bundle: `${pkg.name}#worker`,
      permission: 'full-access',
      retention: 'task',
      memoryWrites: false,
      skillInstalls: false,
      workspace: '/work/api',
      input: 'task',
      startKey: 't1',
      model: { route: 'r', model: 'big' },
    })
  })

  it('names only Bundles the package declares', () => {
    for (const role of Object.keys(ROLES)) expect(pkg.agnes.bundles).toHaveProperty(role)
  })

  it('omits the model when the owner chose none, so the deployment default applies', () => {
    expect(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k' })).not.toHaveProperty('model')
  })
})

// Fake platform port: these pin the shapes this package codes against, not the real platform's behavior.
describe('managed sessions contract (fake, not proven on the real platform)', () => {
  it('returns the existing session for a repeated start key', async () => {
    const { port } = fakeSessions()
    const request = startRequest('worker', { workspace: '/w', input: 'x', startKey: 'task-1' })
    const first = await port.start(request)
    expect(await port.start(request)).toEqual({ sessionId: first.sessionId, created: false })
  })

  it('refuses a model route the deployment does not serve instead of falling back', async () => {
    const { port } = fakeSessions({ routes: [{ route: 'r', model: 'big' }] })
    await expect(
      port.start(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k', model: { route: 'r', model: 'missing' } })),
    ).rejects.toMatchObject({ data: { reason: 'MODEL_ROUTE_MISSING' } })
  })

  it('accepts a message only while idle, and each idempotency key once', async () => {
    const fake = fakeSessions()
    const { sessionId } = await fake.port.start(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k' }))
    expect(await fake.port.send(sessionId, { text: 'more', idempotencyKey: 'm1' })).toEqual({
      state: 'notSubmitted',
      reason: 'busy',
    })
    fake.set(sessionId, { kind: 'idle', flags: [] })
    expect(await fake.port.send(sessionId, { text: 'more', idempotencyKey: 'm1' })).toEqual({ state: 'started' })
    fake.set(sessionId, { kind: 'idle', flags: [] })
    expect(await fake.port.send(sessionId, { text: 'more', idempotencyKey: 'm1' })).toEqual({
      state: 'notSubmitted',
      reason: 'duplicateKey',
    })
  })

  it('reports waiting on approval as a flag on the status, and usage it cannot give as null', async () => {
    const fake = fakeSessions()
    const { sessionId } = await fake.port.start(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k' }))
    fake.set(sessionId, { kind: 'active', flags: ['waitingOnApproval'] })
    expect((await fake.port.list())[0]?.status).toEqual({ kind: 'active', flags: ['waitingOnApproval'] })
    expect(await fake.port.usage(sessionId)).toEqual({ inputTokens: null, outputTokens: null, cost: null })
  })

  it('reports a turn at its start and once more at its end, with the reply in result, and approval outcomes', async () => {
    const fake = fakeSessions()
    const { sessionId } = await fake.port.start(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k' }))
    fake.emit(sessionId, { kind: 'approval', state: 'decided' })
    fake.finish(sessionId, 'completed', 'done')
    const { events, lastSeq } = await fake.port.events(sessionId)
    expect(events.filter((e) => e.kind === 'turn').map((e) => e.kind === 'turn' && e.status)).toEqual(['running', 'completed'])
    expect(events).toContainEqual({ kind: 'approval', seq: 2, state: 'decided', category: 'permission', summary: '' })
    expect((await fake.port.events(sessionId, { afterSeq: lastSeq })).events).toEqual([])
    expect(await fake.port.result(sessionId)).toEqual({ turn: { status: 'completed' }, text: 'done' })
  })
})

describe('the platform adapter and approval outcomes', () => {
  const outcome = { kind: 'approvalOutcome', seq: 5, approvalSeq: 4, outcome: 'rejected', via: 'person' }

  it('passes a platform approvalOutcome event through unchanged, by afterSeq', async () => {
    const calls: unknown[] = []
    const raw = { events: [{ kind: 'approval', seq: 4, state: 'decided', category: 'permission', summary: '' }, outcome], lastSeq: 5 }
    const port = platformSessions({
      events: async (id: string, options?: unknown) => (calls.push([id, options]), raw),
    } as never)!
    expect(await port.events('s1', { afterSeq: 3 })).toEqual(raw)
    expect(calls).toEqual([['s1', { afterSeq: 3 }]])
  })

  it('counts hand-written platform outcomes in reconcile through the real adapter, once across a repeat pass', async () => {
    const h = harness()
    const id = await h.create('修登录')
    const sid = h.sessionOf(id)
    const base = h.task(id).cursor
    const page = [4, 6, 8].flatMap((n) => [
      { kind: 'approval', seq: n, state: 'decided', category: 'permission', summary: '' },
      { kind: 'approvalOutcome', seq: n + 1, approvalSeq: n, outcome: 'rejected', via: 'person' },
    ])
    const platform = {
      ...h.sessions.port,
      events: async (_id: string, o?: { afterSeq?: number }) => ({
        events: page.filter((e) => e.seq > (o?.afterSeq ?? 0)),
        lastSeq: 9,
      }),
    }
    const deps = () => ({
      tx: () => ({ store: h.store, at: h.now(), limits: h.limits, workspaces: ['api', 'web'] }),
      sessions: platformSessions(platform as never)!,
    })
    expect(base).toBeLessThan(4)
    await reconcile(deps() as never)
    expect(h.task(id)).toMatchObject({ state: 'paused', reason: 'refused', refusals: 3, cursor: 9 })
    await reconcile(deps() as never)
    expect(h.task(id)).toMatchObject({ refusals: 3, cursor: 9 })
    expect(sid).toBeTruthy()
  })
})
