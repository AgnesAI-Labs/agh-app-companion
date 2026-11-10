# Companion (working name)

An Agnes Harness plugin package: the owner dispatches coding tasks from a phone chat, approves outward
actions on a card, and gets results back. This repository holds the skeleton: package metadata, the
application, the `judge` and `worker` Bundles, the managed task engine with its versioned store, and
the settings page. The task engine, the `publish` tool and chat delivery land in later changes.

## Layout

- `index.mjs` registers the managed engine (`companion`) whose configuration is the owner's settings.
- `store.mjs` owns the store layout: a format stamp, task records and event chunks. A store written by
  a newer format stops the engine before it becomes ready.
- `settings.mjs` owns the settings schema and the rules a schema cannot state.
- `sessions.mjs` describes the plugin-managed sessions port the platform does not provide yet, and how
  each role's session is opened.
- `client/` holds the task desk placeholder, the settings page and the navigation role.

## Tests

Tests import platform sources from a local Agnes Harness checkout (`~/agnes-harness`, or set
`AGNES_HARNESS`) and run with its vitest under the checkout's pinned Node:

```sh
sh scripts/companion-test.sh
```

Session behavior is tested against `test/fake-sessions.ts`; none of it is proven on the real platform.

## License

Apache-2.0. See [LICENSE](LICENSE).
