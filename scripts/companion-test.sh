#!/bin/sh
# Run the companion vitest suite with the open-source checkout's vitest and pinned Node.
#   sh scripts/companion-test.sh
#   AGNES_HARNESS=/path sh scripts/companion-test.sh test/store.test.ts
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="${AGNES_HARNESS:-$HOME/agnes-harness}"
VITEST="$HARNESS/node_modules/.bin/vitest"
[ -x "$VITEST" ] || { echo "vitest not found at $VITEST; run pnpm install in $HARNESS or set AGNES_HARNESS" >&2; exit 1; }
cd "$HARNESS"
exec mise exec -- "$VITEST" run --root "$ROOT" "$@"
