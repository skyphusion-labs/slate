#!/usr/bin/env bash
# Load slate.env and run the studio API smoke test.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
if [ -f slate.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./slate.env
  set +a
fi
exec node "$HERE/scripts/studio-smoke.mjs" "$@"
