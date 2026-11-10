# Companion (working name)

An Agnes Harness plugin package: the owner dispatches coding tasks from a phone chat, approves outward
actions on a card, and gets results back. This repository holds the skeleton: package metadata, the
application, the `judge` and `worker` Bundles, the managed task engine with its versioned store, and
the settings page, the managed task engine and its wiring to the platform, the `publish` tool, and the
chat channel adapter.

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

## Not working on the platform yet

- The chat gateway plugin does not exist on the platform, so `resolveChannelGateway` returns nothing
  and the engine runs without a channel; replies stay pending in the store.
- The owner cannot authorize a workspace for a plugin yet, and full-access sessions are refused, so
  every worker start is refused today. The owner is told once and the task is parked.
- Approvals are answered on the local Web: a chat card cannot answer one and `start` takes no channel
  binding. When a session asks for an approval, the task waits and the owner gets one plain notice.
- The platform reports no approval verdict and no later approval state, so every permission request
  first seen pending counts toward `LIMITS.refusalLimit`: the third pauses the task until the owner
  continues it. A request already answered when first seen is not counted.
- Model routes: the platform needs a route and a model name; the settings hold only a route, so a set
  route is reported in `status()` instead of being replaced by the default.

## Budgets

`limits.mjs` is the one place for the engine's numbers. The per-task token cap and the per-task and
daily money caps are `null`, which means off. No setting turns them on yet, and no default amount is
assumed. Money is counted in USD, the only currency the platform reports.

## Tests

Tests import platform sources from a local Agnes Harness checkout (`~/agnes-harness`, or set
`AGNES_HARNESS`) and run with its vitest under the checkout's pinned Node:

```sh
sh scripts/companion-test.sh
```

Session behavior is tested against `test/fake-sessions.ts`, which speaks the platform's shapes and
refusals through the real adapter; none of it is proven on the real platform. The package
declaration sets `sessions: true`, which only a harness with plugin-managed sessions accepts, so
`test/package.test.ts` passes only with `AGNES_HARNESS` pointing at such a checkout.

## License

Apache-2.0. See [LICENSE](LICENSE).
