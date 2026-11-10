import type {
  ManagedSessions,
  ModelRef,
  SendResult,
  SessionEvent,
  SessionStatus,
  SessionUsage,
  StartRequest,
  ToolResult,
  TurnEnd,
} from '../sessions.mjs'
import { ROLES } from '../sessions.mjs'

type FakeSession = {
  sessionId: string
  request: StartRequest
  status: SessionStatus
  archived: boolean
  events: SessionEvent[]
  seq: number
  turns: number
  ended: { status: TurnEnd } | null
  result: string | null
  keys: Set<string>
  usage: SessionUsage
  results: Map<number, ToolResult>
  inputs: string[]
}

/** A scripted turn end: the fake finishes the turn as soon as it starts. */
export type Reply = { outcome: TurnEnd; text?: string } | undefined

/** A gate refusal as the platform raises it: an RPC error whose data names the gate. */
export type Refusal = { reason: string; missing?: string }
export const rpcRefusal = ({ reason, missing }: Refusal) => ({
  code: -32010,
  message: 'CAPABILITY_DENIED',
  data: { reason, ...(missing ? { missing } : {}), code: 'CAPABILITY_DENIED' },
})

type Gate = (input: { op: 'start' | 'send'; workspace: string; bundle: string }) => Refusal | undefined

/**
 * Stands in for the platform's plugin-managed sessions in the platform's shapes (managed-sessions.ts).
 * Tests drive status changes with `set`, `emit` and `finish`, and gate refusals with `gate`; nothing
 * here proves the real platform behaves the same way. `reply` scripts a turn's end from its input,
 * which is how judge decisions are replayed.
 */
export function fakeSessions(
  options: { routes?: readonly ModelRef[]; reply?: (request: StartRequest, input: string) => Reply } = {},
) {
  const sessions = new Map<string, FakeSession>()
  const byStartKey = new Map<string, string>()
  let made = 0
  let gate: Gate = () => undefined
  const calls = { start: 0, send: 0 }
  const get = (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`unknown session ${sessionId}`)
    return session
  }
  const push = (session: FakeSession, event: Record<string, unknown>) => {
    session.events.push({ ...event, seq: ++session.seq } as SessionEvent)
  }
  const finish = (session: FakeSession, outcome: TurnEnd, text?: string) => {
    if (text !== undefined) session.result = text
    session.status = { kind: 'idle', flags: [] }
    session.ended = { status: outcome }
    push(session, { kind: 'turn', turn: session.turns, status: outcome })
  }
  const begin = (session: FakeSession, input: string) => {
    session.inputs.push(input)
    session.turns += 1
    session.status = { kind: 'active', flags: [] }
    push(session, { kind: 'turn', turn: session.turns, status: 'running' })
    const scripted = options.reply?.(session.request, input)
    if (scripted) finish(session, scripted.outcome, scripted.text)
  }
  const refuse = (refusal: Refusal | undefined) => {
    if (refusal) throw rpcRefusal(refusal)
  }
  const sameStart = (a: StartRequest, b: StartRequest) =>
    JSON.stringify({ ...a, input: '' }) === JSON.stringify({ ...b, input: '' })
  const port: ManagedSessions = {
    async start(request) {
      calls.start++
      refuse(gate({ op: 'start', workspace: request.workspace, bundle: request.bundle }))
      const model = request.model
      if (model && !options.routes?.some((r) => r.route === model.route && r.model === model.model))
        refuse({ reason: 'MODEL_ROUTE_MISSING' })
      const existing = byStartKey.get(request.startKey)
      if (existing) {
        const session = get(existing)
        if (!sameStart(session.request, request)) refuse({ reason: 'START_KEY_REUSED' })
        if (session.archived) refuse({ reason: 'SESSION_ARCHIVED' })
        return { sessionId: existing, created: false }
      }
      const sessionId = `s${++made}`
      const session: FakeSession = {
        sessionId,
        request,
        status: { kind: 'notLoaded', flags: [] },
        archived: false,
        events: [],
        seq: 0,
        turns: 0,
        ended: null,
        result: null,
        keys: new Set(),
        usage: { inputTokens: null, outputTokens: null, cost: null },
        results: new Map(),
        inputs: [],
      }
      sessions.set(sessionId, session)
      byStartKey.set(request.startKey, sessionId)
      begin(session, request.input)
      return { sessionId, created: true }
    },
    async send(sessionId, { text, idempotencyKey }): Promise<SendResult> {
      calls.send++
      const session = get(sessionId)
      if (session.archived) return { state: 'notSubmitted', reason: 'archived' }
      if (session.keys.has(idempotencyKey)) return { state: 'notSubmitted', reason: 'duplicateKey' }
      if (session.status.kind === 'active') return { state: 'notSubmitted', reason: 'busy' }
      refuse(gate({ op: 'send', workspace: session.request.workspace, bundle: session.request.bundle }))
      session.keys.add(idempotencyKey)
      begin(session, text)
      return { state: 'started' }
    },
    async list() {
      return [...sessions.values()].map(({ sessionId, request, status, archived }) => ({
        sessionId,
        startKey: request.startKey,
        bundle: request.bundle,
        workspace: request.workspace,
        retention: request.retention,
        archived,
        status,
      }))
    },
    async events(sessionId, { afterSeq = 0 } = {}) {
      const session = get(sessionId)
      return {
        events: session.events.filter((e) => e.seq > afterSeq),
        lastSeq: Math.max(afterSeq, session.seq),
      }
    },
    async result(sessionId) {
      const session = get(sessionId)
      // As on the platform, reading an ended turn's result archives an ephemeral session.
      if (session.ended && session.request.retention === 'ephemeral') session.archived = true
      return { turn: session.ended, text: session.ended ? session.result : null }
    },
    async usage(sessionId) {
      return { ...get(sessionId).usage }
    },
    async toolResult(sessionId, callSeq) {
      const result = get(sessionId).results.get(callSeq)
      if (!result) throw rpcRefusal({ reason: 'INVALID_PARAMS' })
      return { ...result }
    },
    async interrupt(sessionId) {
      const session = get(sessionId)
      if (session.status.kind === 'active') finish(session, 'cancelled')
    },
    async archive(sessionId) {
      get(sessionId).archived = true
    },
  }
  return {
    port,
    sessions,
    calls,
    /** Refuses matching starts and sends the way the platform's gates do, until set back. */
    gate(next: Gate) {
      gate = next
    },
    set(sessionId: string, status: SessionStatus, result?: string) {
      const session = get(sessionId)
      session.status = status
      if (result !== undefined) session.result = result
    },
    /**
     * An approval is emitted only with the fields the platform reports: no verdict. As on the
     * platform, a pending approval flags the session as waiting and an answered one clears the flag.
     */
    emit(
      sessionId: string,
      event: {
        kind: 'approval'
        state: 'pending' | 'decided' | 'expired'
        category?: 'permission' | 'question'
        toolName?: string
      },
    ) {
      const { kind, state, category = 'permission', toolName } = event
      const session = get(sessionId)
      if (state === 'pending')
        session.status = {
          kind: 'active',
          flags: [category === 'question' ? 'waitingOnUserInput' : 'waitingOnApproval'],
        }
      if (state === 'decided') session.status = { kind: 'active', flags: [] }
      push(session, {
        kind,
        state,
        category,
        summary: '',
        ...(toolName ? { toolName } : {}),
      })
    },
    /**
     * How an approval ended, at its own seq after the approval event, as the platform reports it:
     * the waiting flag clears when someone decided. `approvalSeq` defaults to the latest approval.
     */
    outcome(
      sessionId: string,
      event: { outcome: 'allowed' | 'rejected' | 'expired'; via: 'person' | 'full-access' | 'automatic'; approvalSeq?: number },
    ) {
      const session = get(sessionId)
      const approvalSeq =
        event.approvalSeq ?? [...session.events].reverse().find((e) => e.kind === 'approval')?.seq ?? 0
      session.status = { kind: 'active', flags: [] }
      push(session, { kind: 'approvalOutcome', approvalSeq, outcome: event.outcome, via: event.via })
    },
    /**
     * A tool call is reported once, at its own seq, whatever state it is in; its result is read with
     * `toolResult` and is `pending` until `resolve` gives it. Returns the call's seq.
     */
    call(sessionId: string, name: string) {
      const session = get(sessionId)
      push(session, { kind: 'tool', name, status: 'awaiting_approval' })
      session.results.set(session.seq, { name, state: 'pending', isError: false, text: '', exitCode: null })
      return session.seq
    },
    resolve(sessionId: string, callSeq: number, text: string, isError = false) {
      const session = get(sessionId)
      const name = session.results.get(callSeq)?.name ?? 'unknown'
      session.results.set(callSeq, { name, state: 'done', isError, text, exitCode: null })
    },
    finish(sessionId: string, outcome: TurnEnd, text?: string) {
      finish(get(sessionId), outcome, text)
    },
    /** Usage in the engine's terms; the fake reports it in the platform's (input tokens, USD cost). */
    setUsage(sessionId: string, usage: { tokens: number | null; cost: number | null }) {
      get(sessionId).usage = {
        inputTokens: usage.tokens,
        outputTokens: usage.tokens === null ? null : 0,
        cost: usage.cost === null ? null : { amount: usage.cost, currency: 'USD' },
      }
    },
    /** Removes a session from list(), as if the platform lost it. */
    lose(sessionId: string) {
      const session = get(sessionId)
      sessions.delete(sessionId)
      byStartKey.delete(session.request.startKey)
    },
    byRole(role: 'judge' | 'worker') {
      return [...sessions.values()].filter((s) => s.request.bundle === ROLES[role].bundle)
    },
  }
}
