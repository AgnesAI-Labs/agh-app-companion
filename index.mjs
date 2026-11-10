import { openChannel } from './channel.mjs'
import { createEngine } from './engine.mjs'
import { LIMITS } from './limits.mjs'
import { platformSessions, SessionRefusal } from './platform-sessions.mjs'
import { publishPlanTool, publishTool } from './publish.mjs'
import { DEFAULT_SETTINGS, missingSettings, parseSettings, SETTINGS_SCHEMA } from './settings.mjs'
import { openStore } from './store.mjs'

export const ENGINE_ID = 'companion'

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
 * }} ServiceDeps
 */

/**
 * The chat gateway port. The gateway is another plugin that is not on the platform yet, and
 * channel-contract.mjs assumes no lookup call for it (A13), so nothing resolves today.
 * @returns {import('./channel-contract.mjs').ChannelGateway | undefined}
 */
export function resolveChannelGateway() {
  return undefined
}

/** Engine without a channel: outbox rows stay pending until one exists. */
const NO_CHANNEL = Object.freeze({
  deliver: async () => {
    throw new Error('no chat channel')
  },
})

/**
 * Starts the task engine resource. Settings that break the rules, or a store this build cannot
 * read, stop it before ready. Anything else that keeps the engine from working (a missing platform
 * capability, unfinished settings, no channel, a store bound to another owner) still becomes ready
 * and is reported by `status()`.
 * @param {import('@agnes/extension-api').ProfileManagedInit} init
 * @param {ServiceDeps} [deps]
 */
export async function startEngine(
  init,
  { resolveGateway = resolveChannelGateway, now, limits = LIMITS } = {},
) {
  const store = openStore(init.store)
  const parsed = parseSettings(/** @type {never} */ (init.config))
  if (!parsed.ok) throw new Error(`companion settings are invalid: ${parsed.errors.join('; ')}`)
  const settings = parsed.value

  /** @type {Problem[]} */
  const blockers = []
  /** @type {unknown} the last pass's failure, null after a pass that worked */
  let engineError = null
  /** @type {Promise<void> | null} */
  let inflight = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let stopped = false
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

  let channelProblem = null
  if (!blockers.length) {
    const gateway = resolveGateway(init)
    if (!gateway)
      channelProblem =
        'the chat channel gateway is not available on this platform; the companion runs without a channel'
    else {
      const opened = await openChannel({
        settings,
        gateway,
        store,
        receive: (signal) => /** @type {any} */ (engine).receive(signal),
      })
      if (!opened.ok) channelProblem = opened.status
      else {
        const recorded = store.channelOwner()
        const current = opened.channel.owner
        if (recorded && (recorded.instanceId !== current.instanceId || recorded.userId !== current.userId))
          blockers.push({
            kind: 'owner',
            recorded,
            current,
            text: `this store was used with owner ${recorded.userId} on channel instance ${recorded.instanceId}, but the channel now serves ${current.userId} on ${current.instanceId}. Nothing was delivered or deleted. Bind the recorded owner again, or clear the companion's store to start over for the new owner.`,
          })
        else {
          if (!recorded) store.recordChannelOwner(current)
          channel = opened.channel
        }
      }
    }
  }

  if (!blockers.length && sessions)
    engine = createEngine({
      store,
      sessions,
      channel: channel ?? NO_CHANNEL,
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
        deadline = setTimeout(() => resolve(false), limits.shutdownSettleMs)
      }),
    ])
    clearTimeout(deadline)
    return { state: settled ? 'settled' : 'unknown' }
  })

  /** @returns {ServiceStatus} */
  const status = () => {
    /** @type {Problem[]} */
    const problems = [...blockers]
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

  init.ready()
  if (engine) {
    const started = engine
    // Session facts first, so tasks whose sessions changed while the service was down are current.
    void run(() => started.reconcile()).then(loop)
  }

  return Object.freeze({
    store,
    settings,
    status,
    /**
     * The gateway's entry for one channel event (A13). Without a running engine and channel the
     * event is dropped with the reason, so the gateway does not redeliver it forever.
     * @param {unknown} raw
     */
    async receive(raw) {
      if (!channel || !engine || stopped)
        return { kind: 'dropped', reason: status().problems[0]?.text ?? 'the companion is stopped' }
      return channel.receive(raw)
    },
  })
}

export const main = {
  inject: ['services', 'profileRuntime', 'tools'],
  /** @param {Pick<import('@agnes/extension-api').PluginContextFacets, 'services' | 'profileRuntime' | 'tools'>} ctx */
  apply(ctx) {
    ctx.profileRuntime.register({
      id: ENGINE_ID,
      configSchema: SETTINGS_SCHEMA,
      defaultConfig: DEFAULT_SETTINGS,
      start: startEngine,
    })
    ctx.tools.register(publishPlanTool())
    ctx.tools.register(publishTool())
  },
}
