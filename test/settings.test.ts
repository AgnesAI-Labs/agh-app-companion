import { describe, expect, it } from 'vitest'
import { compileExtensionSchema } from '../../../../packages/host-extensions/src/ext-host/json-schema.js'
import { DEFAULT_SETTINGS, missingSettings, parseSettings, SETTINGS_SCHEMA } from '../settings.mjs'

// The validator the Host runs on managed defaultConfig and configure input (host-extensions/src/profile/managed.ts).
const hostAccepts = compileExtensionSchema(SETTINGS_SCHEMA, 'E_SERVICE_DEF')

const complete = {
  ownerName: 'Owner',
  workspaces: [
    { shortName: 'api', path: '/work/api' },
    { shortName: 'web', path: '/work/web' },
  ],
  dedicatedWorkspace: '/work/companion',
  channelInstance: 'chat-main',
  models: { judge: { route: 'local-small', local: true }, worker: { route: '', local: false } },
}

describe('companion settings', () => {
  it('accepts the unconfigured default, which the Host validates against the same schema', () => {
    expect(hostAccepts(DEFAULT_SETTINGS)).toBe(true)
    expect(parseSettings(DEFAULT_SETTINGS)).toEqual({ ok: true, value: DEFAULT_SETTINGS })
    expect(missingSettings(DEFAULT_SETTINGS)).toEqual([
      'ownerName',
      'workspaces',
      'dedicatedWorkspace',
      'channelInstance',
    ])
  })

  it('accepts a complete configuration with nothing missing', () => {
    expect(hostAccepts(complete)).toBe(true)
    const parsed = parseSettings(complete)
    expect(parsed).toEqual({ ok: true, value: complete })
    expect(missingSettings(complete)).toEqual([])
  })

  it.each([
    ['duplicate short names', { workspaces: [complete.workspaces[0], { shortName: 'api', path: '/work/other' }] }, /duplicate short name api/],
    ['the same path twice', { workspaces: [complete.workspaces[0], { shortName: 'api2', path: '/work/api' }] }, /listed twice/],
    ['a relative workspace path', { workspaces: [{ shortName: 'api', path: 'work/api' }] }, /absolute/],
    ['a relative dedicated workspace', { dedicatedWorkspace: 'companion' }, /absolute/],
    ['a dedicated workspace that is also a task workspace', { dedicatedWorkspace: '/work/web' }, /dedicated workspace/],
  ])('refuses %s', (_name, patch, message) => {
    const result = parseSettings({ ...complete, ...patch })
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.errors.join('\n')).toMatch(message)
  })

  it.each([
    ['an upper-case short name', { workspaces: [{ shortName: 'API', path: '/work/api' }] }],
    ['an unknown field', { extra: true }],
    ['a missing model role', { models: { judge: complete.models.judge } }],
    ['a null where text is expected', { channelInstance: null }],
  ])('leaves %s to the Host schema check, which refuses it', (_name, patch) => {
    expect(hostAccepts({ ...complete, ...patch })).toBe(false)
  })

  it('treats a blank owner name as missing, not configured', () => {
    expect(missingSettings({ ...complete, ownerName: '   ' })).toEqual(['ownerName'])
  })

  describe('usage caps', () => {
    it('defaults to no cap, because the design sets no amount (spec section 10)', () => {
      expect(DEFAULT_SETTINGS.caps).toEqual({ dailyCost: null, taskCost: null, taskTokens: null })
    })

    it('accepts a configuration saved before caps existed, and one with caps set or cleared', () => {
      expect(hostAccepts(complete)).toBe(true)
      expect(hostAccepts({ ...complete, caps: { dailyCost: 5, taskCost: 1.5, taskTokens: 200000 } })).toBe(true)
      expect(hostAccepts({ ...complete, caps: { dailyCost: null, taskCost: null, taskTokens: null } })).toBe(true)
      expect(hostAccepts({ ...complete, caps: { dailyCost: 5 } })).toBe(true)
    })

    it.each([
      ['zero', { dailyCost: 0 }],
      ['a negative cost', { taskCost: -1 }],
      ['text', { dailyCost: '5' }],
      ['fractional tokens', { taskTokens: 10.5 }],
      ['an unknown cap', { dailyTokens: 10 }],
      ['a non-finite-sized number', { dailyCost: 1e12 }],
    ])('refuses %s', (_name, caps) => {
      expect(hostAccepts({ ...complete, caps })).toBe(false)
    })
  })
})
