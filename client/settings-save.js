const FINAL = new Set(['completed', 'refused', 'cancelled'])

/**
 * One owner save as one effect. The platform binds an approval to the operation id, so a retry of the
 * same payload after the owner approved must resend the same id. A new id starts only when the payload
 * changes or the previous save reached a final state (a reused id after completion is a no-op).
 */
export function createSaver(effect, newId = () => crypto.randomUUID()) {
  let attempt = null
  return async function save(draft) {
    const json = JSON.stringify(draft)
    const operationId = attempt?.json === json ? attempt.id : newId()
    attempt = { json, id: operationId }
    const receipt = await effect(draft, { operationId })
    if (FINAL.has(receipt?.state)) attempt = null
    return receipt
  }
}
