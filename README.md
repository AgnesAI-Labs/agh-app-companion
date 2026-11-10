# Companion (working name)

An Agnes Harness plugin package: the owner dispatches coding tasks and approves outward actions such
as publishing a branch, then gets results back. The goal is to do this from a phone chat; today it
works from the local Web task desk only (see "Not working yet"). This repository holds the package
metadata, the application, the `judge` and `worker` Bundles, the managed task engine with its
versioned store and its wiring to the platform, the settings page and task desk, the `publish` tool,
and the chat channel adapter.

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
- `channel-contract.mjs` holds the chat channel shapes the companion assumes, with the open
  assumptions about the draft channel contract listed at its top; `channel.mjs` adapts a channel
  instance to the engine (owner-only inbound, reply mapping, send-once delivery). Tested against
  `test/fake-gateway.ts` only.
- `client/` holds the task desk placeholder, the settings page and the navigation role.

## Install and use

These steps come from the real-daemon run in an isolated home (see "Prove it on a real daemon"
below). They need an Agnes Harness build with plugin-managed sessions
([agnes-harness#633](https://github.com/AgnesAI-Labs/agnes-harness/pull/633), not merged yet) and a
working model route.

1. Install from a checkout of this repository:

   ```sh
   agh plugins add <path-to-this-checkout> --yes
   ```

   A directory install copies every file in the folder, not only the package's `files` list, so
   install from a clean checkout.
2. Open the Web workbench, then the companion's settings page. Fill in 称呼 (how to address you),
   可用工作区 (one `short-name=/absolute/path` per line), 专用工作区 (a separate folder the judge
   works in; it must not be one of the workspaces above) and 聊天渠道实例. No chat channel exists
   yet, so any non-empty value works; the desk reports the channel as a problem. Press 保存. The
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
   or forge credentials; the branch stays pushed and the tool reports `pr-failed`. Three rejections
   from a person pause the task. Approvals decided by the full-access policy do not count.

## Not working yet

- Phone channel: the chat gateway plugin does not exist on the platform, so the engine runs without a
  channel and replies stay pending in the store.
- Card approval: a chat card cannot answer an approval, and `start` takes no channel binding.
  Approvals are answered in the Web session only.
- A start error that is not a platform refusal is retried on every pass without telling the owner.
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
when a step fails. Against agnes-harness#633 at `653cd4aa7` all ten steps pass. `--keep` leaves the
home in place, `--hold-after N` stops after step N and keeps the daemon up, and `--cleanup <root>`
ends a held run. Playwright and Chrome come from the checkout.

## License

Apache-2.0. See [LICENSE](LICENSE).
