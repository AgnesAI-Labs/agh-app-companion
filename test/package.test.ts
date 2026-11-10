import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { managedServiceCapabilities } from '../../../../packages/extension-api/src/index.js'
import { resolvePreset } from '../../../../packages/host-common/src/presets/resolve.js'
import { parse as parseYaml } from '../../../../packages/host-common/node_modules/yaml/dist/index.js'
import {
  createPackageManager,
  emptyLock,
  parseSource,
  preflightPackageBundles,
  writeLock,
} from '../../../../packages/package-manager/src/index.js'
import { DESK_CAPABILITIES } from '../desk.mjs'
import { ENGINE_ID } from '../index.mjs'
import { SETTINGS_SCHEMA } from '../settings.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const row = pkg.agnes.plugins[0]
const harness = join(process.env.AGNES_HARNESS ?? join(homedir(), 'agnes-harness'), 'packages')

/** The platform's shipped base, recipe and permission documents, plus this package's Bundle presets. */
function presetCatalog() {
  const docs: Record<string, Record<string, unknown>> = {}
  const load = (path: string) => {
    const doc = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>
    docs[String(doc.name)] = doc
  }
  load(join(harness, 'base/presets/base.yaml'))
  for (const file of readdirSync(join(harness, 'code/presets')))
    if (file.endsWith('.yaml')) load(join(harness, 'code/presets', file))
  for (const bundle of Object.values(pkg.agnes.bundles) as { presets: Record<string, Record<string, unknown>> }[])
    Object.assign(docs, bundle.presets)
  return docs
}

describe('package declaration', () => {
  it('is accepted by the package manager inspection with no blockers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'companion-inspect-'))
    try {
      const profile = join(root, 'profiles', 'local-dev')
      mkdirSync(profile, { recursive: true })
      cpSync(fileURLToPath(new URL('..', import.meta.url)), join(root, 'companion'), {
        recursive: true,
        filter: (src) => !/\/(node_modules|test|\.git)(\/|$)/.test(src),
      })
      writeLock(profile, {
        ...emptyLock('local-dev', '0.1.0'),
        resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
        seams: Object.fromEntries(
          ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((n) => [
            n,
            { provider: 'local' },
          ]),
        ),
        policySnapshot: {
          capabilityCeiling: ['ui', 'store', 'tools', 'services', 'managedServices'],
          workspacePackages: 'require-project-trust',
        },
      })
      const manager = createPackageManager({
        dataDir: root,
        cwd: root,
        agnesVersion: '0.1.0',
        now: () => '2026-11-10T00:00:00Z',
        references: async () => [],
      })
      const preview = await manager
        .inspect(profile, parseSource('file:./companion'))
        .catch((error) => {
          throw new Error(`inspect refused: ${JSON.stringify(error.detail)}`)
        })
      expect(preview).toMatchObject({ id: pkg.name, version: pkg.version, blockers: [] })
      expect(preview.preflight).toEqual({
        level: 'deployment-dependent',
        reasons: [
          'preset-inheritance-definition-required:minimal',
          'preset-inheritance-definition-required:standard',
          'runtime-registration-required',
        ],
        next: 'validate-deployment',
      })
      expect(preview.warnings.map((w: { code: string }) => w.code).sort()).toEqual([
        'capability-change',
        'unverified-provenance',
      ])
      expect(preview.application?.id).toBe('companion')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes the structural preflight, and the full preflight waits only on deployment presets and runtime', () => {
    const input = { packageId: pkg.name, bundles: pkg.agnes.bundles, pages: ['desk', 'settings'] }
    expect(preflightPackageBundles({ ...input, stage: 'structural' })).toEqual({
      level: 'structural',
      reasons: [],
      next: 'resolve-static-references',
    })
    const full = preflightPackageBundles({ ...input, runtime: [{ runtime: row.runtime }] })
    expect(full.level).toBe('deployment-dependent')
    expect([...full.reasons].sort()).toEqual([
      'preset-inheritance-definition-required:minimal',
      'preset-inheritance-definition-required:standard',
      'runtime-registration-required',
    ])
  })

  it('declares the Host facade services for the managed engine, with the settings schema, and the task desk\'s two', () => {
    expect(row.capabilities.store).toBe(true)
    expect(row.capabilities.managedServices).toEqual([
      expect.objectContaining({ id: ENGINE_ID, scope: 'profile', artifact: { kind: 'in-process' } }),
    ])
    expect(row.capabilities.services).toEqual(
      JSON.parse(
        JSON.stringify([
          ...managedServiceCapabilities(ENGINE_ID, SETTINGS_SCHEMA),
          DESK_CAPABILITIES.query,
          DESK_CAPABILITIES.submit,
        ]),
      ),
    )
    const clientServices = JSON.parse(readFileSync(new URL('../client/agnes.client.json', import.meta.url), 'utf8')).client.services
    expect(clientServices).toEqual(
      expect.arrayContaining(['companion.desk', 'companion.submit', 'companion.status', 'companion.configuration', 'companion.check', 'companion.configure']),
    )
    for (const name of clientServices) expect(row.capabilities.services.map((s: { name: string }) => s.name)).toContain(name)
  })
})

describe('role Bundles through the platform preset resolver', () => {
  const docs = presetCatalog()

  it('resolves judge with an empty tool allowlist and its own full prompt', () => {
    const judge = resolvePreset('companion-judge', docs, { permission: 'read-only' })
    expect(judge.view.tools.allow).toEqual([])
    expect(judge.doc.surfaces).toEqual(['daemon', 'sdk'])
    expect(judge.view.model.systemPrompt?.fullOverride).toEqual(expect.any(String))
  })

  it('resolves worker under full access, keeps standard tools unfiltered and parks unanswerable approvals', () => {
    const worker = resolvePreset('companion-worker', docs, { permission: 'full-access' })
    expect(worker.permission).toBe('full-access')
    expect(worker.view.tools.allow).toBeUndefined()
    expect((worker.doc.tools as { core: string[] }).core).toEqual(expect.arrayContaining(['shell', 'write', 'edit']))
    expect(worker.doc.approval).toMatchObject({ on_unavailable: 'park' })
    expect(worker.doc.ext_ui).toMatchObject({ unattended: 'decline' })
  })

  it('declares publish and publish_plan as this package tools, so only worker (no allowlist) can see them', () => {
    expect(row.capabilities.tools.names).toEqual(['publish', 'publish_plan'])
    expect(resolvePreset('companion-judge', docs).view.tools.allow).toEqual([])
  })

  it('declares a deny of the skill install tools in the worker session patch (N9; not proven to bind at runtime)', () => {
    expect(pkg.agnes.bundles.worker.profile.toolPolicy.deny).toEqual([
      'skill_helper_create',
      'skill_helper_import',
      'skill_helper_install',
    ])
  })
})
