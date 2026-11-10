import type {
  ManagedSessions,
  SendResult,
  SessionEvent,
  SessionStatus,
  StartRequest,
} from '../sessions.mjs'

type FakeSession = {
  sessionId: string
  request: StartRequest
  status: SessionStatus
  archived: boolean
  events: SessionEvent[]
  result?: string
  keys: Set<string>
}

/**
 * Stands in for the platform's plugin-managed sessions (G1) until it exists. Tests drive status
 * changes with `set`; nothing here proves the real platform behaves the same way.
 */
export function fakeSessions(options: { routes?: readonly string[] } = {}) {
  const sessions = new Map<string, FakeSession>()
  const byStartKey = new Map<string, string>()
  const get = (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`unknown session ${sessionId}`)
    return session
  }
  const port: ManagedSessions = {
    async start(request) {
      const existing = byStartKey.get(request.startKey)
      if (existing) return { sessionId: existing, created: false }
      if (request.model && !options.routes?.includes(request.model))
        throw new Error(`model route ${request.model} is not served`)
      const sessionId = `s${sessions.size + 1}`
      sessions.set(sessionId, {
        sessionId,
        request,
        status: { kind: 'active', flags: [] },
        archived: false,
        events: [{ kind: 'status', status: { kind: 'active', flags: [] } }],
        keys: new Set(),
      })
      byStartKey.set(request.startKey, sessionId)
      return { sessionId, created: true }
    },
    async send({ sessionId, idempotencyKey }): Promise<SendResult> {
      const session = get(sessionId)
      if (session.archived) return { kind: 'notSubmitted', reason: 'archived' }
      if (session.keys.has(idempotencyKey)) return { kind: 'notSubmitted', reason: 'duplicateKey' }
      if (session.status.kind !== 'idle') return { kind: 'notSubmitted', reason: 'busy' }
      session.keys.add(idempotencyKey)
      session.status = { kind: 'active', flags: [] }
      return { kind: 'started' }
    },
    async list() {
      return [...sessions.values()].map(({ sessionId, request, status, archived }) => ({
        sessionId,
        startKey: request.startKey,
        role: request.role,
        status,
        archived,
      }))
    },
    async events(sessionId, cursor = 0) {
      const events = get(sessionId).events
      return { events: events.slice(cursor), cursor: events.length }
    },
    async result(sessionId) {
      const { result } = get(sessionId)
      return result === undefined ? undefined : { text: result }
    },
    async usage() {
      return { tokens: null, cost: null }
    },
    async interrupt(sessionId) {
      const session = get(sessionId)
      session.status = { kind: 'idle', flags: [] }
    },
    async archive(sessionId) {
      get(sessionId).archived = true
    },
  }
  return {
    port,
    set(sessionId: string, status: SessionStatus, result?: string) {
      const session = get(sessionId)
      session.status = status
      session.events.push({ kind: 'status', status })
      if (result !== undefined) session.result = result
    },
  }
}
