import { describe, expect, it } from 'vitest'
import { EVENT_CHUNK_MAX_BYTES, openStore, STORE_FORMAT, StoreFormatError } from '../store.mjs'
import { memoryOwnedStore } from './owned-store.js'

const event = (n: number, pad = 0) => ({ at: '2026-11-10T00:00:00Z', kind: 'note', data: { n, text: 'x'.repeat(pad) } })

describe('companion store', () => {
  it('stamps a fresh store with the current format and reopens it', () => {
    const owned = memoryOwnedStore()
    openStore(owned)
    expect(owned.get('meta')).toEqual({ format: STORE_FORMAT })
    expect(() => openStore(owned)).not.toThrow()
  })

  it('refuses to start on a store written by a newer format and leaves it untouched', () => {
    const owned = memoryOwnedStore()
    owned.set('meta', { format: STORE_FORMAT + 1 })
    owned.set('task/t1', { keep: true })
    const before = new Map(owned.rows)
    expect(() => openStore(owned)).toThrow(StoreFormatError)
    expect(() => openStore(owned)).toThrow(/newer/)
    expect(owned.rows).toEqual(before)
  })

  it.each([
    ['a non-integer format', { format: '1' }],
    ['a missing format field', {}],
    ['a zero format', { format: 0 }],
  ])('refuses %s as unreadable', (_name, meta) => {
    const owned = memoryOwnedStore()
    owned.set('meta', meta as never)
    expect(() => openStore(owned)).toThrow(/unreadable/)
  })

  it('refuses data that has no format stamp instead of adopting it', () => {
    const owned = memoryOwnedStore()
    owned.set('task/t1', { id: 't1' })
    expect(() => openStore(owned)).toThrow(/unreadable/)
    expect(owned.get('meta')).toBeUndefined()
  })

  it('splits a long event history into chunks that each fit the store value cap, in order', () => {
    const owned = memoryOwnedStore()
    const store = openStore(owned)
    store.createTask({ id: 't1', workspace: 'api', createdAt: '2026-11-10T00:00:00Z' })
    const total = 120
    for (let n = 0; n < total; n++) store.appendEvent('t1', event(n, 900))
    const chunks = [...owned.rows].filter(([key]) => key.startsWith('events/t1/'))
    expect(chunks.length).toBeGreaterThan(1)
    for (const [, value] of chunks)
      expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(EVENT_CHUNK_MAX_BYTES)
    expect(store.readEvents('t1').map((e) => (e.data as { n: number }).n)).toEqual(
      Array.from({ length: total }, (_, n) => n),
    )
    expect(store.getTask('t1')).toMatchObject({ id: 't1', workspace: 'api', eventChunks: chunks.length })
  })

  it('refuses one event larger than a chunk and writes nothing', () => {
    const owned = memoryOwnedStore()
    const store = openStore(owned)
    store.createTask({ id: 't1', workspace: 'api', createdAt: '2026-11-10T00:00:00Z' })
    const before = new Map(owned.rows)
    expect(() => store.appendEvent('t1', event(0, EVENT_CHUNK_MAX_BYTES))).toThrow(/too large/)
    expect(owned.rows).toEqual(before)
  })

  it('refuses events for an unknown task and a duplicate task id', () => {
    const store = openStore(memoryOwnedStore())
    expect(() => store.appendEvent('missing', event(0))).toThrow(/unknown task/)
    store.createTask({ id: 't1', workspace: 'api', createdAt: '2026-11-10T00:00:00Z' })
    expect(() => store.createTask({ id: 't1', workspace: 'web', createdAt: '2026-11-10T00:00:00Z' })).toThrow(
      /exists/,
    )
  })
})
