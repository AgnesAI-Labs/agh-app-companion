import { isPairing, REFUSAL_CODES } from './channel-contract.mjs'

/**
 * The one place `init.channels` (the platform's ManagedChannelTargets, Extension API 5.13) meets the
 * companion's gateway port. A change in the platform's types touches this file only.
 *
 * A refusal is an error carrying a fixed `code`, on the error itself or in an RPC error's `data`.
 * It becomes a ChannelRefusal so the channel can tell a refusal from a lost call.
 */
export class ChannelRefusal extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'ChannelRefusal'
    this.code = code
  }
}

/** @param {unknown} error @returns {string | undefined} */
function codeOf(error) {
  if (!error || typeof error !== 'object') return undefined
  const { code, data } = /** @type {{ code?: unknown, data?: unknown }} */ (error)
  const inner = data && typeof data === 'object' ? /** @type {Record<string, unknown>} */ (data) : {}
  const found = [code, inner.code, inner.reason].find((v) => typeof v === 'string' && REFUSAL_CODES.includes(v))
  return /** @type {string | undefined} */ (found)
}

/** Runs one platform call; a refusal keeps its code, anything else passes through unchanged. @template T @param {() => Promise<T>} call */
async function guarded(call) {
  try {
    return await call()
  } catch (error) {
    const code = codeOf(error)
    if (code) throw new ChannelRefusal(code, error instanceof Error ? error.message : code)
    throw error
  }
}

/**
 * @param {unknown} channels `init.channels`; absent on a host without channel targets
 * @returns {import('./channel-contract.mjs').ChannelGateway | undefined}
 */
export function channelGateway(channels) {
  if (!channels || typeof channels !== 'object') return undefined
  const port = /** @type {any} */ (channels)
  return {
    async pairing() {
      const found = await guarded(() => port.pairing())
      if (found === undefined || found === null) return undefined
      if (!isPairing(found)) throw new Error('the platform returned a pairing the companion cannot read')
      return found
    },
    ...(typeof port.watchSession === 'function' ? { watchSession: (pairingId, sessionId) => guarded(() => port.watchSession(pairingId, sessionId)) } : {}),
    ...(typeof port.update === 'function' ? { update: (pairingId, messageId, input) => guarded(() => port.update(pairingId, messageId, input)) } : {}),
    send: (pairingId, input) => guarded(() => port.send(pairingId, input)),
    async delivery(pairingId, deliveryKey) {
      const state = await guarded(() => port.delivery(pairingId, deliveryKey))
      if (state?.state === 'delivered' && typeof state.messageId === 'string') return state
      if (state?.state === 'pending' || state?.state === 'failed') return { state: state.state }
      return { state: 'unknown' }
    },
    unpair: (pairingId) => guarded(() => port.unpair(pairingId)),
    onEvent: (handler) => port.onEvent(handler),
    onPairingChange: (handler) => port.onPairingChange(handler),
  }
}
