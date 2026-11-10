import type {
  ManagedSessions,
  SendResult,
  SessionEvent,
  SessionStatus,
  StartRequest,
  TurnOutcome,
  Usage,
} from '../sessions.mjs'

type FakeSession = {
  sessionId: string
  request: StartRequest
  status: SessionStatus
  archived: boolean
  events: SessionEvent[]
  result?: string
  keys: Set<string>
  usage: Usage
  inputs: string[]
}

/** A scripted turn end: the fake finishes the turn as soon as it starts. */
export type Reply = { outcome: TurnOutcome; text?: string } | undefined

/**
 * Stands in for the platform's plugin-managed sessions (G1) until it exists. Tests drive status
 * changes with `set`, `emit` and `finish`; nothing here proves the real platform behaves the same way.
 * `reply` scripts a turn's end from its input, which is how judge decisions are replayed.
 */
export function fakeSessions(
  options: { routes?: readonly string[]; reply?: (request: StartRequest, input: string) => Reply } = {},
) {
  const sessions = new Map<string, FakeSession>()
  const byStartKey = new Map<string, string>()
  let made = 0
  const get = (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`unknown session ${sessionId}`)
    return session
  }
  const setStatus = (session: FakeSession, status: SessionStatus) => {
    session.status = status
    session.events.push({ kind: 'status', status })
  }
  const finish = (session: FakeSession, outcome: TurnOutcome, text?: string) => {
    if (text !== undefined) session.result = text
    setStatus(session, { kind: 'idle', flags: [] })
    session.events.push({ kind: 'turn', outcome })
  }
  const begin = (session: FakeSession, input: string) => {
    session.inputs.push(input)
    setStatus(session, { kind: 'active', flags: [] })
    const scripted = options.reply?.(session.request, input)
    if (scripted) finish(session, scripted.outcome, scripted.text)
  }
  const port: ManagedSessions = {
    async start(request) {
      const existing = byStartKey.get(request.startKey)
      if (existing) return { sessionId: existing, created: false }
      if (request.model && !options.routes?.includes(request.model))
        throw new Error(`model route ${request.model} is not served`)
      const sessionId = `s${++made}`
      const session: FakeSession = {
        sessionId,
        request,
        status: { kind: 'notLoaded', flags: [] },
        archived: false,
        events: [],
        keys: new Set(),
        usage: { tokens: null, cost: null },
        inputs: [],
      }
      sessions.set(sessionId, session)
      byStartKey.set(request.startKey, sessionId)
      begin(session, request.input)
      return { sessionId, created: true }
    },
    async send({ sessionId, input, idempotencyKey }): Promise<SendResult> {
      const session = get(sessionId)
      if (session.archived) return { kind: 'notSubmitted', reason: 'archived' }
      if (session.keys.has(idempotencyKey)) return { kind: 'notSubmitted', reason: 'duplicateKey' }
      if (session.status.kind !== 'idle') return { kind: 'notSubmitted', reason: 'busy' }
      session.keys.add(idempotencyKey)
      begin(session, input)
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
    async usage(sessionId) {
      return { ...get(sessionId).usage }
    },
    async interrupt(sessionId) {
      const session = get(sessionId)
      if (session.status.kind === 'active') finish(session, 'interrupted')
    },
    async archive(sessionId) {
      get(sessionId).archived = true
    },
  }
  return {
    port,
    sessions,
    set(sessionId: string, status: SessionStatus, result?: string) {
      const session = get(sessionId)
      setStatus(session, status)
      if (result !== undefined) session.result = result
    },
    emit(sessionId: string, event: SessionEvent) {
      get(sessionId).events.push(event)
    },
    finish(sessionId: string, outcome: TurnOutcome, text?: string) {
      finish(get(sessionId), outcome, text)
    },
    setUsage(sessionId: string, usage: Usage) {
      get(sessionId).usage = usage
    },
    /** Removes a session from list(), as if the platform lost it. */
    lose(sessionId: string) {
      const session = get(sessionId)
      sessions.delete(sessionId)
      byStartKey.delete(session.request.startKey)
    },
    byRole(role: 'judge' | 'worker') {
      return [...sessions.values()].filter((s) => s.request.role === role)
    },
  }
}
