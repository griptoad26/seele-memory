#!/usr/bin/env bash
# worker/scripts/deploy.sh — Migrate + deploy in one shot.
#
# TASK-seele-cloud-20261019-092.
#
# Prereqs: wrangler authenticated; wrangler.toml already has a real
# database_id (run provision.sh --apply first).

set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="seele-memory-db"

command -v wrangler >/dev/null 2>&1 || {
  echo "wrangler not found. Install: npm i -g wrangler" >&2
  exit 1
}
wrangler whoami >/dev/null 2>&1 || {
  echo "wrangler not authenticated. Run: wrangler login" >&2
  exit 2
}

echo "==> Apply migrations to $DB_NAME (remote)"
wrangler d1 execute "$DB_NAME" --remote \
  --file=migrations/0001_initial.sql

echo "==> Deploy Worker"
wrangler deploy

echo "==> Verify"
echo "    curl -sS https://seele.agency/api/mem/health | python3 -m json.tool"
