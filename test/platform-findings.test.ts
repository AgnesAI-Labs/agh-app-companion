import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { seatbeltConfine } from '../../../../packages/base/extensions/sandbox/src/backends/seatbelt.js'
import { defaultSystemPrompt } from '../../../../packages/code/src/prompts/system-prompt.js'
import { composeSystemPrompt } from '../../../../packages/core/src/request/system-prompt.js'
import { resolvePreset } from '../../../../packages/host-common/src/presets/resolve.js'
import {
  compileWorkspacePolicy,
  normalizeSandboxStaticConfig,
} from '../../../../packages/host-common/src/workspace-policy.js'
import { parse as parseYaml } from '../../../../packages/host-common/node_modules/yaml/dist/index.js'

// Evidence for the A1 platform questions, run against platform sources at the pinned checkout.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const judgePrompt = pkg.agnes.bundles.judge.presets['companion-judge'].model.system_prompt
const harness = join(process.env.AGNES_HARNESS ?? join(homedir(), 'agnes-harness'), 'packages')
function presetCatalog() {
  const docs: Record<string, Record<string, unknown>> = {}
  const load = (path: string) => {
    const doc = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>
    docs[String(doc.name)] = doc
  }
  load(join(harness, 'base/presets/base.yaml'))
  for (const file of readdirSync(join(harness, 'code/presets')))
    if (file.endsWith('.yaml')) load(join(harness, 'code/presets', file))
  Object.assign(docs, pkg.agnes.bundles.worker.presets)
  return docs
}

/** host/src/runtime/sessions/session.ts: the profile's saved prompt settings are spread over the Bundle's. */
const sessionPromptConfig = (profile: Record<string, string>) => ({ ...judgePrompt, ...profile })
const skillsCatalog = { id: 'skills', order: 160, text: '<available_skills>\n</available_skills>', source: 'ext:skills' }
const compose = (config: Record<string, string>) =>
  composeSystemPrompt({ config, provider: defaultSystemPrompt }, [skillsCatalog])

describe('Q2: the judge fullOverride against the owner profile prompt', () => {
  it('survives when the profile saved nothing', () => {
    expect(compose(sessionPromptConfig({})).map((s) => s.text)).toEqual([judgePrompt.fullOverride])
  })

  it('is replaced when the profile saved its own full replacement', () => {
    expect(compose(sessionPromptConfig({ fullOverride: 'owner text' })).map((s) => s.text)).toEqual(['owner text'])
  })

  it('makes prompt composition throw when the profile saved opening, closing or reply-style text', () => {
    for (const field of ['personaPrefix', 'personaSuffix', 'replyStyle'])
      expect(() => compose(sessionPromptConfig({ [field]: 'be brief' })), field).toThrow(/conflicts/)
  })
})

describe('Q3: the Skills catalogue in a session with fullOverride', () => {
  it('is dropped by the full replacement, which is what keeps it out of judge (not allow: [])', () => {
    expect(compose(sessionPromptConfig({})).map((s) => s.id)).not.toContain('skills')
    expect(composeSystemPrompt({ config: {}, provider: defaultSystemPrompt }, [skillsCatalog]).map((s) => s.id)).toContain(
      'skills',
    )
  })
})

describe.skipIf(process.platform !== 'darwin')('Q5: hard denies on commands under full access (Seatbelt)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-sbx-')))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const data = join(root, 'data')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(data, { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_test'), 'synthetic key\n')
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, env })
  const repo = (path: string) => {
    mkdirSync(path, { recursive: true })
    git(path, 'init', '-q', '-b', 'main')
    writeFileSync(join(path, 'a.txt'), 'a\n')
    git(path, 'add', 'a.txt')
    git(path, 'commit', '-q', '-m', 'init')
  }
  const canonicalize = async (path: string, options?: { base?: string }): Promise<string> => {
    const absolute = path.startsWith('/') ? path : join(options?.base ?? root, path)
    try {
      return realpathSync(absolute)
    } catch {
      return join(await canonicalize(dirname(absolute)), basename(absolute))
    }
  }
  // The worker Bundle resolved under full access, read by the same normalizer the Host uses.
  const workerSandbox = normalizeSandboxStaticConfig(
    resolvePreset('companion-worker', presetCatalog(), { permission: 'full-access' }).doc,
  )
  /** The real chain: resolved worker sandbox config, workspace plan, Seatbelt compile, sandbox-exec. */
  const confined = async (workspace: string, script: string) => {
    const plan = await compileWorkspacePolicy({
      canonicalRoot: workspace,
      dataDir: data,
      homeDir: home,
      semantics: { flavor: 'posix', caseSensitive: false },
      staticConfig: workerSandbox,
      canonicalize,
    })
    const [cmd, ...args] = seatbeltConfine(['/bin/sh', '-c', script], plan.backendOptions as never)
    const run = spawnSync(String(cmd), args, { cwd: workspace, env, encoding: 'utf8' })
    return { plan, status: run.status, out: `${run.stdout}${run.stderr}` }
  }
  const commit = 'git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m next'

  it('reads the resolved worker Bundle as full access at L0, falling open when no backend exists', () => {
    expect(workerSandbox).toMatchObject({ level: 'L0', access: 'full-access', onUnavailable: 'allow' })
  })

  it('lets the command write ordinary workspace files and paths outside the workspace', async () => {
    const ws = join(root, 'plain')
    repo(ws)
    const result = await confined(ws, `echo hi > ${ws}/b.txt && echo hi > ${root}/outside.txt`)
    expect(result.status, result.out).toBe(0)
    expect(result.plan.backendOptions.denyPaths).toEqual(
      expect.arrayContaining([join(ws, '.git'), join(home, '.ssh'), join(data, 'secrets')]),
    )
  })

  it('refuses git commit in a workspace whose .git directory is inside it', async () => {
    const ws = join(root, 'repo')
    repo(ws)
    const result = await confined(ws, commit)
    expect(result.status).not.toBe(0)
    expect(result.out).toMatch(/fatal: error reading '.*\/repo\/\.git'/)
  })

  it('refuses git commit in a linked worktree too, because its .git pointer file is denied', async () => {
    const main = join(root, 'main')
    repo(main)
    const ws = join(root, 'wt')
    git(main, 'worktree', 'add', '-q', '-b', 'task', ws)
    const result = await confined(ws, commit)
    expect(result.status).toBe(128)
    expect(result.out).toMatch(/fatal: error reading '.*\/wt\/\.git'/)
  })

  it('refuses reading anything under the home .ssh directory', async () => {
    const result = await confined(join(root, 'plain'), `cat ${home}/.ssh/id_test`)
    expect(result.status).not.toBe(0)
    expect(result.out).toMatch(/Operation not permitted/)
  })
})
