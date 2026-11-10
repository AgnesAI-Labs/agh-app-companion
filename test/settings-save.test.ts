import { describe, expect, it } from 'vitest'
import { createSaver } from '../client/settings-save.js'

/** A platform stand-in: approval binds to the operation id, a finished id is a no-op. */
function platform() {
  const approved = new Set<string>()
  const done = new Map<string, string>()
  const applied: string[] = []
  const calls: string[] = []
  const effect = async (input: { ownerName: string }, { operationId }: { operationId: string }) => {
    calls.push(operationId)
    if (done.has(operationId)) return { state: 'completed', operationId }
    if (!approved.has(operationId)) return { state: 'approval-required', operationId }
    done.set(operationId, input.ownerName)
    applied.push(input.ownerName)
    return { state: 'completed', operationId }
  }
  return { effect, approved, applied, calls }
}
let n = 0
const ids = () => `op-${++n}`

describe('settings save operation ids', () => {
  it('resends the approved id so the retry applies', async () => {
    const p = platform()
    const save = createSaver(p.effect as never, ids)
    expect((await save({ ownerName: 'A' } as never)).state).toBe('approval-required')
    p.approved.add(p.calls[0]!)
    expect((await save({ ownerName: 'A' } as never)).state).toBe('completed')
    expect(p.calls[1]).toBe(p.calls[0])
    expect(p.applied).toEqual(['A'])
  })

  it('gives a changed payload a new id, and applies two completed saves of different payloads', async () => {
    const p = platform()
    const save = createSaver(p.effect as never, ids)
    await save({ ownerName: 'A' } as never)
    p.approved.add(p.calls[0]!)
    await save({ ownerName: 'A' } as never)
    await save({ ownerName: 'B' } as never)
    expect(p.calls[2]).not.toBe(p.calls[0])
    p.approved.add(p.calls[2]!)
    await save({ ownerName: 'B' } as never)
    expect(p.applied).toEqual(['A', 'B'])
  })

  it('uses a fresh id for the same payload after the previous save completed', async () => {
    const p = platform()
    const save = createSaver(p.effect as never, ids)
    await save({ ownerName: 'A' } as never)
    p.approved.add(p.calls[0]!)
    await save({ ownerName: 'A' } as never)
    await save({ ownerName: 'A' } as never)
    expect(p.calls[2]).not.toBe(p.calls[1])
  })

  it('keeps the id when the call throws, so the retry cannot double apply', async () => {
    const seen: string[] = []
    let fail = true
    const save = createSaver(async (_i: unknown, { operationId }: { operationId: string }) => {
      seen.push(operationId)
      if (fail) throw new Error('lost')
      return { state: 'completed' }
    }, ids)
    await expect(save({ ownerName: 'A' } as never)).rejects.toThrow('lost')
    fail = false
    await save({ ownerName: 'A' } as never)
    expect(seen[1]).toBe(seen[0])
  })
})
