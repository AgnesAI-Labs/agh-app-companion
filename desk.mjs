import { SLOT_STATES } from './machine.mjs'
import { isPullOf } from './publish.mjs'
import { allTasks, isAsking } from './tasks.mjs'

/**
 * The task desk's two profile services (plan item A5): `companion.desk`, one read for the whole
 * page, and `companion.submit`, the owner's inputs. Both run in the process that holds the engine
 * and reach it through the managed resource's handle; neither writes a task. A submit becomes an
 * inbox signal with source `desk`, so it takes the route a chat message takes (engine.mjs).
 *
 * @typedef {import('./tasks.mjs').Task} Task
 * @typedef {{ kind: string, flags: string[] }} SessionView
 * @typedef {{ tokens: number | null, cost: number | null }} UsageView  null = the platform did not report it
 * @typedef {{
 *   id: string, title: string, workspace: string, state: string, reason: string | null,
 *   sessionId: string | null, session: SessionView | null, sessionState: 'none' | 'ok' | 'missing' | 'unreadable',
 *   wait: 'approval' | 'question' | 'unreadable' | null,
 *   usage: UsageView, budgetBase: UsageView, refusals: number, generation: number, resumed: number,
 *   createdAt: string, updatedAt: string, endedAt: string | null,
 *   prUrl: string | null, prLink: string | null,
 *   queue: { holder: string | null, position: number } | null,
 * }} TaskView
 *   prLink is prUrl only when it is a pull request page of the task's repository; the page links nothing else
 * @typedef {{
 *   key: string, kind: 'ask' | 'handback', text: string, detail: string | null, original: string | null,
 *   options: { taskId: string, title: string }[], allowNew: boolean, at: string, sentAt: string | null,
 * }} CardView
 * @typedef {{ key: string, text: string, at: string, state: 'judging' | string, taskIds: string[], replies: { text: string, at: string, sent: boolean }[] }} DeskMessage
 * @typedef {{
 *   engine: ReturnType<typeof import('./engine.mjs').createEngine> | null,
 *   store: import('./store.mjs').Store, limits: import('./limits.mjs').Limits, now: () => string,
 *   status: import('./index.mjs').ServiceStatus,
 *   sessions: import('./sessions.mjs').ManagedSessions | null,
 *   prRepo: (task: Task) => string | undefined,
 *   workspaces: readonly string[],  the short names the owner can name, for the composer's chips
 *   pairing: PairingView,
 * }} DeskDeps
 */

/**
 * @typedef {{ state: 'paired', provider: string, label: string, running: boolean }
 *   | { state: 'unpaired' } | { state: 'unsupported' } | { state: 'unknown' }} PairingView
 *   what the platform says about the service's chat pairing; unsupported = a host without channel targets
 */

export const DESK_SOURCE = 'desk'
/** The source the host stamps on calls from the local Web (daemon-rpc profile-services.ts). */
export const LOCAL_WEB_SOURCE = 'client-web'
const NEAR_CAP = 0.8
const GROUP_MAX = 100
const TEXT_MAX = 4000
const NOTE_MAX = 500
const EVENTS_MAX = 60
const MESSAGES_MAX = 8
const REBOUND = /was rebound to another owner/
/** v1b states: no code creates a proposal and nothing expires one, so the desk shows neither. */
const HIDDEN = new Set(['proposed', 'expired'])

const clip = (value, max) => {
  const text = typeof value === 'string' ? value : ''
  return [...text].length > max ? `${[...text].slice(0, max).join('')}…` : text
}

/** The desk's input contracts, the single source for the registered services and the package declaration. */
export const DESK_CAPABILITIES = Object.freeze({
  query: {
    name: 'companion.desk',
    scope: 'profile',
    kind: 'query',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1, maxLength: 64 } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    timeoutMs: 30000,
    maxResultBytes: 1048576,
  },
  submit: {
    name: 'companion.submit',
    scope: 'profile',
    kind: 'effect',
    inputSchema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { enum: ['message', 'choice', 'button'] },
        text: { type: 'string', minLength: 1, maxLength: TEXT_MAX },
        replyTo: { type: 'string', minLength: 1, maxLength: 64 },
        card: { type: 'string', minLength: 1, maxLength: 200 },
        pick: { type: 'string', minLength: 1, maxLength: 64 },
        action: { enum: ['continue', 'stop'] },
        taskId: { type: 'string', minLength: 1, maxLength: 64 },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    timeoutMs: 30000,
    maxResultBytes: 65536,
    // Everything the owner can do here, the owner can also type into the chat: the effect only
    // writes the companion's own inbox, and outward actions keep their own native approval.
    effectPolicy: {
      isDestructive: false,
      isOpenWorld: false,
      replay: 'idempotent',
      requiresApproval: 'never',
      approvalScopes: [],
    },
  },
  unpair: {
    name: 'companion.unpair',
    scope: 'profile',
    kind: 'effect',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
    timeoutMs: 30000,
    maxResultBytes: 65536,
    // Unpairing only takes the companion's own access to the chat away; pairing again needs a new
    // code from the AGH channel page, so no approval is asked.
    effectPolicy: {
      isDestructive: true,
      isOpenWorld: false,
      replay: 'idempotent',
      requiresApproval: 'never',
      approvalScopes: [],
    },
  },
})

/**
 * The desk acts only for the owner on the local Web. The host already refuses an agent actor and
 * hands every other local credential the one machine-owner identity; the source tells the local Web
 * from a Node client holding a granted credential.
 * @param {Partial<import('@agnes/extension-api').ServiceContext> | undefined} ctx
 */
export function assertLocalOwner(ctx) {
  if (ctx?.source !== LOCAL_WEB_SOURCE || ctx.actor?.role !== 'owner' || ctx.scope?.kind !== 'profile')
    throw new Error('the task desk answers only the owner on the local Web')
}

/**
 * @param {() => Promise<{ desk(input: unknown): Promise<unknown>, submit(input: unknown, operationId: string): unknown, unpair(): Promise<unknown> }>} resource
 *   the managed resource's handle.get
 * @returns {import('@agnes/extension-api').ServiceDef[]}
 */
export function deskServices(resource) {
  return /** @type {any} */ ([
    {
      ...DESK_CAPABILITIES.query,
      async handler(input, ctx) {
        assertLocalOwner(ctx)
        let started
        try {
          started = await resource()
        } catch (error) {
          return unavailable(error)
        }
        return started.desk(input)
      },
    },
    {
      ...DESK_CAPABILITIES.submit,
      async handler(input, ctx) {
        assertLocalOwner(ctx)
        const operationId = ctx.admission?.operationId
        if (typeof operationId !== 'string' || !operationId) throw new Error('companion.submit needs the host operation id')
        let started
        try {
          started = await resource()
        } catch (error) {
          return refused('not-running', `伴侣服务没有运行：${clip(error instanceof Error ? error.message : String(error), 200)}`)
        }
        return started.submit(input, operationId)
      },
    },
    {
      ...DESK_CAPABILITIES.unpair,
      async handler(_input, ctx) {
        assertLocalOwner(ctx)
        let started
        try {
          started = await resource()
        } catch (error) {
          return refused('not-running', `伴侣服务没有运行：${clip(error instanceof Error ? error.message : String(error), 200)}`)
        }
        return started.unpair()
      },
    },
  ])
}

/** What the page shows when the managed resource is not ready: one status, no tasks. @param {unknown} error */
function unavailable(error) {
  return {
    ...EMPTY,
    problems: [{ kind: 'engine', text: clip(error instanceof Error ? error.message : String(error), NOTE_MAX), unavailable: true }],
  }
}

const EMPTY = Object.freeze({
  running: false,
  canSubmit: false,
  submitBlock: 'not-running',
  problems: [],
  workspaces: [],
  tasks: { needsYou: [], running: [], queued: [], paused: [], recent: [], older: [], olderTotal: 0, unknown: [] },
  cards: [],
  messages: [],
  judge: { backoff: null, waiting: 0 },
  usage: { today: null, caps: { dailyCost: null, taskCost: null, taskTokens: null, maxHops: null }, near: NEAR_CAP, top: [] },
  store: { ratio: 0, warn: false, full: false },
  sessionsReadable: false,
  pairing: { state: 'unsupported' },
})

/**
 * Everything the page shows, in one read of the store and one session list. Task text, worker
 * replies and card text are untrusted; the page renders them as text only.
 * @param {DeskDeps} deps
 * @param {{ taskId?: string }} [input] a task id adds that task's detail
 */
export async function buildDesk(deps, input = {}) {
  const { engine, store, limits } = deps
  const at = deps.now()
  const problems = deps.status.problems.map((p) => ({ ...p, text: clip(p.text, NOTE_MAX) }))
  if (!engine) return { ...EMPTY, at, running: deps.status.running, problems, pairing: deps.pairing }
  const tx = { store, at, limits, workspaces: [] }

  /** @type {Map<string, import('./sessions.mjs').SessionRow>} */
  let rows = new Map()
  let sessionsReadable = true
  try {
    rows = new Map((await /** @type {any} */ (deps.sessions).list()).map((row) => [row.sessionId, row]))
  } catch {
    sessionsReadable = false
  }

  const tasks = allTasks(tx).filter((t) => !HIDDEN.has(t.state))
  const holders = new Map()
  for (const t of tasks) if (SLOT_STATES.includes(t.state) && !holders.has(t.workspace)) holders.set(t.workspace, t.id)
  const queueOrder = (a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : 1)
  const waiting = new Map()
  for (const t of tasks.filter((x) => x.state === 'queued').sort(queueOrder)) {
    const line = waiting.get(t.workspace) ?? []
    line.push(t.id)
    waiting.set(t.workspace, line)
  }
  const view = (t) => taskView(t, rows, sessionsReadable, holders, waiting, deps.prRepo)
  const newest = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1)
  const ofState = (state) => tasks.filter((t) => t.state === state).sort(newest)
  const now = Date.parse(at)
  const endedAt = (t) => Date.parse(t.endedAt ?? t.updatedAt)
  const recent = tasks.filter((t) => (t.state === 'done' || t.state === 'failed') && now - endedAt(t) <= limits.snapshotEndedMs).sort((a, b) => (endedAt(a) < endedAt(b) ? 1 : -1))
  const older = tasks.filter((t) => t.state === 'abandoned' || ((t.state === 'done' || t.state === 'failed') && now - endedAt(t) > limits.snapshotEndedMs)).sort((a, b) => (endedAt(a) < endedAt(b) ? 1 : -1))
  const workspaces = [...new Set(tasks.map((t) => t.workspace))]
  const queued = workspaces
    .filter((ws) => waiting.has(ws))
    .sort()
    .map((workspace) => ({ workspace, tasks: (waiting.get(workspace) ?? []).slice(0, GROUP_MAX).map((id) => view(/** @type {Task} */ (store.getTask(id)))) }))

  const known = new Set(['queued', 'running', 'waiting', 'paused', 'done', 'failed', 'abandoned'])
  const usageDay = store.get(`usage/${at.slice(0, 10)}`)
  const ratio = store.usage().ratio
  const unfinished = tasks.filter((t) => ['queued', 'running', 'waiting', 'paused'].includes(t.state))
  const reason = submitBlock(deps.status, ratio, limits)
  const result = {
    at,
    running: deps.status.running,
    canSubmit: reason === null,
    submitBlock: reason,
    problems,
    workspaces: deps.workspaces.slice(0, 32),
    tasks: {
      needsYou: ofState('waiting').slice(0, GROUP_MAX).map(view),
      running: ofState('running').slice(0, GROUP_MAX).map(view),
      queued,
      paused: ofState('paused').slice(0, GROUP_MAX).map(view),
      recent: recent.slice(0, GROUP_MAX).map(view),
      older: older.slice(0, GROUP_MAX).map(view),
      olderTotal: older.length,
      // A state this build does not know shows as "state unknown" with a link to its session.
      unknown: tasks.filter((t) => !known.has(t.state)).slice(0, GROUP_MAX).map(view),
    },
    cards: cardViews(store, GROUP_MAX),
    messages: messageViews(store, at, limits),
    judge: judgeView(store),
    usage: {
      today: usageDay ? { date: at.slice(0, 10), basis: 'UTC', tokens: usageDay.tokens, cost: usageDay.cost, unknown: Boolean(usageDay.unknown) } : null,
      caps: { dailyCost: limits.dailyCost, taskCost: limits.taskCost, taskTokens: limits.taskTokens, maxHops: limits.maxHops },
      near: NEAR_CAP,
      top: unfinished
        .slice()
        .sort((a, b) => (b.usage.cost ?? -1) - (a.usage.cost ?? -1))
        .slice(0, 3)
        .map((t) => ({ id: t.id, tokens: t.usage.tokens, cost: t.usage.cost })),
    },
    store: { ratio, warn: ratio >= limits.storeWarnRatio, full: ratio >= limits.storeRefuseRatio },
    sessionsReadable,
    pairing: deps.pairing,
  }
  if (typeof input.taskId === 'string') {
    const task = store.getTask(input.taskId)
    if (task && !HIDDEN.has(task.state)) return { ...result, detail: detailView(store, /** @type {Task} */ (task), view) }
  }
  return result
}

/**
 * Why the composer is off, or null. A missing chat channel is not a reason: replies wait in the
 * outbox. A rebound channel is: nothing may reach anyone until the service restarts.
 * @param {import('./index.mjs').ServiceStatus} status @param {number} ratio @param {import('./limits.mjs').Limits} limits
 */
function submitBlock(status, ratio, limits) {
  if (!status.running) return 'not-running'
  if (status.problems.some((p) => p.kind === 'channel' && REBOUND.test(p.text))) return 'rebound'
  if (ratio >= limits.storeRefuseRatio) return 'store-full'
  return null
}

/**
 * @param {Task} t @param {Map<string, import('./sessions.mjs').SessionRow>} rows @param {boolean} readable
 * @param {Map<string, string>} holders @param {Map<string, string[]>} waiting @param {(task: Task) => string | undefined} prRepo
 * @returns {TaskView}
 */
function taskView(t, rows, readable, holders, waiting, prRepo) {
  const row = t.sessionId ? rows.get(t.sessionId) : undefined
  const live = row && !row.archived ? row : undefined
  const session = live ? { kind: live.status.kind, flags: [...live.status.flags] } : null
  const sessionState = !t.sessionId ? 'none' : !readable ? 'unreadable' : live ? 'ok' : 'missing'
  const flags = session?.flags ?? []
  const wait = t.state !== 'waiting' ? null : isAsking(t) ? 'question' : flags.includes('waitingOnApproval') ? 'approval' : flags.includes('waitingOnUserInput') ? 'question' : 'unreadable'
  const repo = t.prUrl ? prRepo(t) : undefined
  const line = waiting.get(t.workspace) ?? []
  const place = t.state === 'queued' ? line.indexOf(t.id) : -1
  return {
    id: t.id, title: t.title, workspace: t.workspace, state: t.state, reason: t.reason,
    sessionId: t.sessionId, session, sessionState, wait,
    usage: { tokens: t.usage.tokens, cost: t.usage.cost },
    budgetBase: { tokens: t.budgetBase.tokens, cost: t.budgetBase.cost },
    refusals: t.refusals, generation: t.generation, resumed: t.resumed,
    createdAt: t.createdAt, updatedAt: t.updatedAt, endedAt: t.endedAt,
    prUrl: t.prUrl,
    prLink: t.prUrl && repo && isPullOf(t.prUrl, repo) ? t.prUrl : null,
    queue: t.state === 'queued' ? { holder: holders.get(t.workspace) ?? null, position: place + 1 } : null,
  }
}

/** Choice cards nobody has answered: not chosen, and no answer waiting in the inbox. @param {import('./store.mjs').Store} store @param {number} max @returns {CardView[]} */
function cardViews(store, max) {
  const answering = new Set(
    store.scan('inbox/').map((r) => r.value).filter((e) => e.disposition === null && e.signal.kind === 'choice').map((e) => e.signal.card),
  )
  return store
    .scan('outbox/')
    .map((r) => r.value)
    .filter((m) => m.card && !m.chosen && !answering.has(m.deliveryKey))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, max)
    .map((m) => {
      const original = m.about ? store.get(m.about) : undefined
      return {
        key: m.deliveryKey,
        kind: /:[12]$/.test(m.deliveryKey) ? 'handback' : 'ask',
        text: clip(m.text, 300),
        detail: m.detail ? clip(m.detail, 300) : null,
        original: original?.signal?.text ? clip(original.signal.text, 300) : null,
        options: m.card.options.slice(0, 8).map((o) => ({ taskId: o.taskId, title: clip(o.title, 120) })),
        allowNew: Boolean(m.card.allowNew),
        at: m.at,
        sentAt: m.sentAt,
      }
    })
}

/** The owner's recent desk messages with the companion's replies to them. @param {import('./store.mjs').Store} store @param {string} at @param {import('./limits.mjs').Limits} limits @returns {DeskMessage[]} */
function messageViews(store, at, limits) {
  const since = Date.parse(at) - limits.recentWindowMs
  const replies = new Map()
  for (const { value: m } of store.scan('outbox/'))
    if (m.about) replies.set(m.about, [...(replies.get(m.about) ?? []), { text: clip(m.text, 300), at: m.at, sent: m.sentAt !== null }])
  return store
    .scan('inbox/')
    .map((r) => r.value)
    .filter((e) => e.signal.source === DESK_SOURCE && e.signal.kind === 'message' && Date.parse(e.signal.at) >= since)
    .sort((a, b) => (a.signal.at < b.signal.at ? 1 : a.signal.at > b.signal.at ? -1 : 0))
    .slice(0, MESSAGES_MAX)
    .map((e) => ({
      key: e.key,
      text: clip(e.signal.text, 300),
      at: e.signal.at,
      state: e.disposition ? e.disposition.kind : 'judging',
      taskIds: e.disposition?.taskIds ?? [],
      replies: (replies.get(e.key) ?? []).sort((a, b) => (a.at < b.at ? -1 : 1)),
    }))
}

/** @param {import('./store.mjs').Store} store */
function judgeView(store) {
  const backoff = store.get('judge/backoff')
  return {
    backoff: backoff ? { failures: backoff.failures, until: backoff.until } : null,
    waiting: store.scan('inbox/').filter((r) => r.value.disposition === null).length,
  }
}

/** @param {import('./store.mjs').Store} store @param {Task} task @param {(t: Task) => TaskView} view */
function detailView(store, task, view) {
  const events = store.readEvents(task.id)
  const finished = events.findLast((e) => e.kind === 'state' && e.data?.event === 'sessionCompleted')
  return {
    ...view(task),
    brief: clip(task.brief, TEXT_MAX),
    briefHash: task.briefHash,
    note: typeof finished?.data?.note === 'string' && finished.data.note ? clip(finished.data.note, NOTE_MAX) : null,
    compacted: task.compacted,
    events: events.slice(-EVENTS_MAX).map((e) => ({
      at: e.at,
      kind: e.kind,
      event: e.data?.event ?? null,
      from: e.data?.from ?? null,
      to: e.data?.to ?? null,
      reason: e.data?.reason ?? null,
      by: e.data?.by ?? null,
      unquoted: e.data?.unquoted === true,
      note: typeof e.data?.note === 'string' ? clip(e.data.note, NOTE_MAX) : null,
    })),
  }
}

/** @param {string} code @param {string} text */
const refused = (code, text) => ({ ok: false, code, text })

/**
 * The owner's input as an inbox signal. Source, event id, origin and time are the server's: the
 * input names only what the owner did. A repeated operation id is answered before anything else is
 * checked, so a retry after a lost receipt says the same thing as the first call.
 * @param {Pick<DeskDeps, 'engine' | 'store' | 'now'>} deps
 * @param {Record<string, unknown>} input @param {string} operationId
 */
export function submitDesk({ engine, store, now }, input, operationId) {
  if (!engine) return refused('not-running', '伴侣服务没有运行，这条没有发出。')
  if (store.get(`inbox/${DESK_SOURCE}:${operationId}`)) return { ok: true, result: 'duplicate' }
  const text = (v, max = TEXT_MAX) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
  /** @type {Record<string, unknown>} */
  let fields
  switch (input.kind) {
    case 'message': {
      if (!text(input.text)) return refused('invalid', '消息不能为空。')
      if (input.replyTo !== undefined && !(text(input.replyTo, 64) && store.getTask(/** @type {string} */ (input.replyTo))))
        return refused('unknown-task', '这个任务已经不存在。')
      fields = { kind: 'message', text: input.text, ...(input.replyTo ? { replyTo: input.replyTo } : {}) }
      break
    }
    case 'button': {
      if (input.action !== 'continue' && input.action !== 'stop') return refused('invalid', '不支持这个操作。')
      if (!text(input.taskId, 64) || !store.getTask(/** @type {string} */ (input.taskId))) return refused('unknown-task', '这个任务已经不存在。')
      fields = { kind: 'button', action: input.action, taskId: input.taskId }
      break
    }
    case 'choice': {
      if (!text(input.card, 200) || !text(input.pick, 64)) return refused('invalid', '选择不完整。')
      const row = store.get(`outbox/${input.card}`)
      if (!row?.card) return refused('unknown-card', '这张卡片已经不在了。')
      const answered =
        row.chosen ||
        store.scan('inbox/').some((r) => r.value.disposition === null && r.value.signal.kind === 'choice' && r.value.signal.card === input.card)
      if (answered) return refused('card-answered', '这张卡片已经有人选过了。')
      if (input.pick !== 'new' && !row.card.options.some((o) => o.taskId === input.pick)) return refused('invalid', '这个选项不在卡片上。')
      fields = { kind: 'choice', card: input.card, pick: input.pick }
      break
    }
    default:
      return refused('invalid', '不支持这种输入。')
  }
  const received = engine.receive({ source: DESK_SOURCE, eventId: operationId, at: now(), origin: 'owner', ...fields })
  if (received.kind === 'accepted' || received.kind === 'duplicate') return { ok: true, result: received.kind }
  return refused('invalid', clip(received.kind === 'invalid' ? received.error : 'refused', 200))
}
