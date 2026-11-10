import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../client/index.js'

const descriptor = JSON.parse(readFileSync(new URL('../client/agnes.client.json', import.meta.url), 'utf8')).client

describe('client module registration', () => {
  it('gives every home entry a title that resolves to text in both languages, matching its declaration', () => {
    const catalogs: Record<string, Record<string, string>> = {}
    const entries: any[] = []
    const ctx = {
      profile: { services: {} },
      locale: { register: vi.fn((_ns: string, c: Record<string, Record<string, string>>) => Object.assign(catalogs, c)) },
      homeEntries: { register: vi.fn((e: any) => (entries.push(e), () => {})) },
      presentationRoles: { register: vi.fn(() => () => {}) },
    }
    const dispose = apply(ctx as never)
    expect(entries.map((e) => e.id)).toEqual(descriptor.homeEntries.map((e: any) => e.id))
    for (const entry of entries) {
      expect(entry.titleKey).toEqual(expect.any(String))
      for (const lang of ['en', 'zh-CN']) expect(catalogs[lang]?.[entry.titleKey]?.trim()).toBeTruthy()
      const declared = descriptor.homeEntries.find((e: any) => e.id === entry.id).navigation
      expect(catalogs['zh-CN']![entry.titleKey]).toBe(declared.titles['zh-CN'])
      expect(catalogs.en![entry.titleKey]).toBe(declared.title)
    }
    dispose()
  })
})
