# Companion (working name)

An Agnes Harness plugin package: the owner dispatches coding tasks and approves outward actions such
as publishing a branch, then gets results back. The goal is to do this from a phone chat; today it
works from the local Web task desk only (see "Not working yet"). This repository holds the package
metadata, the application, the `judge` and `worker` Bundles, the managed task engine with its
versioned store and its wiring to the platform, the settings page and task desk, the `publish` tool,
and the chat channel adapter over the platform's channel targets.

## Layout

- `index.mjs` registers the managed engine (`companion`) whose configuration is the owner's settings,
  and wires it at start: the platform's managed sessions, the chat channel, one reconcile, then an
  engine pass every `LIMITS.tickIntervalMs` until shutdown. `status()` on the started value lists what
  keeps it from working: a missing platform capability, unfinished settings, a model route the
  settings cannot express, no channel or a channel refusal, a store bound to another channel owner,
  and the last platform refusal the owner was told about.
- `store.mjs` owns the store layout: a format stamp, task records and event chunks. A store written by
  a newer format stops the engine before it becomes ready.
- `settings.mjs` owns the settings schema and the rules a schema cannot state.
- `sessions.mjs` describes the managed sessions port in the platform's shapes and how each role's
  session is opened; `platform-sessions.mjs` adapts the platform's port and maps each refusal code to
  retry or park, with the one owner notice per refusal.
- `channel-contract.mjs` holds the chat channel shapes the companion assumes, with the assumptions
  about the platform's channel targets listed at its top; `channel-targets.mjs` is the one module
  that adapts `init.channels` to the companion's gateway port; `channel.mjs` adapts the pairing to
  the engine (owner-only inbound, reply mapping, text rendering cut to the platform's limit,
  send-once delivery). Tested against `test/fake-gateway.ts` only.
- `client/` holds the task desk placeholder, the settings page and the navigation role.

## Install and use

These steps come from the real-daemon run in an isolated home (see "Prove it on a real daemon"
below). They need an Agnes Harness build with plugin-managed sessions (agnes-harness `develop` at
`93c3e4776` or later, which has channel targets, Extension API 5.12 and the plugin live-reload fix, and contains
[agnes-harness#633](https://github.com/AgnesAI-Labs/agnes-harness/pull/633)) and a working model
route.

1. Install from a checkout of this repository:

   ```sh
   agh plugins add <path-to-this-checkout> --yes
   ```

   A directory install copies every file in the folder, not only the package's `files` list, so
   install from a clean checkout.
2. Open the Web workbench, then the companion's settings page. Fill in 称呼 (how to address you),
   可用工作区 (one `short-name=/absolute/path` per line), 专用工作区 (a separate folder the judge
   works in; it must not be one of the workspaces above). The chat channel is not a setting: it
   comes from pairing (see "Chat channel" below), and an old 聊天渠道实例 value is ignored. Press 保存. The
   platform asks you to review the change: choose "Allow once", then press 保存 again. The page shows
   `已提交：completed`. `agh plugins config set` does not reach these settings.
3. Grant the companion each folder it may start sessions in, the dedicated judge folder included:

   ```sh
   agh plugins grants grant @agh-apps/companion /path/to/judge-folder
   agh plugins grants grant @agh-apps/companion /path/to/workspace
   agh plugins grants list @agh-apps/companion --json
   ```

   Without the judge grant nothing gets judged. Without a workspace grant the worker start is
   refused: the desk pauses the task and says which folder to grant. After granting it, press 继续
   on the task.
   The e2e run also opens one ordinary session in each folder before granting it. Whether that step
   is required was not tested.
4. Open the task desk (`/?page=desk&pagePackage=@agh-apps/companion`) and type a request. The judge
   turns it into a task such as `T-0001`. Its worker session then runs with full access in the
   workspace. On macOS the OS sandbox still applies: reading `~/.ssh` fails with `Operation not
   permitted`.
5. Approvals. When the worker calls `publish`, the task shows as waiting on the desk. Its link opens
   the worker session, where the approval card offers "Allowed once" and "Reject". After you allow
   it, the branch is pushed to `origin`. Opening the pull request uses `gh` and fails without network
   or forge credentials; the branch stays pushed and the tool reports `pr-failed`. A task never ends
   as done without a PR link: it pauses as 已暂停（没开成 PR）, and the notice carries the reason. 继续
   asks the worker to run `publish` again, which waits for your approval like the first time. Three
   rejections from a person pause the task. Approvals decided by the full-access policy do not
   count.

### Reading GitHub pull requests and CI

A worker session cannot reach GitHub itself: its sandbox denies `.git`, shell network and `gh`
credentials. The read-only `github_read` tool answers instead, running in the plugin process with
your own `gh` login. It has four actions: `pr_list` (state, limit, base, author), `pr_view`,
`pr_checks` and `pr_diff` (the last three take a pull request number). It reads only the
repository of the session workspace, taken from the fetch URL of `origin`; no parameter names a
repository or passes arguments to `gh`. Long pull request bodies, comments and diffs are cut and
marked `truncated`.

The results go to the cloud model and may come back in the task result. For a private repository
that means pull request content leaves your machine. Pull request text is written by other people;
the tool tells the model to treat it as data, not as instructions.

### Reading local git history, status and diffs

The same sandbox denies a worker session its own `.git`, so `git log` and `git diff` fail there.
The read-only `git_read` tool answers from the plugin process. It has five actions: `status`,
`log` (limit, ref, path), `diff` (working tree against `HEAD` by default, or `staged`, or `from`
and `to`; optional path), `show` (a ref) and `blame` (a path, optional ref and line range, at most
500 lines; committed history only, `HEAD` when no ref is given, never the working tree). It reads only the session workspace, which must be the top level of a git repository.
Refs are `HEAD`, `HEAD~N`, `HEAD^`, a branch or tag name, or a commit id; paths are relative and
never under `.git`. Commit authors appear by name, never by email.

It never fetches, never writes the index, never starts an external diff or textconv program, a
pager or a hook, never enters submodules, and takes no free-form git argument. Diffs and `show`
output are cut at 200 KB, `status` at 2000 entries and `blame` at 500 lines, and the result says
`truncated`. A `.gitattributes` clean filter named in your own git config (git-lfs, for example)
can still run, because the workspace can only select such a filter, not define one.

### Direct answers and Markdown

The judge can answer directly without creating a task. Direct replies keep their Markdown and are
bounded by the smaller of 8,000 UTF-16 units and the paired channel's current text budget. The model
receives the same limit the backend checks; the budget is checked again after the model finishes and
before delivery. A reply that is too long is refused with a specific notice, not silently clipped into
an incomplete code block. Worker-result and choice-card clipping keep their existing behavior.

Before the first send, the actual reply (or budget-refusal notice) is saved to the outbox. Once a send
can have an uncertain result, that payload and delivery key stay frozen. If a later budget shrink
prevents safe retry, the original stays blocked with no claimed receipt, a separate uncertainty
notice is queued once, and unrelated messages continue. Blocked originals are not presented to the
judge as replies the owner received. No message is automatically resent under a different key.

A direct answer may repeat an exact task-snapshot link or a valid HTTP/HTTPS URL explicitly supplied
in the owner message it answers. Credentials, raw quotes and backslash ambiguities are refused. Another
message in the batch, reference material and old conversation do not authorize links; task titles
still cannot contain links. URLs are never fetched by this check. Unsafe characters or unverified
links produce a specific refusal without echoing the rejected output.

When a judge-written title or answer contains an ambiguous bare address, the companion may spell its
punctuation instead of refusing the whole decision. For example, `安排.md` appears as `安排〔点号〕md`.
The spelling is not the original filename and cannot be copied as a path. It does not prove a file
exists or authorize a URL. The worker still receives the owner's original request as its brief.
Spelling can remove Markdown formatting. Unsafe or ambiguous complete URLs and schemes remain refused.
When bare-address spelling is needed, text containing `@` outside authorized URLs is refused
conservatively rather than interpreting a possible credential-bearing address.
The actual chat client's link detection for this spelling has not been verified.

Markdown is passed to the channel, not rendered by the judge. Client support for individual Markdown
features is separate from acceptance and delivery.

### Asking you a question

A worker can call `ask_user_question` for single-choice, multiple-choice or text answers. Supported
questions appear as a native card in the paired chat and can also be answered in the Web session. The
tool returns immediately by default, but the task remains 等你 while the backend reports an unanswered
native question—even if that turn completes. Answering continues the same session; only a settled
question and completed continuation finish the task. Previously misclassified completed tasks recover
to 等你 without starting another turn. The card reflects the settled state; unsupported forms retain
the authenticated Web link.

A worker can also call `ask_owner` with a question and, when there are clear choices, 2 to 6 options,
then ends its turn. This workflow sends the answer as the next turn. The task shows as 等你 and one message
says 等你回答, with the question and the numbered options below it. Answer in the chat. A message that
is just an option number (`1`, `选2`, `2。`) or an option's exact text goes straight to that task's
session when it is the only task waiting on a question; anything else, such as a new request, goes to
the judge as usual, and with two or more tasks waiting every answer does. Replying to the message,
naming the task or its PR link also works. A worker that writes a question only in its reply still
finishes as done. `ask_owner` refuses a session that is not a running task session.

### Pauses without an approval

- A worker session that cannot be started for a reason the platform names (a folder not granted,
  full access unavailable, and so on) pauses the task once, with a notice that says what to fix.
- A start that fails with any other error is tried again, and the third failed attempt parks the
  task as 已暂停（平台拒绝）. The notice carries the short error. The count is kept with the pending
  start, so a restart does not reset it. 继续 opens a new session with a fresh count.

## Chat channel

The Companion has no chat client of its own. It needs an AGH build with channel targets (Extension
API 5.13, which sends buttons and reports quoted replies and clicks); the exact `develop` commit that contains them is to be filled in here once that change
is merged, and a host without it refuses to install this package.

1. Install and enable the channel plugin for your chat app (for example the Feishu one) and start
   its instance.
2. In the AGH Web workbench open the plugin channel page, press "配对到插件服务" on the instance and
   pick 伴侣. The page shows a one-hour code.
3. Send that code to the bot in a private chat. The platform records the pairing; from then on your
   private messages reach the Companion and its replies come back as text in the same chat.
4. To end it, press 解除配对 on the task desk or on the channel page.

Buttons and quotes (needs a chat plugin that supports cards and quotes; the Feishu plugin does):

- A choice about which task a message belongs to arrives as one button per task and one for a new
  task. A question a worker asks through `ask_owner` arrives as one button per option. A tap counts
  as the owner's own message: a task button picks that task, and an option button sends
  the option's number `n` to the task that asked. A tap on a stale question or on an option the message never
  offered is ignored.
- A reply that quotes one of the Companion's messages about a single task goes to that task without
  the judge. A chat without cards shows the options as a numbered list instead.
- The title line is bold, and a Markdown link in a worker's text is shown as `text（address）` so you
  can see where it points.

After an AGH daemon restart, Companion restores its watched worker sessions and reconciles pending cards.

## Not working yet

- Phone channel, real chat: validate native questions and approvals with your own Feishu account.
- Model routes: the platform needs a route and a model name; the settings hold only a route, so a set
  route is reported in `status()` instead of being replaced by the default.

## Budgets

`limits.mjs` is the one place for the engine's numbers. The per-task token cap and the per-task and
daily money caps are `null`, which means off, and no default amount is assumed. The settings page can
set each one (`caps.taskTokens`, `caps.taskCost`, `caps.dailyCost`). Money is counted in USD, the
only currency the platform reports.

## Tests

Tests import platform sources from a local Agnes Harness checkout (`~/agnes-harness`, or set
`AGNES_HARNESS`) and run with its vitest under the checkout's pinned Node:

```sh
sh scripts/companion-test.sh
```

Session behavior is tested against `test/fake-sessions.ts`, which speaks the platform's shapes and
refusals through the real adapter. The end-to-end run below is the only check against a real
daemon. The package
declaration sets `sessions: true`, which only a harness with plugin-managed sessions accepts, so
`test/package.test.ts` passes only with `AGNES_HARNESS` pointing at such a checkout.

## Prove it on a real daemon

`scripts/e2e/run.mjs` installs the companion on a real daemon and walks the steps above. It runs in
a throwaway `/tmp/agh-e2e-*` home against a loopback model (`scripts/e2e/model.mjs`) with a random
key. It uses a synthetic git repository whose `origin` is a local bare repository reached through an
ssh shim, plus a `gh` stub that refuses. It needs no network and no credentials, and never touches
`~/.agh`.

```sh
AGNES_HARNESS=<agnes-harness checkout> node scripts/e2e/run.mjs
```

The first run builds a runtime into `<checkout>/.agnes-tmp/companion-e2e/runtime` (`--runtime <dir>`
uses another build). Each step prints `PASS` or `FAIL` and saves evidence (JSON, CLI transcripts,
screenshots) under `<checkout>/.agnes-tmp/companion-e2e/evidence/<run>`. The script exits non-zero
when a step fails. Against agnes-harness `develop` at `e30254dd9` all ten steps pass, including step 7's check that the demo task ends paused for 没开成 PR, because the `gh` stub refuses. `--keep` leaves the
home in place, `--hold-after N` stops after step N and keeps the daemon up, and `--cleanup <root>`
ends a held run. Playwright and Chrome come from the checkout.

## License

Apache-2.0. See [LICENSE](LICENSE).
