import type { OwnedStore } from '../../../../packages/extension-api/src/index.js'
import { ownedStore } from '../../../../packages/host-extensions/src/profile/owned-store.js'

/** The Host's own OwnedStore over an in-memory namespace, so value caps and sync-only transactions are real. */
export function memoryOwnedStore(): OwnedStore & { rows: Map<string, unknown> } {
  let rows = new Map<string, unknown>()
  const namespace = {
    get: (key: string) => structuredClone(rows.get(key)),
    set: (key: string, value: unknown) => void rows.set(key, structuredClone(value)),
    delete: (key: string) => void rows.delete(key),
    entries: () => [...rows].map(([key, value]) => ({ key, value: structuredClone(value) })),
    transaction<T>(fn: () => T): T {
      const before = new Map(rows)
      try {
        return fn()
      } catch (error) {
        rows = before
        throw error
      }
    },
  }
  const store = ownedStore(namespace, () => {}, true)
  return {
    ...store,
    get rows() {
      return rows
    },
  }
}
