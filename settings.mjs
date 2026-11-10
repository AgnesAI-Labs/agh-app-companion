/**
 * Owner settings. They are the managed engine's configuration: the Host validates `configure` input
 * against SETTINGS_SCHEMA and hands the saved value to `start(init.config)`, so the shape is already
 * checked there; parseSettings adds the rules a JSON schema cannot state. An empty string means
 * "not chosen yet".
 *
 * @typedef {{ shortName: string, path: string }} Workspace
 * @typedef {{ route: string, local: boolean }} ModelChoice  route '' = deployment default; local is the owner's own statement about the primary route
 * @typedef {{
 *   ownerName: string,
 *   workspaces: Workspace[],
 *   dedicatedWorkspace: string,
 *   channelInstance: string,
 *   models: { judge: ModelChoice, worker: ModelChoice },
 * }} Settings
 */
const model = {
  type: 'object',
  additionalProperties: false,
  required: ['route', 'local'],
  properties: { route: { type: 'string', maxLength: 128 }, local: { type: 'boolean' } },
}

export const SETTINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ownerName', 'workspaces', 'dedicatedWorkspace', 'channelInstance', 'models'],
  properties: {
    ownerName: { type: 'string', maxLength: 64 },
    workspaces: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shortName', 'path'],
        properties: {
          shortName: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' },
          path: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
    },
    dedicatedWorkspace: { type: 'string', maxLength: 4096 },
    channelInstance: { type: 'string', maxLength: 128 },
    models: {
      type: 'object',
      additionalProperties: false,
      required: ['judge', 'worker'],
      properties: { judge: model, worker: model },
    },
  },
}

/** @type {Settings} */
export const DEFAULT_SETTINGS = Object.freeze({
  ownerName: '',
  workspaces: [],
  dedicatedWorkspace: '',
  channelInstance: '',
  models: { judge: { route: '', local: false }, worker: { route: '', local: false } },
})

const absolute = (path) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

/** @param {Settings} value schema-valid settings @returns {{ ok: true, value: Settings } | { ok: false, errors: string[] }} */
export function parseSettings(value) {
  const errors = []
  const names = new Set()
  const paths = new Set()
  for (const { shortName, path } of value.workspaces) {
    if (names.has(shortName)) errors.push(`duplicate short name ${shortName}`)
    if (paths.has(path)) errors.push(`workspace ${path} is listed twice`)
    if (!absolute(path)) errors.push(`workspace ${shortName} needs an absolute path`)
    names.add(shortName)
    paths.add(path)
  }
  if (value.dedicatedWorkspace) {
    if (!absolute(value.dedicatedWorkspace)) errors.push('the dedicated workspace needs an absolute path')
    if (paths.has(value.dedicatedWorkspace))
      errors.push('the dedicated workspace must not also be a task workspace')
  }
  return errors.length ? { ok: false, errors } : { ok: true, value }
}

/** What the owner still has to fill in before the engine takes work. @param {Settings} settings */
export function missingSettings(settings) {
  return [
    ...(settings.ownerName.trim() ? [] : ['ownerName']),
    ...(settings.workspaces.length ? [] : ['workspaces']),
    ...(settings.dedicatedWorkspace ? [] : ['dedicatedWorkspace']),
    ...(settings.channelInstance ? [] : ['channelInstance']),
  ]
}
