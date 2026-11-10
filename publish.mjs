import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PUBLISH_TOOL_NAME = 'publish'
export const PUBLISH_PLAN_TOOL_NAME = 'publish_plan'
const REMOTE = 'origin'

/**
 * @typedef {{ title: string, body: string, branch?: string, base?: string }} PlanArgs
 * @typedef {{ remote: 'origin', branch: string, base?: string, title: string, body: string, commitMessage: string }} PublishPlan
 * @typedef {{ title: string, body: string, branch: string, base?: string, remote: string, repo: string, tree: string, files: string[] }} Proposal
 *   What `publish_plan` returns and what `publish` takes: the approval card shows every field, and
 *   `publish` refuses unless the workspace still stages to exactly this tree at this remote.
 *   `repo` is `host/owner/name`, read from the remote: the only repository the pull request may open in.
 * @typedef {'invalid-input' | 'protected-branch' | 'no-human-approval' | 'not-a-git-repo' | 'no-remote'
 *   | 'secret-files' | 'ignored-files' | 'submodule-changes' | 'nothing-to-commit' | 'plan-changed' | 'branch-exists-diverged' | 'push-rejected'
 *   | 'pr-failed' | 'git-failed'} RefusalReason
 * @typedef {{ status: 'planned', proposal: Proposal }} Planned
 * @typedef {{ status: 'published', prUrl: string, branch: string, commit: string, remote: string, files: string[] }} Published
 * @typedef {{ status: 'refused', reason: RefusalReason, detail: string, files?: string[], branch?: string, commit?: string }} Refused
 * @typedef {Published | Refused} PublishResult
 * @typedef {{ repo: string, head: string, base?: string, title: string, body: string, signal?: AbortSignal }} PrRequest
 * @typedef {{
 *   find(input: { repo: string, head: string, commit: string, signal?: AbortSignal }): Promise<string | undefined>,
 *   create(input: PrRequest): Promise<string>,
 * }} PullRequestPort
 *   `find` answers only with an open PR in `repo` whose head is `repo`'s own branch at exactly `commit`.
 */

const Kind = Symbol.for('TypeBox.Kind')
const str = (/** @type {Record<string, unknown>} */ extra) => ({ [Kind]: 'String', type: 'string', ...extra })
// No leading '-', no '..', '//', '@{' or '.lock' component, no trailing '/' or '.': a strict subset of
// git's ref rules, so a branch can never be read as an option or a revision expression.
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,99}(?<![./])$/
const BRANCH_SCHEMA = { pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$' }
// biome-ignore lint/suspicious/noControlCharactersInRegex: one line of text; control characters are what it refuses.
const ONE_LINE = /^[^\u0000-\u001f\u007f]+$/
const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const REPO =
  /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]*[A-Za-z0-9_-]\/[A-Za-z0-9_.-]*[A-Za-z0-9_-]$/
// The push URLs that name exactly one repository on a forge: `scheme://[user[:password]@]host[:port]/
// owner/name` or scp-style `[user@]host:owner/name`, each with an optional `.git`. Every part has a
// strict character set, so no `?`, `#`, `%`, backslash, space or control character gets through for
// git, gh and this parse to read differently.
const URL_REMOTE =
  /^(?:https?|ssh|git\+ssh|ssh\+git):\/\/(?:([A-Za-z0-9._~-]+)(?::([A-Za-z0-9._~-]+))?@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::\d{1,5})?\/([A-Za-z0-9_.-]*[A-Za-z0-9_-])\/([A-Za-z0-9_.-]*?[A-Za-z0-9_-])(?:\.git)?\/?$/
const SCP_REMOTE =
  /^(?:[A-Za-z0-9._~-]+@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):([A-Za-z0-9_.-]*[A-Za-z0-9_-])\/([A-Za-z0-9_.-]*?[A-Za-z0-9_-])(?:\.git)?\/?$/
const PROTECTED = /^(?:main|master|develop|trunk|head|release(?:\/.*)?)$/i
const MAX_FILES = 2000

const titleSchema = str({
  minLength: 1,
  maxLength: 200,
  description: 'PR title and commit subject, one line.',
})
const bodySchema = str({ maxLength: 20000, description: 'PR body and commit message body.' })

export const PUBLISH_PLAN_PARAMETERS = {
  [Kind]: 'Object',
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: {
    title: titleSchema,
    body: bodySchema,
    branch: str({ ...BRANCH_SCHEMA, description: 'New branch. Omitted: companion/<title slug>-<hash>.' }),
    base: str({ ...BRANCH_SCHEMA, description: "PR target branch. Omitted: origin's default branch." }),
  },
}

export const PUBLISH_PARAMETERS = {
  [Kind]: 'Object',
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body', 'branch', 'remote', 'repo', 'tree', 'files'],
  properties: {
    title: titleSchema,
    body: bodySchema,
    branch: str({ ...BRANCH_SCHEMA, description: 'Branch from publish_plan.' }),
    base: str({ ...BRANCH_SCHEMA, description: 'Base from publish_plan, when it gave one.' }),
    remote: str({ minLength: 1, maxLength: 2048, description: 'Remote from publish_plan.' }),
    repo: str({
      minLength: 1,
      maxLength: 512,
      description: 'Repository (host/owner/name) from publish_plan.',
    }),
    tree: str({ pattern: '^[0-9a-f]{40}([0-9a-f]{24})?$', description: 'Tree from publish_plan.' }),
    files: {
      [Kind]: 'Array',
      type: 'array',
      minItems: 1,
      maxItems: MAX_FILES,
      items: str({ minLength: 1, maxLength: 4096 }),
      description: 'Changed files from publish_plan.',
    },
  },
}

export const PUBLISH_PLAN_META = Object.freeze({
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: /** @type {const} */ ('safe'),
  requiresApproval: /** @type {const} */ ('never'),
})

export const PUBLISH_META = Object.freeze({
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: true,
  replay: /** @type {const} */ ('never'),
  requiresApproval: /** @type {const} */ ('always'),
  outward: true,
  presentation: Object.freeze({
    title: 'Publish a branch and pull request',
    description:
      'Commits exactly the listed files (the tree shown) onto the new branch shown, pushes it to the remote shown and opens a pull request in the repository shown, with the title and body shown. If the workspace no longer matches, nothing is pushed.',
  }),
})

/**
 * Validates the plan arguments and derives every destination field from them.
 * @param {Record<string, unknown>} args
 * @returns {{ ok: true, plan: PublishPlan } | { ok: false, reason: 'invalid-input' | 'protected-branch', detail: string }}
 */
export function planPublish(args) {
  const { title, body, branch, base } = args
  if (typeof title !== 'string' || title.length > 200 || !ONE_LINE.test(title))
    return invalid('title must be one line of 1 to 200 characters')
  if (typeof body !== 'string' || body.length > 20000 || body.includes('\u0000'))
    return invalid('body must be text up to 20000 characters')
  for (const [name, value] of /** @type {const} */ ([
    ['branch', branch],
    ['base', base],
  ]))
    if (value !== undefined && (typeof value !== 'string' || !BRANCH.test(value)))
      return invalid(`${name} must be a plain branch name`)
  const target = typeof branch === 'string' ? branch : derivedBranch(title)
  if (PROTECTED.test(target) || (typeof base === 'string' && target.toLowerCase() === base.toLowerCase()))
    return { ok: false, reason: 'protected-branch', detail: `refusing to push to ${target}` }
  return {
    ok: true,
    plan: {
      remote: REMOTE,
      branch: target,
      ...(typeof base === 'string' ? { base } : {}),
      title,
      body,
      commitMessage: body ? `${title}\n\n${body}` : title,
    },
  }
}

/**
 * Validates the arguments a person approved for `publish`.
 * @param {Record<string, unknown>} args
 * @returns {{ ok: true, proposal: Proposal, plan: PublishPlan } | { ok: false, reason: 'invalid-input' | 'protected-branch', detail: string }}
 */
export function parseProposal(args) {
  const { remote, repo, tree, files, branch } = args
  if (typeof branch !== 'string') return invalid('branch is required')
  const planned = planPublish(args)
  if (!planned.ok) return planned
  if (typeof remote !== 'string' || remote.length > 2048 || !ONE_LINE.test(remote))
    return invalid('remote must be the remote publish_plan returned')
  if (typeof repo !== 'string' || !REPO.test(repo))
    return invalid('repo must be the repo publish_plan returned')
  if (typeof tree !== 'string' || !TREE.test(tree))
    return invalid('tree must be the tree publish_plan returned')
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > MAX_FILES ||
    !files.every((file) => typeof file === 'string' && file.length > 0 && !file.includes('\u0000'))
  )
    return invalid('files must be the files publish_plan returned')
  const { title, body, base } = planned.plan
  return {
    ok: true,
    plan: planned.plan,
    proposal: { title, body, branch, ...(base ? { base } : {}), remote, repo, tree, files: [...files] },
  }
}

/** @param {string} detail */
const invalid = (detail) => ({
  ok: /** @type {const} */ (false),
  reason: /** @type {const} */ ('invalid-input'),
  detail,
})

/** @param {string} title */
function derivedBranch(title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  const hash = createHash('sha256').update(title).digest('hex')
  return slug ? `companion/${slug}-${hash.slice(0, 6)}` : `companion/${hash.slice(0, 8)}`
}

const SECRET_NAME =
  /^(?:\.env.*|id_.*|credentials.*|[._]netrc|\.npmrc|\.pypirc|\.git-credentials|.*\.(?:pem|key|p12|pfx|p8|jks|keystore|bks|ppk))$/i
const SECRET_DIR =
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.config\/(?:gcloud|gh)|\.agh\/secrets)\//i

/** @param {string} path */
const secretLooking = (path) =>
  SECRET_NAME.test(path.slice(path.lastIndexOf('/') + 1)) || SECRET_DIR.test(path)

/** @type {(reason: RefusalReason, detail: string, extra?: Partial<Refused>) => Refused} */
const refuse = (reason, detail, extra = {}) => ({ status: 'refused', reason, detail, ...extra })

/** @param {string} root @param {AbortSignal | undefined} signal */
const gitIn =
  (root, signal) =>
  (/** @type {string[]} */ args, /** @type {RunOptions} */ options = {}) =>
    run('git', args, { cwd: root, signal, ...options })

/**
 * The repository facts both tools need, or why there is no repository to publish from.
 * @param {ReturnType<typeof gitIn>} git
 * @param {string} root
 */
async function inspect(git, root) {
  let workspace
  try {
    workspace = realpathSync(root)
  } catch {
    return refuse('not-a-git-repo', 'the workspace does not exist')
  }
  const top = await git(['rev-parse', '--show-toplevel'])
  if (top.code !== 0 || realpathSync(top.stdout.trim()) !== workspace)
    return refuse('not-a-git-repo', 'the workspace is not the root of a git repository')
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  if (head.code !== 0) return refuse('not-a-git-repo', 'the repository has no commits yet')
  // The push URL, after pushurl and pushInsteadOf: where git will actually send the branch.
  const urls = await git(['remote', 'get-url', '--push', '--all', REMOTE])
  if (urls.code !== 0) return refuse('no-remote', `the repository has no ${REMOTE} remote`)
  const pushUrls = urls.stdout.split('\n').filter(Boolean)
  if (pushUrls.length !== 1)
    return refuse('no-remote', `${REMOTE} pushes to ${pushUrls.length} URLs; publish needs exactly one`)
  const parsed = parseRemote(pushUrls[0] ?? '')
  if (!parsed) return refuse('no-remote', `${REMOTE} pushes to an address that does not name one repository`)
  const current = await git(['symbolic-ref', '--short', '-q', 'HEAD'])
  return { parent: head.stdout.trim(), ...parsed, current: current.stdout.trim() }
}

/**
 * Reads what `publish` would commit, without writing to the repository: the throwaway index and its
 * new objects live in a temporary directory that borrows the repository's objects read-only.
 * @param {{ root: string, plan: PublishPlan, signal?: AbortSignal }} input
 * @returns {Promise<Planned | Refused>}
 */
export async function preparePublish({ root, plan, signal }) {
  const git = gitIn(root, signal)
  const repo = await inspect(git, root)
  if ('status' in repo) return repo
  const found = plan.base ? { name: plan.base } : await defaultBase(git)
  if ('error' in found) return refuse('git-failed', found.error)
  const base = found.name
  if (base !== undefined && base.toLowerCase() === plan.branch.toLowerCase())
    return refuse('protected-branch', `refusing to push to the base branch ${base}`)
  if (repo.current === plan.branch)
    return refuse('branch-exists-diverged', `${plan.branch} is checked out in the workspace`)
  const objects = await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])
  if (objects.code !== 0) return refuse('git-failed', `cannot locate objects: ${tail(objects.stderr)}`)
  const staged = await stageWorkspace(git, repo.parent, objects.stdout.trim())
  if ('error' in staged) return refuse('git-failed', staged.error)
  const secrets = staged.files.filter(secretLooking)
  if (secrets.length) return refuseSecrets(secrets)
  if (staged.ignored.length) return refuseIgnored(staged.ignored)
  if (staged.gitlinks.length) return refuseGitlinks(staged.gitlinks)
  if (staged.tree === staged.parentTree)
    return refuse('nothing-to-commit', 'the workspace has no changes against HEAD')
  return {
    status: 'planned',
    proposal: {
      title: plan.title,
      body: plan.body,
      branch: plan.branch,
      ...(base ? { base } : {}),
      remote: repo.remote,
      repo: repo.repo,
      tree: staged.tree,
      files: staged.files,
    },
  }
}

/** @param {string[]} files */
const refuseSecrets = (files) =>
  refuse('secret-files', 'secret-looking files are in the changes; remove or ignore them', { files })

/** @param {string[]} files */
const refuseGitlinks = (files) =>
  refuse(
    'submodule-changes',
    'nested repositories or submodule pointers are in the changes; publish does not carry them',
    { files },
  )

/** @param {string[]} files */
const refuseIgnored = (files) =>
  refuse(
    'ignored-files',
    'files that the ignore rules at HEAD keep out of the repository are in the changes; remove them',
    { files },
  )

/**
 * Commit, push and open the approved PR. It first re-stages the workspace and refuses unless it is
 * exactly the approved tree at the approved remote. Each later step reads where the refs already are,
 * so a repeat call after a partial failure reuses the commit, branch and PR it made before.
 * @param {{ root: string, proposal: Proposal, plan: PublishPlan, prs: PullRequestPort, signal?: AbortSignal }} input
 * @returns {Promise<PublishResult>}
 */
export async function runPublish({ root, proposal, plan, prs, signal }) {
  const git = gitIn(root, signal)
  const repo = await inspect(git, root)
  if ('status' in repo) return repo
  const { parent, remote } = repo
  if (repo.current === plan.branch)
    return refuse('branch-exists-diverged', `${plan.branch} is checked out in the workspace`)
  if (remote !== proposal.remote)
    return refuse('plan-changed', `origin is now ${remote}, not the approved ${proposal.remote}`)
  if (repo.repo !== proposal.repo)
    return refuse('plan-changed', `origin names ${repo.repo}, not the approved ${proposal.repo}`)

  const staged = await stageWorkspace(git, parent)
  if ('error' in staged) return refuse('git-failed', staged.error)
  if (staged.tree !== proposal.tree || staged.files.join('\0') !== [...proposal.files].sort().join('\0'))
    return refuse('plan-changed', 'the workspace changed after approval; plan and approve again', {
      files: staged.files,
    })
  const secrets = staged.files.filter(secretLooking)
  if (secrets.length) return refuseSecrets(secrets)
  if (staged.ignored.length) return refuseIgnored(staged.ignored)
  if (staged.gitlinks.length) return refuseGitlinks(staged.gitlinks)

  const local = await git(['rev-parse', '--verify', '-q', `refs/heads/${plan.branch}`])
  const listed = await git(['ls-remote', '--heads', REMOTE, `refs/heads/${plan.branch}`], {
    timeoutMs: NETWORK_MS,
  })
  if (listed.code !== 0) return refuse('push-rejected', `could not read ${remote}: ${tail(listed.stderr)}`)
  const pushedTip = listed.stdout.split(/\s/)[0] || undefined

  let commit
  if (local.code === 0) {
    commit = local.stdout.trim()
    const reused = await git(['rev-parse', `${commit}^{tree}`, `${commit}^`])
    if (reused.stdout.trim() !== `${staged.tree}\n${parent}`)
      return refuse('branch-exists-diverged', `local branch ${plan.branch} already holds other commits`)
  } else {
    if (pushedTip) return refuse('branch-exists-diverged', `${remote} already has a branch ${plan.branch}`)
    if (staged.tree === staged.parentTree)
      return refuse('nothing-to-commit', 'the workspace has no changes against HEAD')
    const made = await git(['commit-tree', staged.tree, '-p', parent, '-F', '-'], {
      input: plan.commitMessage,
    })
    if (made.code !== 0) return refuse('git-failed', `commit failed: ${tail(made.stderr)}`)
    commit = made.stdout.trim()
    // An empty old value makes this create-only: a branch that appeared meanwhile is never moved.
    const created = await git(['update-ref', `refs/heads/${plan.branch}`, commit, ''])
    if (created.code !== 0)
      return refuse('branch-exists-diverged', `could not create ${plan.branch}: ${tail(created.stderr)}`)
  }

  if (pushedTip !== commit) {
    // Recursing would run git inside submodules, whose config the worker writes and our overrides
    // do not cover (remote URLs, core.sshCommand).
    const pushed = await git(
      ['push', '--porcelain', '--recurse-submodules=no', REMOTE, `${commit}:refs/heads/${plan.branch}`],
      { timeoutMs: NETWORK_MS },
    )
    if (pushed.code !== 0)
      return refuse('push-rejected', tail(pushed.stderr || pushed.stdout), { branch: plan.branch, commit })
  }

  let prUrl
  try {
    prUrl =
      (await prs.find({ repo: repo.repo, head: plan.branch, commit, signal })) ??
      (await prs.create({
        repo: repo.repo,
        head: plan.branch,
        ...(proposal.base ? { base: proposal.base } : {}),
        title: plan.title,
        body: plan.body,
        signal,
      }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return refuse('pr-failed', `the branch is pushed; opening the pull request failed: ${tail(message)}`, {
      branch: plan.branch,
      commit,
    })
  }
  if (!isPullOf(prUrl, repo.repo))
    return refuse(
      'pr-failed',
      `the branch is pushed; gh answered ${tail(prUrl)}, not a pull request of ${repo.repo}`,
      {
        branch: plan.branch,
        commit,
      },
    )
  return { status: 'published', prUrl, branch: plan.branch, commit, remote, files: staged.files }
}

/**
 * origin's default branch, none when origin/HEAD is unset, or why it could not be read.
 * @param {ReturnType<typeof gitIn>} git
 * @returns {Promise<{ name?: string } | { error: string }>}
 */
async function defaultBase(git) {
  const ref = await git(['symbolic-ref', '--short', '-q', `refs/remotes/${REMOTE}/HEAD`])
  if (ref.code === 1) return {}
  if (ref.code !== 0) return { error: `cannot read ${REMOTE}/HEAD: ${tail(ref.stderr)}` }
  const name = ref.stdout.trim()
  return name.startsWith(`${REMOTE}/`) ? { name: name.slice(REMOTE.length + 1) } : {}
}

/**
 * Builds the workspace tree in a throwaway index, so the owner's index, HEAD and working tree stay as
 * they were, and no workspace path ever becomes a command argument. With `borrowObjects`, new objects
 * go to the temporary directory too and the repository is only read.
 * @param {ReturnType<typeof gitIn>} git
 * @param {string} parent
 * @param {string} [borrowObjects]
 */
async function stageWorkspace(git, parent, borrowObjects) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-publish-index-'))
  /** @type {Record<string, string>} */
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  if (borrowObjects) {
    mkdirSync(join(dir, 'objects'))
    env.GIT_OBJECT_DIRECTORY = join(dir, 'objects')
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = borrowObjects
  }
  try {
    const read = await git(['read-tree', parent], { env })
    if (read.code !== 0) return { error: `read-tree failed: ${tail(read.stderr)}` }
    // `add -A` runs `git status` inside every populated submodule to see whether it is dirty, and that
    // child runs the submodule's own config (its clean filters), which the worker writes. The parent's
    // gitlinks are left out of `add` and checked by `diff-files --ignore-submodules=dirty`, which only
    // compares each submodule's HEAD.
    const linked = await git(['ls-files', '--stage', '-z'], { env, keep: isGitlinkRecord })
    if (linked.code !== 0) return { error: `ls-files failed: ${tail(linked.stderr)}` }
    const submodules = linked.stdout
      .split('\0')
      .filter(Boolean)
      .map((record) => record.slice(record.indexOf('\t') + 1))
    const add = await git(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      env,
      input: ['.', ...submodules.map((path) => `:(exclude,literal)${path}`)]
        .map((spec) => `${spec}\0`)
        .join(''),
    })
    if (add.code !== 0) return { error: `add failed: ${tail(add.stderr)}` }
    const moved = await git(['diff-files', '--raw', '--no-abbrev', '-z', '--ignore-submodules=dirty'], {
      env,
    })
    if (moved.code !== 0) return { error: `diff-files failed: ${tail(moved.stderr)}` }
    const tree = await git(['write-tree'], { env })
    const parentTree = await git(['rev-parse', `${parent}^{tree}`])
    const diff = await git(['diff-index', '--cached', '--raw', '--no-renames', '--no-abbrev', '-z', parent], {
      env,
    })
    if (tree.code !== 0 || parentTree.code !== 0 || diff.code !== 0)
      return { error: `staging failed: ${tail(tree.stderr + parentTree.stderr + diff.stderr)}` }
    const changed = rawEntries(diff.stdout)
    const files = changed.map((entry) => entry.path).sort()
    const gitlinks = [
      ...new Set(
        [...changed, ...rawEntries(moved.stdout)].filter((entry) => entry.gitlink).map((entry) => entry.path),
      ),
    ].sort()
    const ignored = await ignoredAtParent(git, parent, dir, files)
    if ('error' in ignored) return ignored
    return {
      tree: tree.stdout.trim(),
      parentTree: parentTree.stdout.trim(),
      files,
      ignored: ignored.paths,
      gitlinks,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** @param {Buffer} record an `ls-files --stage -z` record */
const isGitlinkRecord = (record) => record.subarray(0, 7).toString('latin1') === '160000 '

/**
 * Parses `--raw -z` diff output, which alternates `:<old mode> <new mode> <old> <new> <status>` and
 * the path.
 * @param {string} text
 */
function rawEntries(text) {
  const fields = text.split('\0')
  /** @type {{ path: string, gitlink: boolean }[]} */
  const entries = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i] ?? ''
    entries.push({ path: fields[i + 1] ?? '', gitlink: /^:(?:160000 |\d+ 160000 )/.test(meta) })
  }
  return entries
}

/**
 * The changed paths that the parent commit's own `.gitignore` files would ignore. `git add -A` reads
 * the working tree's ignore files, which the worker can rewrite, so these rules come from the commit:
 * its ignore files are checked out alone into a scratch work tree and `check-ignore` asks there.
 * Paths the parent tracks are never reported, as git never ignores a tracked file.
 * @param {ReturnType<typeof gitIn>} git
 * @param {string} parent
 * @param {string} dir scratch directory to work in
 * @param {string[]} files
 * @returns {Promise<{ paths: string[] } | { error: string }>}
 */
async function ignoredAtParent(git, parent, dir, files) {
  if (!files.length) return { paths: [] }
  const gitDir = await git(['rev-parse', '--absolute-git-dir'])
  if (gitDir.code !== 0) return { error: `cannot locate the repository: ${tail(gitDir.stderr)}` }
  const tree = join(dir, 'parent-ignores')
  mkdirSync(tree)
  const env = {
    GIT_DIR: gitDir.stdout.trim(),
    GIT_WORK_TREE: tree,
    GIT_INDEX_FILE: join(dir, 'parent-index'),
  }
  const inTree = (/** @type {string[]} */ args, /** @type {string} */ input = '') =>
    git(args, { cwd: tree, env, input })
  const read = await inTree(['read-tree', parent])
  if (read.code !== 0) return { error: `read-tree failed: ${tail(read.stderr)}` }
  const listed = await inTree(['ls-files', '-z', '--', ':(glob)**/.gitignore'])
  if (listed.code !== 0) return { error: `ls-files failed: ${tail(listed.stderr)}` }
  if (listed.stdout) {
    const out = await inTree(['checkout-index', '-z', '--stdin'], listed.stdout)
    if (out.code !== 0) return { error: `checkout-index failed: ${tail(out.stderr)}` }
  }
  // A leading `./` keeps a name such as `:(top)x` from being read as pathspec magic.
  const checked = await inTree(['check-ignore', '-z', '--stdin'], files.map((file) => `./${file}\0`).join(''))
  // check-ignore exits 1 when nothing is ignored; anything but 0 or 1 is a failure.
  if (checked.code === 1) return { paths: [] }
  if (checked.code !== 0) return { error: `check-ignore failed: ${tail(checked.stderr)}` }
  return {
    paths: checked.stdout
      .split('\0')
      .filter(Boolean)
      .map((path) => (path.startsWith('./') ? path.slice(2) : path))
      .sort(),
  }
}

/**
 * Opens pull requests with the owner's own `gh` login. Title, head and base travel as single
 * `--flag=value` arguments and the body on stdin, so no text can become an option.
 * @param {{ command?: string, env?: Record<string, string> }} [options]
 * @returns {PullRequestPort}
 */
export function ghPullRequests({ command = 'gh', env } = {}) {
  /**
   * Runs gh in an empty directory: with --repo it needs no checkout, and in the workspace the git it
   * starts would also start git inside nested repositories, whose config the worker writes.
   * @param {string[]} args @param {RunOptions} options
   */
  const gh = async (args, options) => {
    const cwd = mkdtempSync(join(tmpdir(), 'companion-publish-gh-'))
    try {
      return await run(command, args, { ...options, cwd, env, timeoutMs: NETWORK_MS })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }
  return {
    async find({ repo, head, commit, signal }) {
      const listed = await gh(
        [
          'pr',
          'list',
          `--repo=${repo}`,
          `--head=${head}`,
          '--state=open',
          '--json=url,headRefOid,headRepositoryOwner,isCrossRepository',
          '--limit=20',
        ],
        { signal },
      )
      if (listed.code !== 0) throw new Error(`gh pr list failed: ${tail(listed.stderr)}`)
      const owner = repo.split('/')[1]?.toLowerCase()
      // `pr list --head` takes no `owner:branch`, so the head's owner is checked here.
      const found =
        /** @type {{ url?: unknown, headRefOid?: unknown, headRepositoryOwner?: { login?: unknown }, isCrossRepository?: unknown }[]} */ (
          JSON.parse(listed.stdout || '[]')
        ).find(
          (pr) =>
            pr.isCrossRepository === false &&
            String(pr.headRepositoryOwner?.login).toLowerCase() === owner &&
            pr.headRefOid === commit &&
            typeof pr.url === 'string' &&
            isPullOf(pr.url, repo),
        )
      return /** @type {string | undefined} */ (found?.url)
    },
    async create({ repo, head, base, title, body, signal }) {
      const owner = repo.split('/')[1]
      const args = [
        'pr',
        'create',
        `--repo=${repo}`,
        `--head=${owner}:${head}`,
        `--title=${title}`,
        '--body-file=-',
        ...(base ? [`--base=${base}`] : []),
      ]
      const made = await gh(args, { signal, input: body })
      const url = made.stdout
        .split('\n')
        .map((line) => line.trim())
        .findLast((line) => /^https:\/\/\S+$/.test(line))
      if (made.code !== 0 || !url) throw new Error(`gh pr create failed: ${tail(made.stderr || made.stdout)}`)
      return url
    },
  }
}

/**
 * @param {import('@agnes/extension-api').ToolContext} ctx
 * @param {{ status: string, reason?: string }} result
 */
function toolResult(ctx, name, result) {
  ctx.log.info(name, { status: result.status, ...(result.reason ? { reason: result.reason } : {}) })
  return {
    content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(result) }],
    structured: result,
    ...(result.status === 'refused' ? { isError: true } : {}),
  }
}

/**
 * The read-only first step: shows the worker what `publish` would send, so the worker can pass that
 * proposal to `publish` and the approval card shows it. Runs outside the sandbox for the same reason
 * as `publish`, but writes nothing to the repository and reaches no network.
 * @returns {import('@agnes/extension-api').ToolDef}
 */
export function publishPlanTool() {
  return {
    name: PUBLISH_PLAN_TOOL_NAME,
    description:
      'Prepare a publish: lists the changed files, the tree, the remote and the branch that publish would push. Call it, then call publish with its proposal unchanged.',
    parameters: /** @type {never} */ (PUBLISH_PLAN_PARAMETERS),
    meta: PUBLISH_PLAN_META,
    async execute(args, ctx) {
      const planned = planPublish(/** @type {Record<string, unknown>} */ (args))
      const result = planned.ok
        ? await preparePublish({ root: ctx.session.workspaceRoot, plan: planned.plan, signal: ctx.signal })
        : refuse(planned.reason, planned.detail)
      return toolResult(ctx, PUBLISH_PLAN_TOOL_NAME, result)
    },
  }
}

/**
 * The `publish` tool. It runs git and gh as the owner, outside the session sandbox, because the
 * sandbox hard-denies the workspace `.git`; the outward checkpoint's human approval is the gate.
 * @param {{ prs?: PullRequestPort }} [options]
 * @returns {import('@agnes/extension-api').ToolDef}
 */
export function publishTool({ prs = ghPullRequests() } = {}) {
  return {
    name: PUBLISH_TOOL_NAME,
    description:
      'Publish the proposal from publish_plan, unchanged: commit those files onto the new branch, push it to origin and open a pull request. The owner approves every call. Never pushes to main, master, develop or release branches.',
    parameters: /** @type {never} */ (PUBLISH_PARAMETERS),
    meta: PUBLISH_META,
    async execute(args, ctx) {
      /** @type {PublishResult} */
      let result
      // A host without the outward checkpoint would auto-approve under full access; no proof, no run.
      if (!ctx.approval?.answeredBy)
        result = refuse('no-human-approval', 'publish runs only on a person’s approval')
      else {
        const parsed = parseProposal(/** @type {Record<string, unknown>} */ (args))
        result = parsed.ok
          ? await runPublish({
              root: ctx.session.workspaceRoot,
              proposal: parsed.proposal,
              plan: parsed.plan,
              prs,
              signal: ctx.signal,
            })
          : refuse(parsed.reason, parsed.detail)
      }
      return toolResult(ctx, PUBLISH_TOOL_NAME, result)
    },
  }
}

// Workspace files are written by the worker session; nothing in them may run here with the owner's
// credentials. Hooks and fsmonitor are the programs git would start on its own. Set in the
// environment, the override also reaches the git that gh starts.
const GIT_SAFETY_ENV = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
}
const NETWORK_MS = 120_000
const MAX_OUTPUT = 1 << 20

/**
 * The one rule for credentials in URLs. http(s): the whole userinfo is dropped, whether a token sits
 * in the user name or the password. Every other `scheme://`: only the password is dropped, so
 * `ssh://git@host/...` reads as is and `ssh://user:secret@host/...` becomes `ssh://user@host/...`.
 * The user name ends at the first `:`, the password at the last `@` of the authority.
 * @param {string} text
 */
function withoutCredentials(text) {
  return text
    .replace(/(https?:\/\/)[^\s/]*@/gi, '$1')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:]*):[^\s/]*@/gi, '$1@')
}

/**
 * The push URL as the approval card shows it, without http(s) userinfo, and the `host/owner/name` it
 * names; undefined unless it names exactly one repository on a forge.
 * @param {string} url
 * @returns {{ remote: string, repo: string } | undefined}
 */
function parseRemote(url) {
  const full = URL_REMOTE.exec(url)
  if (full) {
    const [, , , host, owner, name] = full
    return { remote: withoutCredentials(url), repo: `${host}/${owner}/${name}` }
  }
  const scp = SCP_REMOTE.exec(url)
  return scp ? { remote: url, repo: `${scp[1]}/${scp[2]}/${scp[3]}` } : undefined
}

/**
 * Whether `url` is a pull request page of `repo`. Forges match owner and name case-insensitively.
 * @param {string} url
 * @param {string} repo
 */
function isPullOf(url, repo) {
  const prefix = `https://${repo}/pull/`.toLowerCase()
  return url.toLowerCase().startsWith(prefix) && /^[1-9][0-9]*$/.test(url.slice(prefix.length))
}

/** @param {string} text */
function tail(text) {
  const clean = withoutCredentials(text).trim()
  return clean.length > 500 ? `…${clean.slice(-500)}` : clean
}

/**
 * @typedef {{ cwd?: string, env?: Record<string, string>, input?: string, signal?: AbortSignal, timeoutMs?: number, keep?: (record: Buffer) => boolean }} RunOptions
 *   `keep` filters NUL-terminated stdout records as they arrive, so the limit applies to what is kept.
 * @typedef {{ code: number, stdout: string, stderr: string }} RunResult
 *   `code` is -1, no exit status any caller accepts, when the program was killed by a signal or its
 *   stdout was too long to keep or was not UTF-8 text; `stdout` is then empty, so no decision is ever made on part of an answer.
 */

/**
 * Runs one program with an argument array, never a shell. Prompts are off so a missing credential
 * fails instead of waiting on a terminal nobody watches.
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {Promise<RunResult>}
 */
function run(command, args, { cwd, env, input, signal, timeoutMs = 60_000, keep }) {
  const base = { ...process.env }
  for (const name of Object.keys(base))
    if (
      /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|(?:LITERAL|GLOB|NOGLOB|ICASE)_PATHSPECS)$/.test(
        name,
      )
    )
      delete base[name]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...base, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', ...env, ...GIT_SAFETY_ENV },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
    /** @type {Buffer[]} */
    const out = []
    let outBytes = 0
    let stderr = ''
    let pending = Buffer.alloc(0)
    /** @param {Buffer} record */
    const take = (record) => {
      outBytes += record.length
      if (outBytes > MAX_OUTPUT) child.kill('SIGKILL')
      else out.push(record)
    }
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      if (!keep) return take(chunk)
      pending = Buffer.concat([pending, chunk])
      for (let end = pending.indexOf(0); end !== -1; end = pending.indexOf(0)) {
        const record = pending.subarray(0, end + 1)
        pending = pending.subarray(end + 1)
        if (keep(record)) take(record)
      }
      if (pending.length > MAX_OUTPUT) take(pending)
    })
    // stderr only ever feeds a refusal's detail, so keeping its start is enough.
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk
    })
    child.stdin.on('error', () => {})
    child.on('error', reject)
    child.on('close', (code, killed) => {
      if (keep && pending.length && keep(pending)) take(pending)
      if (outBytes > MAX_OUTPUT)
        return resolve({
          code: -1,
          stdout: '',
          stderr: `${command} ${args[0] ?? ''}: output exceeded ${MAX_OUTPUT} bytes; refusing to act on part of it`,
        })
      // A child killed by a signal (the timeout included) has no exit status; reading one into it
      // would turn a timed-out check-ignore into "nothing ignored".
      if (code === null)
        return resolve({ code: -1, stdout: '', stderr: `${command} ${args[0] ?? ''}: killed by ${killed}` })
      let stdout
      try {
        stdout = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(out))
      } catch {
        return resolve({
          code: -1,
          stdout: '',
          stderr: `${command} ${args[0] ?? ''}: output is not UTF-8 text`,
        })
      }
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input ?? '')
  })
}
