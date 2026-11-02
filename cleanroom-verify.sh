#!/usr/bin/env bash
# Compatibility entry for the supported full clean-room fallback. The canonical controller owns
# complete resource admission, fresh per-chunk migration, RLS tests and authenticated receipts.
# Never rewrite .env.local, restore an unowned backup or drop a fixed database in this adapter.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$ROOT/scripts/gate.sh" --full "$@"
