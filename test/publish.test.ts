import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkToolDef } from '../../../../packages/extension-api/src/index.js'
import {
  ghPullRequests,
  PUBLISH_META,
  PUBLISH_PLAN_META,
  parseProposal,
  planPublish,
  preparePublish,
  publishPlanTool,
  publishTool,
  runPublish,
} from '../publish.mjs'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) {
    chmodTree(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

function chmodTree(dir: string, mode: number) {
  if (existsSync(dir)) execFileSync('chmod', ['-R', mode.toString(8), dir])
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const ORIGIN = 'git@example.test:owner/repo.git'
const REPO = 'example.test/owner/repo'

/**
 * A work repo on `main` with one commit, an `origin` holding it, and origin/HEAD set. origin is the
 * SSH address ORIGIN, so publish can name its repository; an ssh stand-in serves it from the bare
 * repository `remote` on disk.
 */
function repos() {
  const dir = mkdtempSync(join(tmpdir(), 'companion-publish-'))
  temps.push(dir)
  const remote = join(dir, 'owner', 'repo.git')
  const work = join(dir, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  git(work, 'config', 'user.name', 'Test Owner')
  git(work, 'config', 'user.email', 'owner@example.test')
  // A detached auto gc would still be repacking while afterEach removes the directory.
  git(work, 'config', 'gc.auto', '0')
  git(work, 'config', 'maintenance.auto', 'false')
  writeFileSync(join(work, 'README.md'), 'hello\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'init')
  const ssh = join(dir, 'fake-ssh')
  writeFileSync(ssh, `#!/bin/sh\ncd '${dir}' && eval "$(printf '%s' "$2" | sed 's/^git-/git /')"\n`, {
    mode: 0o755,
  })
  git(work, 'config', 'core.sshCommand', ssh)
  git(work, 'config', 'ssh.variant', 'simple')
  git(work, 'remote', 'add', 'origin', ORIGIN)
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'remote', 'set-head', 'origin', 'main')
  return { dir, remote, work }
}

const remoteTip = (remote: string, branch: string) => {
  try {
    return execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return undefined
  }
}

/** The tree `git add -A` would make of the working tree, less `excluded`, built in a scratch index. */
function worktreeTree(dir: string, work: string, excluded: string[] = []) {
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'scratch-index') }
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: work, env })
  execFileSync('git', ['add', '-A', '--', '.', ...excluded.map((path) => `:(exclude)${path}`)], {
    cwd: work,
    env,
  })
  return execFileSync('git', ['write-tree'], { cwd: work, env, encoding: 'utf8' }).trim()
}

/**
 * PR port double keyed by repo and head; `failCreate` makes the next create record the PR, then
 * throw; `urlRepo` is the repository the PR URLs it answers with point into.
 */
function fakePrs() {
  const prs: { repo: string; head: string; base?: string; title: string; body: string; url: string }[] = []
  const state = { failCreate: false, creates: 0, urlRepo: REPO }
  return {
    prs,
    state,
    port: {
      async find({ repo, head }: { repo: string; head: string; commit: string }) {
        return prs.find((pr) => pr.repo === repo && pr.head === head)?.url
      },
      async create(input: { repo: string; head: string; base?: string; title: string; body: string }) {
        state.creates++
        const url = `https://${state.urlRepo}/pull/${prs.length + 1}`
        const { repo, head, base, title, body } = input
        prs.push({ repo, head, base, title, body, url })
        if (state.failCreate) {
          state.failCreate = false
          throw new Error('connection reset after the request was sent')
        }
        return url
      },
    },
  }
}

const plan = (args: Record<string, unknown>) => {
  const parsed = planPublish(args)
  if (!parsed.ok) throw new Error(`plan refused: ${JSON.stringify(parsed)}`)
  return parsed.plan
}

/** What publish_plan proposes for these arguments: the arguments a person would approve. */
async function propose(work: string, args: Record<string, unknown>) {
  const planned = await preparePublish({ root: work, plan: plan(args) })
  if (planned.status !== 'planned') throw new Error(`prepare refused: ${JSON.stringify(planned)}`)
  return planned.proposal
}

/** Runs publish on approved arguments, as the tool does after the checkpoint. */
async function publish(work: string, approved: Record<string, unknown>, prs: unknown) {
  const parsed = parseProposal(approved)
  if (!parsed.ok) throw new Error(`proposal refused: ${JSON.stringify(parsed)}`)
  return runPublish({ root: work, proposal: parsed.proposal, plan: parsed.plan, prs: prs as never })
}

describe('publish plan arguments', () => {
  it('derives every destination field from the arguments: origin, a title branch, the base', () => {
    expect(plan({ title: 'Fix login', body: 'Details', base: 'main' })).toEqual({
      remote: 'origin',
      branch: expect.stringMatching(/^companion\/fix-login-[0-9a-f]{6}$/),
      base: 'main',
      title: 'Fix login',
      body: 'Details',
      commitMessage: 'Fix login\n\nDetails',
    })
    expect(plan({ title: 'Fix login', body: '' }).branch).toBe(plan({ title: 'Fix login', body: 'x' }).branch)
    expect(plan({ title: '修复登录', body: '' }).branch).toMatch(/^companion\/[0-9a-f]{8}$/)
    expect(plan({ title: 'T', body: '', branch: 'feat/x' }).branch).toBe('feat/x')
  })

  it.each(['main', 'Main', 'master', 'develop', 'trunk', 'HEAD', 'release/1.2', 'release'])(
    'refuses the protected-looking branch %s',
    (branch) => {
      expect(planPublish({ title: 'T', body: '', branch })).toEqual({
        ok: false,
        reason: 'protected-branch',
        detail: expect.any(String),
      })
    },
  )

  it('refuses pushing onto the base branch', () => {
    expect(planPublish({ title: 'T', body: '', branch: 'feat/x', base: 'feat/x' })).toMatchObject({
      ok: false,
      reason: 'protected-branch',
    })
  })

  it.each([
    ['branch', '--force'],
    ['branch', '-d'],
    ['branch', 'a;b'],
    ['branch', 'a b'],
    ['branch', 'x/../y'],
    ['branch', '$(id)'],
    ['branch', 'x.lock'],
    ['branch', 'x/'],
    ['base', '--upload-pack=touch /tmp/x'],
    ['title', ''],
    ['title', 'one\ntwo'],
    ['body', 'nul\u0000byte'],
  ])('refuses %s %j at the boundary', (field, value) => {
    expect(planPublish({ title: 'T', body: '', [field]: value })).toMatchObject({
      ok: false,
      reason: 'invalid-input',
    })
  })

  it('refuses publish arguments that are not a publish_plan proposal', () => {
    const ok = {
      title: 'T',
      body: '',
      branch: 'feat/t',
      remote: 'r',
      repo: 'example.test/o/r',
      tree: 'a'.repeat(40),
      files: ['f'],
    }
    expect(parseProposal(ok)).toMatchObject({ ok: true })
    for (const bad of [
      { ...ok, branch: undefined },
      { ...ok, branch: 'main' },
      { ...ok, tree: 'HEAD' },
      { ...ok, files: [] },
      { ...ok, remote: 'a\nb' },
      { ...ok, repo: undefined },
      { ...ok, repo: 'o/r' },
      { ...ok, repo: 'example.test/o/r/extra' },
    ])
      expect(parseProposal(bad)).toMatchObject({ ok: false })
  })
})

describe('publish against real git', () => {
  it('plans without writing to the repository, then publishes exactly the plan and leaves the checkout alone', async () => {
    const { remote, work } = repos()
    writeFileSync(join(work, 'README.md'), 'hello world\n')
    mkdirSync(join(work, 'src'))
    writeFileSync(join(work, 'src', 'a.txt'), 'a\n')
    const statusBefore = git(work, 'status', '--porcelain')
    const objectsBefore = git(work, 'count-objects', '-v')
    const prs = fakePrs()

    const proposal = await propose(work, { title: 'Add a', body: 'Adds a.' })

    expect(proposal).toEqual({
      title: 'Add a',
      body: 'Adds a.',
      branch: expect.stringMatching(/^companion\/add-a-/),
      base: 'main',
      remote: ORIGIN,
      repo: REPO,
      tree: expect.stringMatching(/^[0-9a-f]{40}$/),
      files: ['README.md', 'src/a.txt'],
    })
    expect(git(work, 'count-objects', '-v')).toBe(objectsBefore)

    const result = await publish(work, proposal, prs.port)

    expect(result).toEqual({
      status: 'published',
      prUrl: 'https://example.test/owner/repo/pull/1',
      branch: proposal.branch,
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      remote: ORIGIN,
      files: ['README.md', 'src/a.txt'],
    })
    if (result.status !== 'published') return
    expect(remoteTip(remote, proposal.branch)).toBe(result.commit)
    expect(git(work, 'rev-parse', `${result.commit}^{tree}`)).toBe(proposal.tree)
    expect(git(work, 'log', '-1', '--format=%B', result.commit)).toBe('Add a\n\nAdds a.')
    expect(git(work, 'rev-parse', `${result.commit}^`)).toBe(git(work, 'rev-parse', 'main'))
    expect(prs.prs).toEqual([
      { repo: REPO, head: proposal.branch, base: 'main', title: 'Add a', body: 'Adds a.', url: result.prUrl },
    ])
    expect(git(work, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(work, 'status', '--porcelain')).toBe(statusBefore)
  })

  it.each([
    ['a file added', (work: string) => writeFileSync(join(work, 'late.txt'), 'late\n')],
    ['a file modified', (work: string) => writeFileSync(join(work, 'README.md'), 'edited after approval\n')],
  ])('refuses and pushes nothing when %s after the plan', async (_, change) => {
    const { remote, work } = repos()
    writeFileSync(join(work, 'README.md'), 'planned\n')
    const prs = fakePrs()
    const proposal = await propose(work, { title: 'Bound', body: '' })
    change(work)
    expect(await publish(work, proposal, prs.port)).toMatchObject({
      status: 'refused',
      reason: 'plan-changed',
    })
    expect(remoteTip(remote, proposal.branch)).toBeUndefined()
    expect(() => git(work, 'rev-parse', '--verify', '-q', `refs/heads/${proposal.branch}`)).toThrow()
    expect(prs.state.creates).toBe(0)
  })

  it('refuses when origin points somewhere other than the approved remote', async () => {
    const { work } = repos()
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const proposal = await propose(work, { title: 'Moved', body: '' })
    git(work, 'remote', 'set-url', 'origin', 'git@example.test:owner/other.git')
    expect(await publish(work, proposal, fakePrs().port)).toMatchObject({ reason: 'plan-changed' })
  })

  it('refuses a proposal whose repository is not the one origin names', async () => {
    const { remote, work } = repos()
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const proposal = await propose(work, { title: 'Forged', body: '', branch: 'feat/forged' })
    const prs = fakePrs()
    expect(await publish(work, { ...proposal, repo: 'example.test/other/repo' }, prs.port)).toMatchObject({
      status: 'refused',
      reason: 'plan-changed',
    })
    expect(remoteTip(remote, 'feat/forged')).toBeUndefined()
    expect(prs.state.creates).toBe(0)
  })

  it('reports nothing to commit for a clean workspace', async () => {
    const { work } = repos()
    expect(await preparePublish({ root: work, plan: plan({ title: 'Nothing', body: '' }) })).toEqual({
      status: 'refused',
      reason: 'nothing-to-commit',
      detail: expect.any(String),
    })
  })

  it('refuses secret-looking files at plan time, and again at publish time for a forged proposal', async () => {
    const { dir, remote, work } = repos()
    const secrets = [
      '.agh/secrets/token',
      '.env',
      '.env.local',
      'config/server.pem',
      'credentials.json',
      'keys/id_ed25519',
      '.netrc',
      'home/_netrc',
      '.npmrc',
      'pkg/.pypirc',
      '.git-credentials',
      'tls/server.key',
      'SSL/SERVER.PEM',
      'certs/client.p12',
      'certs/client.pfx',
      'android/release.jks',
      'android/release.keystore',
      'putty/me.ppk',
      'apple/AuthKey.p8',
      '.aws/config',
      '.azure/accessTokens.json',
      '.config/gcloud/application_default_credentials.json',
      '.config/gh/hosts.yml',
      '.kube/config',
      'deploy/.kube/config',
      'infra/.KUBE/config',
      '.docker/config.json',
      '.gnupg/pubring.kbx',
      '.ssh/known_hosts',
    ].sort()
    const nearMisses = [
      'ok.txt',
      'docs/aws.md',
      'aws/main.tf',
      'src/kube/client.ts',
      'docker/Dockerfile',
      '.dockerignore',
      'netrc.md',
      '.npmrc.example',
      'pypirc.md',
      'docs/git-credentials.md',
      'src/keyboard.ts',
      'src/monkey.key.ts',
      'notes.pem.txt',
      'my.kube/config',
      '.config/nvim/init.lua',
      '.config/gcloud-notes.md',
      'src/environment.ts',
    ]
    for (const file of [...secrets, ...nearMisses]) {
      mkdirSync(join(work, file, '..'), { recursive: true })
      writeFileSync(join(work, file), 'x\n')
    }
    const p = plan({ title: 'Leak', body: '', branch: 'feat/leak' })
    expect(await preparePublish({ root: work, plan: p })).toEqual({
      status: 'refused',
      reason: 'secret-files',
      detail: expect.any(String),
      files: secrets,
    })
    const forged = {
      title: 'Leak',
      body: '',
      branch: 'feat/leak',
      base: 'main',
      remote: ORIGIN,
      repo: REPO,
      tree: worktreeTree(dir, work),
      files: [...secrets, ...nearMisses].sort(),
    }
    expect(await publish(work, forged, fakePrs().port)).toMatchObject({
      status: 'refused',
      reason: 'secret-files',
      files: secrets,
    })
    expect(remoteTip(remote, 'feat/leak')).toBeUndefined()
  })

  it('refuses a changed-file list too long to read whole, at plan time and at publish time', async () => {
    const { dir, remote, work } = repos()
    // About 1.1 MB of NUL-separated names: past the output limit, so a cut list would hide the rest.
    const deep = join('d'.repeat(200), 'e'.repeat(200))
    mkdirSync(join(work, deep), { recursive: true })
    const files: string[] = []
    for (let i = 0; i < 1700; i++) {
      const file = join(deep, `${String(i).padStart(4, '0')}${'g'.repeat(240)}`)
      writeFileSync(join(work, file), `${i}\n`)
      files.push(file)
    }
    const p = plan({ title: 'Many', body: '', branch: 'feat/many' })
    expect(await preparePublish({ root: work, plan: p })).toEqual({
      status: 'refused',
      reason: 'git-failed',
      detail: expect.stringContaining('output exceeded'),
    })
    const forged = {
      title: 'Many',
      body: '',
      branch: 'feat/many',
      base: 'main',
      remote: ORIGIN,
      repo: REPO,
      tree: worktreeTree(dir, work),
      files: files.sort(),
    }
    expect(await publish(work, forged, fakePrs().port)).toMatchObject({
      status: 'refused',
      reason: 'git-failed',
      detail: expect.stringContaining('output exceeded'),
    })
    expect(remoteTip(remote, 'feat/many')).toBeUndefined()
  }, 30_000)

  it('plans in a repository whose tracked-file listing is far past the output limit', async () => {
    const { work } = repos()
    const deep = join('d'.repeat(200), 'e'.repeat(200))
    mkdirSync(join(work, deep), { recursive: true })
    for (let i = 0; i < 1700; i++)
      writeFileSync(join(work, deep, `${String(i).padStart(4, '0')}${'g'.repeat(240)}`), `${i}\n`)
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'many')
    writeFileSync(join(work, 'x.txt'), 'x\n')
    expect(await propose(work, { title: 'Big', body: '', branch: 'feat/big' })).toMatchObject({
      files: ['x.txt'],
    })
  }, 30_000)

  /** HEAD ignores `*.local`, `secrets/` and `nested/*.cache`, and tracks a force-added `keep.local`. */
  function reposWithIgnores() {
    const repo = repos()
    writeFileSync(join(repo.work, '.gitignore'), '*.local\nsecrets/\n')
    mkdirSync(join(repo.work, 'nested'))
    writeFileSync(join(repo.work, 'nested', '.gitignore'), '*.cache\n')
    writeFileSync(join(repo.work, 'keep.local'), 'tracked\n')
    git(repo.work, 'add', '-A')
    git(repo.work, 'add', '-f', 'keep.local')
    git(repo.work, 'commit', '-q', '-m', 'ignores')
    return repo
  }

  it.each([
    [
      'rewriting the root ignore file',
      (work: string) => {
        writeFileSync(join(work, '.gitignore'), 'node_modules/\n')
        writeFileSync(join(work, 'config.local'), 'token\n')
        mkdirSync(join(work, 'secrets'))
        writeFileSync(join(work, 'secrets', 'token.txt'), 'token\n')
      },
      ['config.local', 'secrets/token.txt'],
    ],
    [
      'a nested ignore file that ignores itself',
      (work: string) => {
        mkdirSync(join(work, 'sub'))
        writeFileSync(join(work, 'sub', '.gitignore'), '/.gitignore\n!*.local\n')
        writeFileSync(join(work, 'sub', 'x.local'), 'token\n')
      },
      ['sub/x.local'],
    ],
    [
      'deleting a nested ignore file',
      (work: string) => {
        rmSync(join(work, 'nested', '.gitignore'))
        writeFileSync(join(work, 'nested', 'x.cache'), 'token\n')
      },
      ['nested/x.cache'],
    ],
  ])('never publishes a path HEAD ignores, whatever %s un-ignores', async (_, change, ignored) => {
    const { dir, remote, work } = reposWithIgnores()
    change(work)
    writeFileSync(join(work, 'ok.txt'), 'ok\n')
    const p = plan({ title: 'Unignore', body: '', branch: 'feat/unignore' })
    expect(await preparePublish({ root: work, plan: p })).toEqual({
      status: 'refused',
      reason: 'ignored-files',
      detail: expect.any(String),
      files: ignored,
    })
    const forged = {
      title: 'Unignore',
      body: '',
      branch: 'feat/unignore',
      base: 'main',
      remote: ORIGIN,
      repo: REPO,
      tree: worktreeTree(dir, work),
      files: git(work, 'diff', '--name-only', 'HEAD')
        .split('\n')
        .filter(Boolean)
        .concat(git(work, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean))
        .sort(),
    }
    expect(forged.files).toEqual(expect.arrayContaining(ignored))
    expect(await publish(work, forged, fakePrs().port)).toMatchObject({
      status: 'refused',
      reason: 'ignored-files',
      files: ignored,
    })
    expect(remoteTip(remote, 'feat/unignore')).toBeUndefined()
  })

  it('publishes added ignore rules and edits to a tracked file that matches an ignore rule', async () => {
    const { remote, work } = reposWithIgnores()
    writeFileSync(join(work, '.gitignore'), '*.local\nsecrets/\n*.log\n')
    writeFileSync(join(work, 'build.log'), 'noise\n')
    writeFileSync(join(work, 'keep.local'), 'edited\n')
    writeFileSync(join(work, 'new.txt'), 'new\n')
    // Read as pathspec magic, this name would be `secrets/m`, which HEAD ignores; it is not.
    mkdirSync(join(work, ':(top)secrets'))
    writeFileSync(join(work, ':(top)secrets', 'm'), 'm\n')
    const files = ['.gitignore', ':(top)secrets/m', 'keep.local', 'new.txt']
    const proposal = await propose(work, { title: 'Narrow', body: '', branch: 'feat/narrow' })
    expect(proposal.files).toEqual(files)
    const result = await publish(work, proposal, fakePrs().port)
    expect(result).toMatchObject({ status: 'published', files })
    expect(remoteTip(remote, 'feat/narrow')).toBeDefined()
  })

  it('reads the ignore rules at HEAD even when the environment asks git for literal pathspecs', async () => {
    const { work } = reposWithIgnores()
    writeFileSync(join(work, '.gitignore'), '')
    writeFileSync(join(work, 'config.local'), 'token\n')
    process.env.GIT_LITERAL_PATHSPECS = '1'
    try {
      expect(
        await preparePublish({
          root: work,
          plan: plan({ title: 'Literal', body: '', branch: 'feat/literal' }),
        }),
      ).toMatchObject({ status: 'refused', reason: 'ignored-files', files: ['config.local'] })
    } finally {
      delete process.env.GIT_LITERAL_PATHSPECS
    }
  })

  it.each([
    ['fails', "echo 'fatal: simulated' >&2; exit 128", 'simulated'],
    ['is killed', 'kill -9 $$', 'killed by SIGKILL'],
  ])('refuses when the git that says which changed paths HEAD ignores %s', async (_, failure, detail) => {
    const { dir, work } = reposWithIgnores()
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\n[ "$1" = check-ignore ] && { ${failure}; }\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    )
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      expect(
        await preparePublish({ root: work, plan: plan({ title: 'T', body: '', branch: 'feat/t' }) }),
      ).toMatchObject({
        status: 'refused',
        reason: 'git-failed',
        detail: expect.stringContaining(detail),
      })
    } finally {
      process.env.PATH = path
    }
  })

  it('refuses when origin/HEAD cannot be read instead of planning without a base', async () => {
    const { work } = repos()
    writeFileSync(join(work, 'x.txt'), 'x\n')
    writeFileSync(join(work, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'garbage\n')
    expect(await preparePublish({ root: work, plan: plan({ title: 'T', body: '' }) })).toMatchObject({
      status: 'refused',
      reason: 'git-failed',
    })
  })

  it('names the repository from the push URL, dropping https userinfo, and refuses one it cannot read exactly', async () => {
    const { work } = repos()
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const p = plan({ title: 'T', body: '', branch: 'feat/t' })
    const planAt = async (url: string) => {
      git(work, 'remote', 'set-url', 'origin', url)
      return preparePublish({ root: work, plan: p })
    }
    for (const [url, remote, repo] of [
      ['https://github.com/o/r.git', 'https://github.com/o/r.git', 'github.com/o/r'],
      ['https://user:token@github.com/o/r', 'https://github.com/o/r', 'github.com/o/r'],
      ['https://user@github.com/o/r/', 'https://github.com/o/r/', 'github.com/o/r'],
      [
        'ssh://git@forge.example.test:2222/o/r.git',
        'ssh://git@forge.example.test:2222/o/r.git',
        'forge.example.test/o/r',
      ],
      ['git@github.com:o/r.git', 'git@github.com:o/r.git', 'github.com/o/r'],
      ['github.com:my.org/my.repo', 'github.com:my.org/my.repo', 'github.com/my.org/my.repo'],
    ])
      expect(await planAt(url as string)).toMatchObject({ status: 'planned', proposal: { remote, repo } })
    for (const url of [
      '/srv/git/r.git',
      'file:///srv/git/o/r.git',
      'https://github.com/o',
      'https://github.com/o/r/extra',
      'https://github.com/o/../r',
      'git@github.com:/abs/r.git',
      'ext::sh -c touch% /tmp/x',
      'https://us@er@github.com/o/r',
      'https://user:p@ss@github.com/o/r',
      'https://user:p:w@github.com/o/r',
      'https://u/x@github.com/o/r',
      'https://user:p%40w@github.com/o/r',
      'https://github.com/o/r?x=1',
      'https://github.com/o/r#frag',
      'https://github.com\\o\\r',
      'https://github.com/o/r .git',
      'https://github.com/o/r\u0001',
      'git@git hub.com:o/r',
      'git@github.com:o/r%2Fx',
      'git@github.com:o/r\\x',
      'git@github.com:o/r\t',
    ])
      expect(await planAt(url)).toMatchObject({ status: 'refused', reason: 'no-remote' })
  }, 30_000)

  it('names the repository git will push to, after pushurl and pushInsteadOf', async () => {
    const { dir, work } = repos()
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const p = plan({ title: 'T', body: '', branch: 'feat/t' })
    git(work, 'config', 'remote.origin.pushurl', 'git@example.test:owner/pushed.git')
    expect(await preparePublish({ root: work, plan: p })).toMatchObject({
      proposal: { remote: 'git@example.test:owner/pushed.git', repo: 'example.test/owner/pushed' },
    })
    git(work, 'config', '--unset', 'remote.origin.pushurl')
    const global = join(dir, 'gitconfig')
    writeFileSync(global, '[url "git@example.test:rewritten/"]\n\tpushInsteadOf = git@example.test:owner/\n')
    process.env.GIT_CONFIG_GLOBAL = global
    try {
      expect(await preparePublish({ root: work, plan: p })).toMatchObject({
        proposal: { remote: 'git@example.test:rewritten/repo.git', repo: 'example.test/rewritten/repo' },
      })
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL
    }
    git(work, 'config', '--add', 'remote.origin.pushurl', 'git@example.test:owner/a.git')
    git(work, 'config', '--add', 'remote.origin.pushurl', 'git@example.test:owner/b.git')
    expect(await preparePublish({ root: work, plan: p })).toMatchObject({
      status: 'refused',
      reason: 'no-remote',
    })
  })

  describe('a credential in a push URL', () => {
    const TOKEN = 'ghp_FAKE0000NOT0A0REAL0TOKEN0000'
    const tokenUrl = (token = TOKEN) => `https://${token}@example.test/owner/repo.git`
    const SHOWN = 'https://example.test/owner/repo.git'

    /**
     * Puts a git first on PATH that answers ls-remote and push itself, so an https remote needs no
     * network; `failWith` makes it fail those with that text on stderr.
     */
    function networkGit(dir: string, failWith?: string) {
      const bin = join(dir, 'net-bin')
      mkdirSync(bin, { recursive: true })
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
      const answer = failWith ? `{ printf '%s\\n' '${failWith}' >&2; exit 128; }` : 'exit 0'
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh\ncase "$1" in ls-remote|push) ${answer};; esac\nexec '${realGit}' "$@"\n`,
        { mode: 0o755 },
      )
      const path = process.env.PATH
      process.env.PATH = `${bin}:${path}`
      return () => {
        process.env.PATH = path
      }
    }

    const leaks = (value: unknown) => JSON.stringify(value).includes(TOKEN.slice(4, 20))

    it.each([
      ['as the user name', tokenUrl()],
      ['as the password after a fixed user', `https://x-access-token:${TOKEN}@example.test/owner/repo.git`],
    ])('never reaches the plan, the tool result or a log line, %s', async (_, url) => {
      const { work } = repos()
      git(work, 'remote', 'set-url', 'origin', url)
      writeFileSync(join(work, 'x.txt'), 'x\n')
      const logged: unknown[] = []
      const ctx = {
        session: { workspaceRoot: work },
        signal: new AbortController().signal,
        log: { info: (...args: unknown[]) => logged.push(args) },
      }
      const result = await publishPlanTool().execute({ title: 'T', body: '', branch: 'feat/t' }, ctx as never)
      expect(result.structured).toMatchObject({ status: 'planned', proposal: { remote: SHOWN, repo: REPO } })
      expect(leaks(result)).toBe(false)
      expect(leaks(logged)).toBe(false)
    })

    it('never reaches the publish result, and a change of only the credential is not a change', async () => {
      const { dir, work } = repos()
      git(work, 'remote', 'set-url', 'origin', tokenUrl('ghp_FAKE1111OLD1TOKEN11111111111'))
      writeFileSync(join(work, 'x.txt'), 'x\n')
      const proposal = await propose(work, { title: 'T', body: '', branch: 'feat/t' })
      git(work, 'remote', 'set-url', 'origin', tokenUrl())
      const restore = networkGit(dir)
      try {
        const result = await publish(work, proposal, fakePrs().port)
        expect(result).toMatchObject({ status: 'published', remote: SHOWN })
        expect(leaks(result)).toBe(false)
      } finally {
        restore()
      }
    })

    it.each([
      ['git cannot reach the remote', 'push-rejected'],
      ['gh fails', 'pr-failed'],
    ])('never reaches a refusal detail when %s, even when the error echoes the URL', async (_, reason) => {
      const { dir, work } = repos()
      git(work, 'remote', 'set-url', 'origin', tokenUrl())
      writeFileSync(join(work, 'x.txt'), 'x\n')
      const proposal = await propose(work, { title: 'T', body: '', branch: 'feat/t' })
      const echoed = `fatal: unable to access '${tokenUrl()}/': could not resolve host`
      const restore = networkGit(dir, reason === 'push-rejected' ? echoed : undefined)
      const prs = {
        async find() {
          return undefined
        },
        async create() {
          throw new Error(echoed)
        },
      }
      try {
        const result = await publish(work, proposal, prs)
        expect(result).toMatchObject({
          status: 'refused',
          reason,
          detail: expect.stringContaining('example.test'),
        })
        expect(leaks(result)).toBe(false)
      } finally {
        restore()
      }
    })

    it('still refuses a push URL that moved to another host, scheme or repository', async () => {
      const { work } = repos()
      writeFileSync(join(work, 'x.txt'), 'x\n')
      git(work, 'remote', 'set-url', 'origin', tokenUrl())
      const proposal = await propose(work, { title: 'T', body: '', branch: 'feat/t' })
      for (const moved of [
        `https://${TOKEN}@other.test/owner/repo.git`,
        `http://${TOKEN}@example.test/owner/repo.git`,
        `https://${TOKEN}@example.test/owner/other.git`,
      ]) {
        git(work, 'remote', 'set-url', 'origin', moved)
        expect(await publish(work, proposal, fakePrs().port)).toMatchObject({ reason: 'plan-changed' })
      }
    })

    const SECRET = 'FAKE0SECRET0NOT0REAL0000'

    it.each(['ssh', 'git+ssh', 'ssh+git'])(
      'keeps only the user name of a %s URL, in the plan and in a refusal that echoes the URL',
      async (scheme) => {
        const { dir, work } = repos()
        const raw = `${scheme}://user:${SECRET}@example.test/owner/repo.git`
        git(work, 'remote', 'set-url', 'origin', raw)
        writeFileSync(join(work, 'x.txt'), 'x\n')
        const proposal = await propose(work, { title: 'T', body: '', branch: 'feat/t' })
        expect(proposal).toMatchObject({ remote: `${scheme}://user@example.test/owner/repo.git`, repo: REPO })
        const restore = networkGit(dir, `fatal: could not read from '${raw}'`)
        try {
          const result = await publish(work, proposal, fakePrs().port)
          expect(result).toMatchObject({ status: 'refused', reason: 'push-rejected' })
          expect(JSON.stringify(result)).toContain(`${scheme}://user@example.test`)
          expect(JSON.stringify(result)).not.toContain(SECRET)
        } finally {
          restore()
        }
      },
    )

    it.each([
      ['ssh', `ssh://us@er:${SECRET}:more@part@example.test/owner/repo.git`, 'ssh://us@er@example.test'],
      ['https', `https://us@er:${SECRET}:more@part@example.test/owner/repo.git`, 'https://example.test'],
    ])('scrubs a %s userinfo with more than one @ and : from error text', async (_, raw, shown) => {
      const { work } = repos()
      writeFileSync(join(work, 'x.txt'), 'x\n')
      const proposal = await propose(work, { title: 'T', body: '', branch: 'feat/t' })
      const prs = {
        async find() {
          return undefined
        },
        async create() {
          throw new Error(`gh: could not push to ${raw}`)
        },
      }
      const result = await publish(work, proposal, prs)
      expect(result).toMatchObject({ status: 'refused', reason: 'pr-failed' })
      const text = JSON.stringify(result)
      expect(text).toContain(shown)
      for (const piece of [SECRET, 'more', 'part@']) expect(text).not.toContain(piece)
    })

    it('keeps the user name of ssh and scp-style remotes', async () => {
      const { work } = repos()
      writeFileSync(join(work, 'x.txt'), 'x\n')
      for (const url of ['ssh://git@example.test/owner/repo.git', 'git@example.test:owner/repo.git']) {
        git(work, 'remote', 'set-url', 'origin', url)
        expect(await propose(work, { title: 'T', body: '', branch: 'feat/t' })).toMatchObject({ remote: url })
      }
    })
  })

  it('refuses when the push URL changed after the plan', async () => {
    const { remote, work } = repos()
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const proposal = await propose(work, { title: 'Moved push', body: '', branch: 'feat/moved' })
    git(work, 'config', 'remote.origin.pushurl', 'git@example.test:owner/other.git')
    expect(await publish(work, proposal, fakePrs().port)).toMatchObject({
      status: 'refused',
      reason: 'plan-changed',
    })
    expect(remoteTip(remote, 'feat/moved')).toBeUndefined()
  })

  it('refuses when the pull request gh reports is not in the approved repository', async () => {
    const { remote, work } = repos()
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const prs = fakePrs()
    prs.state.urlRepo = 'example.test/other/repo'
    const proposal = await propose(work, { title: 'Elsewhere', body: '', branch: 'feat/elsewhere' })
    expect(await publish(work, proposal, prs.port)).toMatchObject({
      status: 'refused',
      reason: 'pr-failed',
      branch: 'feat/elsewhere',
      commit: remoteTip(remote, 'feat/elsewhere'),
    })
    expect(prs.prs).toMatchObject([{ repo: REPO, head: 'feat/elsewhere' }])
  })

  /** A clean repository at `path` with one commit. */
  const repoAt = (path: string) => {
    execFileSync('git', ['init', '-q', '-b', 'main', path])
    git(path, 'config', 'user.name', 'Test Owner')
    git(path, 'config', 'user.email', 'owner@example.test')
    writeFileSync(join(path, 'f'), 'one\n')
    git(path, 'add', '-A')
    git(path, 'commit', '-q', '-m', 'one')
  }

  /** repos() whose HEAD also tracks a populated submodule at `sub`. */
  function reposWithSubmodule() {
    const repo = repos()
    repoAt(join(repo.work, 'sub'))
    writeFileSync(
      join(repo.work, '.gitmodules'),
      '[submodule "sub"]\n\tpath = sub\n\turl = git@elsewhere.test:x/y.git\n',
    )
    git(repo.work, 'add', 'sub', '.gitmodules')
    git(repo.work, 'commit', '-q', '-m', 'sub')
    return repo
  }

  // The forged proposal is what publish itself stages: it never stages the parent's submodules.
  it.each([
    [
      'a nested repository the worker created',
      (work: string) => repoAt(join(work, 'nested')),
      'nested',
      ['nested', 'x.txt'],
    ],
    [
      'a submodule pointer the worker moved',
      (work: string) => {
        writeFileSync(join(work, 'sub', 'f'), 'two\n')
        git(join(work, 'sub'), 'commit', '-q', '-am', 'two')
      },
      'sub',
      ['x.txt'],
    ],
  ])('refuses %s, at plan time and at publish time', async (_, change, path, staged) => {
    const { dir, remote, work } = reposWithSubmodule()
    change(work)
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const p = plan({ title: 'Nested', body: '', branch: 'feat/nested' })
    expect(await preparePublish({ root: work, plan: p })).toEqual({
      status: 'refused',
      reason: 'submodule-changes',
      detail: expect.any(String),
      files: [path],
    })
    const forged = {
      title: 'Nested',
      body: '',
      branch: 'feat/nested',
      base: 'main',
      remote: ORIGIN,
      repo: REPO,
      tree: worktreeTree(dir, work, ['sub']),
      files: staged,
    }
    expect(await publish(work, forged, fakePrs().port)).toMatchObject({
      status: 'refused',
      reason: 'submodule-changes',
      files: [path],
    })
    expect(remoteTip(remote, 'feat/nested')).toBeUndefined()
  })

  it('runs nothing an unchanged submodule configures, in plan, publish, push or the git gh starts', async () => {
    const { dir, work } = reposWithSubmodule()
    const marker = join(dir, 'ran')
    const evil = join(dir, 'evil')
    writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`, { mode: 0o755 })
    const hooks = join(dir, 'evil-hooks')
    mkdirSync(hooks)
    for (const hook of [
      'pre-commit',
      'pre-push',
      'post-checkout',
      'post-index-change',
      'reference-transaction',
    ])
      writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> '${marker}'\n`, { mode: 0o755 })
    const sub = join(work, 'sub')
    // The owner's config pushes submodules on demand. The submodule's commit is on no remote it knows
    // of, so an on-demand push would start a push inside it.
    git(work, 'config', 'push.recurseSubmodules', 'on-demand')
    const elsewhere = git(sub, 'commit-tree', 'HEAD^{tree}', '-m', 'elsewhere')
    git(sub, 'update-ref', 'refs/remotes/origin/main', elsewhere)
    for (const [key, value] of [
      ['core.fsmonitor', evil],
      ['core.hooksPath', hooks],
      ['filter.x.clean', evil],
      ['filter.x.required', 'true'],
      ['core.sshCommand', evil],
      ['remote.origin.url', 'git@elsewhere.test:x/y.git'],
      ['branch.main.remote', 'origin'],
      ['branch.main.merge', 'refs/heads/main'],
    ])
      git(sub, 'config', key, value)
    writeFileSync(join(sub, '.gitattributes'), '* filter=x\n')
    writeFileSync(join(work, '.gitattributes'), '* filter=x\n')
    // Same content, new mtime: a status inside the submodule has to hash it, through the clean filter.
    execFileSync('touch', ['-t', '203001010000', join(sub, 'f')])
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const gh = join(dir, 'fake-gh')
    writeFileSync(
      gh,
      [
        '#!/bin/sh',
        'git status --porcelain >/dev/null 2>&1',
        'if [ "$1 $2" = "pr list" ]; then echo "[]"; exit 0; fi',
        'echo https://example.test/owner/repo/pull/5',
      ].join('\n'),
      { mode: 0o755 },
    )
    expect(existsSync(marker)).toBe(false)
    const proposal = await propose(work, { title: 'Armed', body: '', branch: 'feat/armed' })
    expect(existsSync(marker)).toBe(false)
    expect(proposal.files).toEqual(['.gitattributes', 'x.txt'])
    expect(await publish(work, proposal, ghPullRequests({ command: gh }))).toMatchObject({
      status: 'published',
    })
    expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('')
  })

  it('refuses outside a repository root, and without an origin remote', async () => {
    const { dir, work } = repos()
    const p = plan({ title: 'T', body: '' })
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    expect(await preparePublish({ root: plain, plan: p })).toMatchObject({ reason: 'not-a-git-repo' })
    mkdirSync(join(work, 'sub'))
    writeFileSync(join(work, 'sub', 'f'), 'f\n')
    expect(await preparePublish({ root: join(work, 'sub'), plan: p })).toMatchObject({
      reason: 'not-a-git-repo',
    })
    git(work, 'remote', 'remove', 'origin')
    expect(await preparePublish({ root: work, plan: p })).toMatchObject({ reason: 'no-remote' })
  })

  it('refuses a branch that already exists with other content', async () => {
    const { work } = repos()
    git(work, 'branch', 'feat/taken')
    writeFileSync(join(work, 'new.txt'), 'n\n')
    const proposal = await propose(work, { title: 'T', body: '', branch: 'feat/taken' })
    expect(await publish(work, proposal, fakePrs().port)).toMatchObject({
      status: 'refused',
      reason: 'branch-exists-diverged',
    })
  })

  it('after a failed push, a retry reuses the same commit and opens one PR', async () => {
    const { remote, work } = repos()
    writeFileSync(join(work, 'README.md'), 'changed\n')
    const prs = fakePrs()
    const proposal = await propose(work, { title: 'Retry push', body: '' })
    chmodTree(join(remote, 'objects'), 0o555)

    const first = await publish(work, proposal, prs.port)
    expect(first).toMatchObject({ status: 'refused', reason: 'push-rejected' })
    expect(remoteTip(remote, proposal.branch)).toBeUndefined()
    const localCommit = git(work, 'rev-parse', `refs/heads/${proposal.branch}`)

    chmodTree(join(remote, 'objects'), 0o755)
    const second = await publish(work, proposal, prs.port)
    expect(second).toMatchObject({ status: 'published', commit: localCommit, branch: proposal.branch })
    expect(remoteTip(remote, proposal.branch)).toBe(localCommit)
    expect(prs.prs).toHaveLength(1)
  })

  it('after the PR step fails, a retry finds the PR instead of opening a second, and a later retry changes nothing', async () => {
    const { remote, work } = repos()
    writeFileSync(join(work, 'README.md'), 'changed\n')
    const prs = fakePrs()
    prs.state.failCreate = true
    const proposal = await propose(work, { title: 'Retry PR', body: '' })

    const first = await publish(work, proposal, prs.port)
    expect(first).toMatchObject({
      status: 'refused',
      reason: 'pr-failed',
      branch: proposal.branch,
      commit: remoteTip(remote, proposal.branch),
    })
    const second = await publish(work, proposal, prs.port)
    const third = await publish(work, proposal, prs.port)
    expect(second).toMatchObject({ status: 'published', prUrl: prs.prs[0]?.url })
    expect(third).toEqual(second)
    expect(prs.prs).toHaveLength(1)
    expect(prs.state.creates).toBe(1)
  })

  it('runs no hook from the workspace, in its own git or in the git gh starts', async () => {
    const { dir, work } = repos()
    const sentinel = join(dir, 'hook-ran')
    mkdirSync(join(work, '.husky'))
    for (const hook of ['pre-push', 'pre-commit'])
      writeFileSync(join(work, '.husky', hook), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 })
    git(work, 'config', 'core.hooksPath', '.husky')
    const gh = join(dir, 'fake-gh')
    writeFileSync(
      gh,
      [
        '#!/bin/sh',
        'if [ "$1 $2" = "pr list" ]; then echo "[]"; exit 0; fi',
        `git -C '${work}' hook run --ignore-missing pre-commit`,
        'echo https://example.test/owner/repo/pull/3',
      ].join('\n'),
      { mode: 0o755 },
    )
    const proposal = await propose(work, { title: 'Hooks', body: '' })
    const result = await publish(work, proposal, ghPullRequests({ command: gh }))
    expect(result).toMatchObject({ status: 'published' })
    expect(existsSync(sentinel)).toBe(false)
  })

  it('passes hostile title and body to git and gh as literal data', async () => {
    const { dir, remote, work } = repos()
    const sentinel = join(work, 'pwned')
    const log = join(dir, 'gh-argv')
    const gh = join(dir, 'fake-gh')
    writeFileSync(
      gh,
      [
        '#!/bin/sh',
        `pwd -P >> '${log}.cwd'`,
        `if [ "$1 $2" = "pr list" ]; then for a in "$@"; do printf '%s\\0' "$a"; done > '${log}.list'; echo "[]"; exit 0; fi`,
        `for a in "$@"; do printf '%s\\0' "$a"; done > '${log}'`,
        `cat > '${log}.stdin'`,
        'echo https://example.test/owner/repo/pull/9',
      ].join('\n'),
      { mode: 0o755 },
    )
    const title = '--upload-pack=touch pwned $(touch pwned) `touch pwned`; rm -rf ~'
    const body = '--base main\n$(touch pwned)\n--force'
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const proposal = await propose(work, { title, body, branch: 'feat/hostile' })

    const result = await publish(work, proposal, ghPullRequests({ command: gh }))

    expect(result).toMatchObject({ status: 'published', prUrl: 'https://example.test/owner/repo/pull/9' })
    expect(existsSync(sentinel)).toBe(false)
    expect(readFileSync(`${log}.list`, 'utf8').split('\0').slice(0, -1)).toEqual([
      'pr',
      'list',
      `--repo=${REPO}`,
      '--head=feat/hostile',
      '--state=open',
      '--json=url,headRefOid,headRepositoryOwner,isCrossRepository',
      '--limit=20',
    ])
    expect(readFileSync(log, 'utf8').split('\0').slice(0, -1)).toEqual([
      'pr',
      'create',
      `--repo=${REPO}`,
      '--head=owner:feat/hostile',
      `--title=${title}`,
      '--body-file=-',
      '--base=main',
    ])
    expect(readFileSync(`${log}.stdin`, 'utf8')).toBe(body)
    const work_ = realpathSync(work)
    for (const cwd of readFileSync(`${log}.cwd`, 'utf8').trim().split('\n'))
      expect(cwd === work_ || cwd.startsWith(`${work_}/`)).toBe(false)
    if (result.status === 'published')
      expect(git(work, 'log', '-1', '--format=%B', result.commit)).toBe(`${title}\n\n${body}`)
    expect(remoteTip(remote, 'feat/hostile')).toBeDefined()
  })
})

describe('gh pull request lookup', () => {
  const commit = 'c'.repeat(40)
  const own = {
    url: 'https://example.test/o/r/pull/1',
    headRefOid: commit,
    headRepositoryOwner: { login: 'o' },
    isCrossRepository: false,
  }
  const repo = 'example.test/o/r'

  it('accepts only an open PR from this repository whose head is the pushed commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-gh-'))
    temps.push(dir)
    const gh = join(dir, 'fake-gh-list')
    const find = (listing: unknown[]) => {
      writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(listing)}\nJSON\n`, { mode: 0o755 })
      return ghPullRequests({ command: gh }).find({ repo, head: 'feat/x', commit })
    }
    expect(await find([own])).toBe(own.url)
    expect(await find([{ ...own, isCrossRepository: true }])).toBeUndefined()
    expect(await find([{ ...own, headRefOid: 'd'.repeat(40) }])).toBeUndefined()
    expect(await find([{ ...own, url: 'https://example.test/other/r/pull/1' }])).toBeUndefined()
    expect(await find([{ ...own, headRepositoryOwner: { login: 'someone' } }])).toBeUndefined()
    expect(await find([{ ...own, headRepositoryOwner: { login: 'O' } }])).toBe(own.url)
    expect(await find([{ ...own, url: 'https://example.test/o/r/pull/1/files' }])).toBeUndefined()
    expect(
      await find([
        { ...own, url: 'https://example.test/fork/r/pull/2', isCrossRepository: true },
        { ...own, url: 'https://example.test/o/r/pull/3' },
      ]),
    ).toBe('https://example.test/o/r/pull/3')
  })

  it('refuses a gh answer too long to read whole instead of taking a URL from its first part', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-gh-'))
    temps.push(dir)
    const gh = join(dir, 'fake-gh-create')
    writeFileSync(
      gh,
      [
        '#!/bin/sh',
        'echo https://example.test/o/r/pull/1',
        "head -c 1200000 /dev/zero | tr '\\0' x",
        'echo',
        'echo https://example.test/o/r/pull/2',
      ].join('\n'),
      { mode: 0o755 },
    )
    await expect(
      ghPullRequests({ command: gh }).create({ repo, head: 'feat/x', title: 'T', body: '' }),
    ).rejects.toThrow(/output exceeded/)
  })

  it('refuses a gh answer that is not UTF-8 text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-gh-'))
    temps.push(dir)
    const gh = join(dir, 'fake-gh-create')
    writeFileSync(gh, ['#!/bin/sh', "printf '\\377\\n'", 'echo https://example.test/o/r/pull/1'].join('\n'), {
      mode: 0o755,
    })
    await expect(
      ghPullRequests({ command: gh }).create({ repo, head: 'feat/x', title: 'T', body: '' }),
    ).rejects.toThrow(/not UTF-8/)
  })
})

describe('publish tool definitions', () => {
  it('declares publish as outward, open-world, always asking a person, and publish_plan as read-only', () => {
    const tool = publishTool({ prs: fakePrs().port })
    expect(tool.name).toBe('publish')
    expect(tool.meta).toBe(PUBLISH_META)
    expect(tool.meta).toMatchObject({
      outward: true,
      isOpenWorld: true,
      requiresApproval: 'always',
      isReadOnly: false,
    })
    expect(checkToolDef(tool)).toEqual({ ok: true })
    const planTool = publishPlanTool()
    expect(planTool.name).toBe('publish_plan')
    expect(planTool.meta).toBe(PUBLISH_PLAN_META)
    expect(planTool.meta).toMatchObject({ isReadOnly: true, isOpenWorld: false })
    expect(checkToolDef(planTool)).toEqual({ ok: true })
  })

  it('plans through the tool, refuses publish without a person’s approval, and publishes with it', async () => {
    const { remote, work } = repos()
    writeFileSync(join(work, 'x.txt'), 'x\n')
    const ctx = { session: { workspaceRoot: work }, signal: new AbortController().signal, log: { info() {} } }
    const planned = await publishPlanTool().execute({ title: 'T', body: '', branch: 'feat/t' }, ctx as never)
    const proposal = (planned.structured as { proposal: Record<string, unknown> }).proposal
    expect(proposal).toMatchObject({ branch: 'feat/t', files: ['x.txt'] })

    const tool = publishTool({ prs: fakePrs().port })
    const refused = await tool.execute(proposal as never, ctx as never)
    expect(refused).toMatchObject({
      isError: true,
      structured: { status: 'refused', reason: 'no-human-approval' },
    })
    expect(remoteTip(remote, 'feat/t')).toBeUndefined()
    const answeredBy = { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    const approved = await tool.execute(
      proposal as never,
      {
        ...ctx,
        approval: { requestId: 'r1', subjectRevision: 'a'.repeat(64), answeredBy },
      } as never,
    )
    expect(approved).toMatchObject({ structured: { status: 'published', branch: 'feat/t' } })
    expect(approved.isError).toBeUndefined()
    expect(remoteTip(remote, 'feat/t')).toBeDefined()
  })
})
