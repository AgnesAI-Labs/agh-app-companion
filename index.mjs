import { DEFAULT_SETTINGS, parseSettings, SETTINGS_SCHEMA } from './settings.mjs'
import { openStore } from './store.mjs'

export const ENGINE_ID = 'companion'

/**
 * Starts the task engine resource. The task loop lands later; today it opens the store and the
 * settings so a store this build cannot read, or settings that break the rules, stop it before ready.
 * @param {import('@agnes/extension-api').ProfileManagedInit} init
 */
export async function startEngine(init) {
  init.onShutdown(async () => ({ state: 'settled' }))
  const store = openStore(init.store)
  const settings = parseSettings(/** @type {never} */ (init.config))
  if (!settings.ok) throw new Error(`companion settings are invalid: ${settings.errors.join('; ')}`)
  init.ready()
  return { store, settings: settings.value }
}

export const main = {
  inject: ['services', 'profileRuntime'],
  /** @param {Pick<import('@agnes/extension-api').PluginContextFacets, 'services' | 'profileRuntime'>} ctx */
  apply(ctx) {
    ctx.profileRuntime.register({
      id: ENGINE_ID,
      configSchema: SETTINGS_SCHEMA,
      defaultConfig: DEFAULT_SETTINGS,
      start: startEngine,
    })
  },
}
