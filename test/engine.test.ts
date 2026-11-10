import { describe, expect, it, vi } from 'vitest'
import { ENGINE_ID, main, startEngine } from '../index.mjs'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA } from '../settings.mjs'
import { STORE_FORMAT } from '../store.mjs'
import { memoryOwnedStore } from './owned-store.js'

const init = (store = memoryOwnedStore(), config: unknown = DEFAULT_SETTINGS) => ({
  signal: new AbortController().signal,
  store,
  wakes: {} as never,
  config: config as never,
  listeners: {},
  assertCurrent: () => {},
  ready: vi.fn(),
  onShutdown: vi.fn(),
})

describe('managed engine', () => {
  it('registers one resource whose configuration is the settings schema', () => {
    const register = vi.fn()
    main.apply({ profileRuntime: { register }, tools: { register: vi.fn() } } as never)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ id: ENGINE_ID, configSchema: SETTINGS_SCHEMA, defaultConfig: DEFAULT_SETTINGS }),
    )
  })

  it('becomes ready on a fresh store with the unconfigured defaults', async () => {
    const i = init()
    await startEngine(i)
    expect(i.onShutdown).toHaveBeenCalledOnce()
    expect(i.ready).toHaveBeenCalledOnce()
  })

  it('never becomes ready on a store written by a newer format', async () => {
    const store = memoryOwnedStore()
    store.set('meta', { format: STORE_FORMAT + 1 })
    const i = init(store)
    await expect(startEngine(i)).rejects.toThrow(/newer/)
    expect(i.ready).not.toHaveBeenCalled()
  })

  it('never becomes ready with settings that break the semantic rules', async () => {
    const i = init(memoryOwnedStore(), {
      ...DEFAULT_SETTINGS,
      workspaces: [{ shortName: 'api', path: '/w' }],
      dedicatedWorkspace: '/w',
    })
    await expect(startEngine(i)).rejects.toThrow(/dedicated workspace/)
    expect(i.ready).not.toHaveBeenCalled()
  })
})
