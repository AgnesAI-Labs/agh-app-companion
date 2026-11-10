import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ROLES, startRequest } from '../sessions.mjs'
import { fakeSessions } from './fake-sessions.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('session roles', () => {
  it('starts each role on its own Bundle of this package with the spec permission and retention', () => {
    expect(startRequest('judge', { workspace: '/work/companion', input: 'batch', startKey: 'b1' })).toEqual({
      role: 'judge',
      bundle: `${pkg.name}#judge`,
      permission: 'read-only',
      retention: 'ephemeral',
      workspace: '/work/companion',
      input: 'batch',
      startKey: 'b1',
    })
    expect(
      startRequest('worker', { workspace: '/work/api', input: 'task', startKey: 't1', model: 'big' }),
    ).toMatchObject({ bundle: `${pkg.name}#worker`, permission: 'full-access', retention: 'task', model: 'big' })
  })

  it('names only Bundles the package declares', () => {
    for (const role of Object.keys(ROLES)) expect(pkg.agnes.bundles).toHaveProperty(role)
  })

  it('omits the model when the owner chose none, so the deployment default applies', () => {
    expect(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k', model: '' })).not.toHaveProperty('model')
  })
})

// Fake G1: these pin the contract this package codes against, not the real platform.
describe('managed sessions contract (fake, not proven on the real platform)', () => {
  it('returns the existing session for a repeated start key', async () => {
    const { port } = fakeSessions()
    const request = startRequest('worker', { workspace: '/w', input: 'x', startKey: 'task-1' })
    const first = await port.start(request)
    expect(await port.start(request)).toEqual({ sessionId: first.sessionId, created: false })
  })

  it('refuses a model route the deployment does not serve instead of falling back', async () => {
    const { port } = fakeSessions({ routes: ['big'] })
    await expect(
      port.start(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k', model: 'missing' })),
    ).rejects.toThrow(/not served/)
  })

  it('accepts a message only while idle, and each idempotency key once', async () => {
    const fake = fakeSessions()
    const { sessionId } = await fake.port.start(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k' }))
    expect(await fake.port.send({ sessionId, input: 'more', idempotencyKey: 'm1' })).toEqual({
      kind: 'notSubmitted',
      reason: 'busy',
    })
    fake.set(sessionId, { kind: 'idle', flags: [] })
    expect(await fake.port.send({ sessionId, input: 'more', idempotencyKey: 'm1' })).toEqual({ kind: 'started' })
    fake.set(sessionId, { kind: 'idle', flags: [] })
    expect(await fake.port.send({ sessionId, input: 'more', idempotencyKey: 'm1' })).toEqual({
      kind: 'notSubmitted',
      reason: 'duplicateKey',
    })
  })

  it('reports waiting on approval as a flag on the status, and usage it cannot give as null', async () => {
    const fake = fakeSessions()
    const { sessionId } = await fake.port.start(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k' }))
    fake.set(sessionId, { kind: 'active', flags: ['waitingOnApproval'] })
    expect((await fake.port.list())[0]?.status).toEqual({ kind: 'active', flags: ['waitingOnApproval'] })
    expect(await fake.port.usage(sessionId)).toEqual({ tokens: null, cost: null })
  })

  it('reports a turn end once as a turn event, with the reply in result, and approval outcomes', async () => {
    const fake = fakeSessions()
    const { sessionId } = await fake.port.start(startRequest('worker', { workspace: '/w', input: 'x', startKey: 'k' }))
    fake.emit(sessionId, { kind: 'approval', state: 'answered', decision: 'refused' })
    fake.finish(sessionId, 'completed', 'done')
    const { events } = await fake.port.events(sessionId)
    expect(events.filter((e) => e.kind === 'turn')).toEqual([{ kind: 'turn', outcome: 'completed' }])
    expect(events).toContainEqual({ kind: 'approval', state: 'answered', decision: 'refused' })
    expect(await fake.port.result(sessionId)).toEqual({ text: 'done' })
  })
})
