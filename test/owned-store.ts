import type { OwnedStore } from '../../../../packages/extension-api/src/index.js'
import { ownedStore } from '../../../../packages/host-extensions/src/profile/owned-store.js'

/**
 * The rows the Host writes into a managed service's namespace before it calls `start`
 * (managed.ts handoverManagedMarker, then the owner/incarnation/shutdown marker), with the shapes
 * the platform stores them in. `managed-config:<id>` appears only after a configure, so it is not here.
 */
export const HOST_ROWS: readonly (readonly [string, unknown])[] = [
  ['managed-binding:companion', { owner: 'companion', activation: 'rev-1', integrity: 'sha256-test' }],
  ['managed-process:companion', { pid: 4242, startId: 'Tue Nov 10 08:00:00 2026' }],
  ['managed-incarnation:companion', '5b0c4a52-6f6e-4a53-9d0a-0d6f7f3e1c11'],
  ['managed-shutdown:companion', true],
  ['managed-marker-revision:companion', '0d3c1a8e-2b7f-4f0e-8c35-7a3f6c1d9e22'],
]

/**
 * The Host's own OwnedStore over an in-memory namespace, so value caps and sync-only transactions are real.
 * It starts with the Host's marker rows, as a real managed service finds its namespace; pass
 * `{ host: false }` for an empty namespace.
 */
export function memoryOwnedStore({ host = true }: { host?: boolean } = {}): OwnedStore & { rows: Map<string, unknown> } {
  let rows = new Map<string, unknown>(host ? HOST_ROWS : [])
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
