#!/usr/bin/env bash
# deployments/deploy.sh — End-to-end deploy from the repo root.
#
# Wraps worker/scripts/{provision.sh,deploy.sh} with sensible defaults
# and the right working directory. Use this from CI or from a fresh
# machine after `wrangler login`.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Provisioning Cloudflare resources (D1 + Vectorize)"
./worker/scripts/provision.sh --apply

echo "==> Deploying Worker (migrate + push)"
./worker/scripts/deploy.sh
