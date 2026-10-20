#!/usr/bin/env bash
# worker/scripts/provision.sh — one-shot Cloudflare resource provisioning.
#
# TASK-seele-cloud-20261019-092.
#
# Creates the D1 database and Vectorize index named in wrangler.toml, then
# prints (and optionally patches) the IDs wrangler.toml needs to know about.
#
# Requires: wrangler authenticated (`wrangler whoami` exits 0).
#
# Usage:
#   ./scripts/provision.sh          # dry run — create if missing, report IDs
#   ./scripts/provision.sh --apply  # also patch wrangler.toml in place

set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="seele-memory-db"
VEC_NAME="seele-memory-embeddings"
VEC_DIMS="${VEC_DIMS:-384}"
VEC_METRIC="${VEC_METRIC:-cosine}"

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

command -v wrangler >/dev/null 2>&1 || {
  echo "wrangler not found. Install: npm i -g wrangler" >&2
  exit 1
}
wrangler whoami >/dev/null 2>&1 || {
  echo "wrangler not authenticated. Run: wrangler login" >&2
  exit 2
}

# --- D1 -------------------------------------------------------------------
echo "==> D1: $DB_NAME"
if wrangler d1 list 2>/dev/null | grep -q "$DB_NAME"; then
  echo "    already exists"
else
  echo "    creating..."
  wrangler d1 create "$DB_NAME"
fi

DB_ID="$(wrangler d1 list --json 2>/dev/null \
  | python3 -c "
import json, sys
for d in json.load(sys.stdin):
    if d.get('name') == '$DB_NAME':
        print(d.get('uuid') or d.get('database_id') or '')
        break
" || true)"
echo "    database_id = ${DB_ID:-<parse manually from 'wrangler d1 list'>}"

# --- Vectorize ------------------------------------------------------------
echo "==> Vectorize: $VEC_NAME (${VEC_DIMS}d, $VEC_METRIC)"
if wrangler vectorize list 2>/dev/null | grep -q "$VEC_NAME"; then
  echo "    already exists"
else
  echo "    creating..."
  if ! wrangler vectorize create "$VEC_NAME" \
      --dimensions="$VEC_DIMS" --metric="$VEC_METRIC"; then
    echo "    WARN: vectorize create failed — the index may need to be"
    echo "          created in the Cloudflare dashboard if the CLI"
    echo "          subcommand is unavailable in this wrangler version."
  fi
fi

# --- Patch ----------------------------------------------------------------
if [[ "$APPLY" == "1" && -n "${DB_ID:-}" ]]; then
  echo "==> Patching wrangler.toml with database_id"
  sed -i.bak "s/REPLACE_WITH_D1_DATABASE_ID/$DB_ID/" wrangler.toml
  rm -f wrangler.toml.bak
  echo "    done"
else
  cat <<EOF

Next steps:
  1. Paste the database_id above into wrangler.toml
     (or re-run with --apply)
  2. wrangler d1 execute $DB_NAME --remote --file=migrations/0001_initial.sql
  3. wrangler deploy
EOF
fi
