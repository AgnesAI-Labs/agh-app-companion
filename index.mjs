import { askOwnerTool } from './ask-owner.mjs'
import { channelGateway } from './channel-targets.mjs'
import { openChannel } from './channel.mjs'
import { buildDesk, deskServices, submitDesk } from './desk.mjs'
import { createEngine } from './engine.mjs'
import { LIMITS, withCaps } from './limits.mjs'
import { platformSessions, SessionRefusal } from './platform-sessions.mjs'
import { gitReadTool } from './git-read.mjs'
import { githubReadTool } from './github.mjs'
import { publishPlanTool, publishTool } from './publish.mjs'
import { DEFAULT_SETTINGS, missingSettings, parseSettings, SETTINGS_SCHEMA } from './settings.mjs'
import { openStore } from './store.mjs'

export const ENGINE_ID = 'companion'

/** @param {import('./tasks.mjs').Task} task */
const taskRepo = (task) => (typeof (/** @type {any} */ (task).repo) === 'string' ? /** @type {any} */ (task).repo : undefined)

/**
 * @typedef {{ kind: 'capability', missing: 'managedSessions', text: string }
 *   | { kind: 'settings', missing: string[], text: string }
 *   | { kind: 'model', roles: string[], text: string }
 *   | { kind: 'channel', text: string }
 *   | { kind: 'owner', recorded: import('./store.mjs').ChannelOwner, current: import('./store.mjs').ChannelOwner, text: string }
 *   | { kind: 'refusal', role: string, code: string, missing: string | null, workspace: string, taskIds: string[], at: string, text: string }
 *   | { kind: 'engine', text: string }} Problem
 * @typedef {{ running: boolean, problems: Problem[] }} ServiceStatus
 *   running = the engine loop is driving tasks; problems = what the owner must see when something is not working
 * @typedef {{
 *   resolveGateway?: (init: import('@agnes/extension-api').ProfileManagedInit) => import('./channel-contract.mjs').ChannelGateway | undefined,
 *   now?: () => string, limits?: import('./limits.mjs').Limits,
 *   prRepo?: (task: import('./tasks.mjs').Task) => string | undefined,
 * }} ServiceDeps
 *   prRepo = the repository a task's pull request must belong to for the desk to link it; the task's own
 *   `repo` field by default, which nothing writes yet, so no PR is a link today
 */

/**
 * The chat gateway port, from the platform's managed channel targets (`init.channels`, Extension API
 * 5.13). Absent on a host without them.
 * @param {import('@agnes/extension-api').ProfileManagedInit} init
 * @returns {import('./channel-contract.mjs').ChannelGateway | undefined}
 */
export function resolveChannelGateway(init) {
  return channelGateway(/** @type {any} */ (init).channels)
}

/** Engine without a channel: outbox rows stay pending until one exists. */
const NO_CHANNEL = Object.freeze({
  deliver: async () => {
    throw new Error('no chat channel')
  },
})

/**
 * Starts the task engine resource. Settings that break the rules, or a store this build cannot
 * read, stop it before ready; the Host then shows only that start failed, not why. Anything else
 * that keeps the engine from working (a missing platform capability, unfinished settings, no
 * channel, a store bound to another owner) still becomes ready and is reported by `status()`.
 * @param {import('@agnes/extension-api').ProfileManagedInit} init
 * @param {ServiceDeps} [deps]
 */
export async function startEngine(
  init,
  { resolveGateway = resolveChannelGateway, now, limits: baseLimits = LIMITS, prRepo = taskRepo } = {},
) {
  // Registered first: once the Host has called start it counts the resource as live, and a start that
  // throws before a shutdown handler exists is reported as an unconfirmed shutdown that no retry clears.
  /** @type {Promise<void> | null} */
  let inflight = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let stopped = false
  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
  init.signal.addEventListener('abort', stop, { once: true })

  init.onShutdown(async () => {
    stop()
    init.signal.removeEventListener('abort', stop)
    const pending = inflight
    if (!pending) return { state: 'settled' }
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve(false), baseLimits.shutdownSettleMs)
      }),
    ])
    clearTimeout(deadline)
    return { state: settled ? 'settled' : 'unknown' }
  })

  const store = openStore(init.store)
  const parsed = parseSettings(/** @type {never} */ (init.config))
  if (!parsed.ok) throw new Error(`companion settings are invalid: ${parsed.errors.join('; ')}`)
  const settings = parsed.value
  const limits = withCaps(baseLimits, settings)

  /** @type {Problem[]} */
  const blockers = []
  /** @type {unknown} the last pass's failure, null after a pass that worked */
  let engineError = null
  /** @type {ReturnType<typeof createEngine> | null} */
  let engine = null
  /** @type {import('./channel.mjs').ChatChannel | null} */
  let channel = null

  const sessions = platformSessions(/** @type {any} */ (init).sessions)
  if (!sessions)
    blockers.push({
      kind: 'capability',
      missing: 'managedSessions',
      text: 'this host does not provide plugin-managed sessions (init.sessions); the companion cannot open judge or worker sessions',
    })
  const missing = missingSettings(settings)
  if (missing.length)
    blockers.push({ kind: 'settings', missing, text: `settings to fill in: ${missing.join(', ')}` })
  const routed = /** @type {const} */ (['judge', 'worker']).filter((role) => settings.models[role].route)
  if (routed.length)
    blockers.push({
      kind: 'model',
      roles: [...routed],
      text: `a model route is set for ${routed.join(', ')}, but the platform needs a route and a model name and the settings hold only the route; clear it to use the deployment default`,
    })

  /** @type {string | null} why no channel is open: no platform support, not paired, or the pairing cannot serve */
  let channelProblem = null
  /** @type {Problem | null} the store belongs to another owner than the current pairing */
  let ownerProblem = null
  const gateway = resolveGateway(init)
  if (!gateway)
    channelProblem =
      'the platform does not provide channel targets (init.channels); the companion runs without a chat channel'
  /** The engine reads the channel through this on every delivery, so one opened later is used at once. */
  const channelPort = Object.freeze({
    deliver: (/** @type {any} */ message) => (channel ?? NO_CHANNEL).deliver(message),
    replyBudget: async () => channel ? channel.replyBudget() : limits.answerMaxChars,
    prepareReply: async (/** @type {string} */ text) => channel?.prepareReply(text),
    watchSession: async (/** @type {string} */ sessionId) => { await channel?.watchSession(sessionId) },
    refresh: async () => { await openIfNone(); await channel?.refresh() },
  })

  /** Opens the channel on the current pairing if none is open; at most one open at a time. */
  let opening = Promise.resolve()
  const openIfNone = () => {
    opening = opening.then(async () => {
      if (!gateway || channel || stopped) return
      const opened = await openChannel({ gateway, store, receive: (signal) => /** @type {any} */ (engine).receive(signal) })
      if (!opened.ok) {
        channelProblem = opened.status
        return
      }
      const recorded = store.channelOwner()
      const current = opened.channel.owner
      if (recorded && (recorded.instanceId !== current.instanceId || recorded.userId !== current.userId)) {
        channelProblem = null
        ownerProblem = {
          kind: 'owner',
          recorded,
          current,
          text: `this store was used with owner ${recorded.userId} on channel instance ${recorded.instanceId}, but the channel now serves ${current.userId} on ${current.instanceId}. Nothing was delivered or deleted. Pair the recorded owner again, or clear the companion's store to start over for the new owner.`,
        }
        return
      }
      if (!recorded) store.recordChannelOwner(current)
      ownerProblem = null
      channelProblem = null
      channel = opened.channel
    })
    return opening.catch(() => {})
  }
  if (!blockers.length) {
    await openIfNone()
    // A store of another owner stops the engine at start, as before; a pairing that changes later only
    // reports the problem.
    if (ownerProblem) blockers.push(ownerProblem)
  }

  if (!blockers.length && sessions)
    engine = createEngine({
      store,
      sessions,
      channel: channelPort,
      settings,
      limits,
      ...(now ? { now } : {}),
    })

  /** @param {() => Promise<void>} work */
  const run = async (work) => {
    inflight = work().then(
      () => {
        engineError = null
      },
      (error) => {
        engineError = error
      },
    )
    await inflight
    inflight = null
  }
  const loop = async () => {
    timer = null
    if (stopped || !engine) return
    const current = engine
    await run(() => current.tick())
    if (!stopped) timer = setTimeout(loop, limits.tickIntervalMs)
  }
  /** @returns {ServiceStatus} */
  const status = () => {
    /** @type {Problem[]} */
    const problems = [...blockers]
    if (ownerProblem && !blockers.includes(ownerProblem)) problems.push(ownerProblem)
    const channelNow = channelProblem ?? channel?.status() ?? null
    if (channelNow) problems.push({ kind: 'channel', text: channelNow })
    if (engine) {
      const last = store
        .scan('refusal/')
        .map((row) => row.value)
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]
      if (last)
        problems.push({
          kind: 'refusal',
          role: last.role,
          code: last.code,
          missing: last.missing,
          workspace: last.workspace,
          taskIds: last.taskIds,
          at: last.at,
          text: last.text,
        })
    }
    // A port the declaration does not grant refuses every call; that is the capability missing.
    if (engineError instanceof SessionRefusal && engineError.code === 'CAPABILITY_DENIED')
      problems.push({
        kind: 'capability',
        missing: 'managedSessions',
        text: 'the platform refuses every managed-session call: the sessions declaration is not granted; trust and enable the companion again',
      })
    else if (engineError)
      problems.push({
        kind: 'engine',
        text: engineError instanceof Error ? engineError.message : String(engineError),
      })
    return { running: engine !== null && !stopped, problems }
  }

  /** @returns {Promise<import('./desk.mjs').PairingView>} */
  const pairingView = async () => {
    if (!gateway) return { state: 'unsupported' }
    try {
      const pairing = await gateway.pairing()
      return pairing ? { state: 'paired', provider: pairing.provider, label: pairing.label, running: pairing.running } : { state: 'unpaired' }
    } catch {
      return { state: 'unknown' }
    }
  }
  /** @param {unknown} raw */
  const receive = async (raw) => {
    if (!channel && !stopped) await openIfNone()
    if (!channel || !engine || stopped)
      return { kind: 'dropped', reason: status().problems[0]?.text ?? 'the companion is stopped' }
    return channel.receive(raw)
  }
  if (gateway) {
    // The platform retries a handler that throws, so a handler that returns means the event is settled (A1).
    gateway.onEvent(async (event) => {
      await receive(event)
    })
    gateway.onPairingChange(() => {
      void openIfNone().then(() => channel?.refresh())
    })
  }

  init.ready()
  if (engine) {
    const started = engine
    // Session facts first, so tasks whose sessions changed while the service was down are current.
    void run(() => started.reconcile()).then(loop)
  }

  const clock = now ?? (() => new Date().toISOString())
  return Object.freeze({
    store,
    settings,
    status,
    /**
     * The task desk's read (desk.mjs): the engine's tasks, cards, usage and problems in one answer.
     * @param {{ taskId?: string }} [input]
     */
    desk: async (input) => {
      await channel?.refresh()
      return buildDesk(
        {
          engine: stopped ? null : engine,
          store,
          limits,
          now: clock,
          status: status(),
          sessions,
          prRepo,
          workspaces: settings.workspaces.map((w) => w.shortName),
          pairing: await pairingView(),
        },
        input,
      )
    },
    /**
     * The owner's input from the task desk, as an inbox signal with source `desk`. It enters the
     * engine's own `receive`, not the channel's: the desk works with no chat channel.
     * @param {Record<string, unknown>} input @param {string} operationId
     */
    submit: (input, operationId) => submitDesk({ engine: stopped ? null : engine, store, now: clock }, input, operationId),
    /**
     * One channel event, as the platform hands it over (A13). With no open channel it first tries to
     * open one, since the pairing and its first message may arrive in either order; without a
     * running engine and channel the event is dropped with the reason.
     * @param {unknown} raw
     */
    receive,
    /**
     * ask_owner's write: the question of the running task that owns this worker session.
     * @param {string} sessionKey @param {{ text: string, options: string[] }} question
     */
    askOwner: (sessionKey, question) => (engine && !stopped ? engine.askOwner(sessionKey, question) : { ok: false }),
    /** Ends the service's pairing from the task desk; the platform needs no approval to revoke. */
    async unpair() {
      const pairing = await gateway?.pairing()
      if (!pairing) return { ok: true, result: 'not-paired' }
      await gateway?.unpair(pairing.id)
      await channel?.refresh()
      return { ok: true, result: 'unpaired' }
    },
  })
}

export const main = {
  inject: ['services', 'profileRuntime', 'tools'],
  /** @param {Pick<import('@agnes/extension-api').PluginContextFacets, 'services' | 'profileRuntime' | 'tools'>} ctx */
  apply(ctx) {
    const handle = ctx.profileRuntime.register({
      id: ENGINE_ID,
      configSchema: SETTINGS_SCHEMA,
      defaultConfig: DEFAULT_SETTINGS,
      start: startEngine,
    })
    for (const service of deskServices(() => handle.get())) ctx.services.register(service)
    ctx.tools.register(askOwnerTool(() => handle.get()))
    ctx.tools.register(publishPlanTool())
    ctx.tools.register(publishTool())
    ctx.tools.register(githubReadTool())
    ctx.tools.register(gitReadTool())
  },
}
