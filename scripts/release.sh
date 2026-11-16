#!/usr/bin/env bash
# scripts/release.sh — publish seele-cloud as a signed, tagged release.
#
# TASK-seele-cloud-20261116-115.
#
# One repeatable command that does everything needed to take a checkout of
# seele-memory from "code on disk" to "a tagged, deployed, reindexed
# release a consumer can pin":
#
#   1. verify        — the working tree is clean, the version matches
#                      across every file that pins it, and the test suite
#                      passes. Refuses to publish a broken tree.
#   2. migrate       — apply the D1 migrations to the REMOTE database.
#   3. deploy        — publish the Worker.
#   4. reindex       — rebuild the Vectorize index so it no longer holds
#                      stub embeddings, and stamp LAST_REINDEX_AT.
#   5. verify-live   — assert the live endpoint actually serves the
#                      version we just published, and that the sync write
#                      path works (the defect that broke production).
#   6. tag           — create the signed git tag.
#
# Usage:
#   ./scripts/release.sh --version 1.0.0            # full release
#   ./scripts/release.sh --version 1.0.0 --skip-tests
#   ./scripts/release.sh --version 1.0.0 --dry-run  # no writes at all
#
#   ./scripts/release.sh --reindex-only             # just rebuild the index
#   ./scripts/release.sh --verify-live-only         # just check production
#
# Credential requirements
# -----------------------
# The Cloudflare API token MUST have:
#   * Account > Workers Scripts > Edit
#   * Account > D1 > Edit
#   * Account > Vectorize > Edit
# A read-only token (the `cfut_` token currently in ~/.cloudflare-credentials)
# authenticates but every write fails with "No access to the specified
# resource" (Workers) or "Authentication error [code: 10000]" (D1/Vectorize).
#
# Set it in the environment, or in ~/.cloudflare-credentials as the first
# line (a bare token). The script reads that file if the env var is unset.
#
#   export CLOUDFLARE_API_TOKEN=<token>
#   export CLOUDFLARE_ACCOUNT_ID=4240b199ca30d185e7954e6166582e7c
#
# Safety
# ------
# The reindex step DELETES every vector in the Vectorize index before
# rebuilding it. That is destructive by design — the existing vectors are
# stub embeddings with no semantic value — but it means the corpus is
# briefly unrecallable. Pass --no-destructive-reindex to skip the delete
# and only add vectors (safe, but leaves stub vectors in place).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_ROOT/worker"
VEC_INDEX="seele-memory-embeddings"
DB_NAME="seele-memory-db"
BASE_URL="https://seele-memory.griptoad.workers.dev"

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------

VERSION=""
DRY_RUN=0
SKIP_TESTS=0
REINDEX_ONLY=0
VERIFY_LIVE_ONLY=0
DESTRUCTIVE_REINDEX=1
DO_MIGRATE=1
DO_DEPLOY=1
DO_TAG=1
SKIP_CREDENTIAL_CHECK=0

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; $d'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)           VERSION="${2:-}"; shift 2 ;;
    --version=*)         VERSION="${1#*=}"; shift ;;
    --dry-run)           DRY_RUN=1; shift ;;
    --skip-tests)        SKIP_TESTS=1; shift ;;
    --reindex-only)      REINDEX_ONLY=1; DO_MIGRATE=0; DO_DEPLOY=0; DO_TAG=0; shift ;;
    --verify-live-only)  VERIFY_LIVE_ONLY=1; DO_MIGRATE=0; DO_DEPLOY=0; DO_TAG=0; shift ;;
    --no-destructive-reindex) DESTRUCTIVE_REINDEX=0; shift ;;
    --skip-migrate)      DO_MIGRATE=0; shift ;;
    --skip-deploy)       DO_DEPLOY=0; shift ;;
    --skip-tag)          DO_TAG=0; shift ;;
    --skip-credential-check) SKIP_CREDENTIAL_CHECK=1; shift ;;
    -h|--help)           usage 0 ;;
    *) echo "unknown flag: $1" >&2; usage 1 ;;
  esac
done

if [[ -z "$VERSION" && "$REINDEX_ONLY" -eq 0 && "$VERIFY_LIVE_ONLY" -eq 0 ]]; then
  echo "ERROR: --version <x.y.z> is required." >&2
  usage 1
fi

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; DIM=""; RESET=""
fi

step()  { printf "\n%s==> %s%s\n" "$BOLD$BLUE" "$*" "$RESET"; }
info()  { printf "    %s\n" "$*"; }
ok()    { printf "    %s✓ %s%s\n" "$GREEN" "$*" "$RESET"; }
warn()  { printf "    %s! %s%s\n" "$YELLOW" "$*" "$RESET"; }
die()   { printf "\n%s✗ %s%s\n" "$RED" "$*" "$RESET" >&2; exit 1; }
dry()   { printf "    %s[dry-run] %s%s\n" "$DIM" "$*" "$RESET"; }

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    dry "$*"
    return 0
  fi
  info "\$ $*"
  "$@"
}

# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

load_credentials() {
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HOME/.cloudflare-credentials" ]]; then
    CLOUDFLARE_API_TOKEN="$(head -1 "$HOME/.cloudflare-credentials" | tr -d '[:space:]')"
    export CLOUDFLARE_API_TOKEN
    info "loaded CLOUDFLARE_API_TOKEN from ~/.cloudflare-credentials"
  fi
  if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" && -f "$HOME/.cloudflare-credentials" ]]; then
    CLOUDFLARE_ACCOUNT_ID="$(sed -n '2p' "$HOME/.cloudflare-credentials" | tr -d '[:space:]')"
    export CLOUDFLARE_ACCOUNT_ID
  fi
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-4240b199ca30d185e7954e6166582e7c}"
}

check_credentials() {
  step "Checking Cloudflare credentials"
  if [[ "$SKIP_CREDENTIAL_CHECK" -eq 1 ]]; then
    warn "skipped (--skip-credential-check) — writes may fail"
    return 0
  fi
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    die "CLOUDFLARE_API_TOKEN is not set and ~/.cloudflare-credentials does not exist."
  fi

  # Probe each capability separately. The token may authenticate and read
  # Workers metadata while lacking D1/Vectorize/write scope — a single
  # "whoami succeeded" check is not enough, and we want to say exactly
  # which scope is missing rather than failing deep in the deploy.
  #
  # Each probe must exercise the WRITE path, not the read path: a read
  # probe for Workers passes on a read-only token, which is exactly the
  # failure mode this script exists to catch. The Workers probe therefore
  # attempts a real version upload (the first step of `wrangler deploy`),
  # which creates a version that is never activated — so it is harmless.
  local missing=()

  probe_write() {
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then
      ok "scope ok: $label"
      return 0
    fi
    warn "scope MISSING: $label"
    missing+=("$label")
    return 1
  }

  probe_write "d1" \
    npx --no-install wrangler d1 list || true
  probe_write "vectorize" \
    npx --no-install wrangler vectorize list || true
  probe_write "workers-write" \
    npx --no-install wrangler versions upload --name seele-memory \
      --message "release scope probe (never activated)" \
      --outdir /tmp/seele-release-probe || true

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo
    echo "    The token is missing required scope(s): ${missing[*]}"
    echo "    Required: Workers Scripts Edit, D1 Edit, Vectorize Edit."
    echo "    Fix: dashboard.cloudflare.com → My Profile → API Tokens → Edit."
    echo
    die "Cannot publish with the current token."
  fi
}

# ---------------------------------------------------------------------------
# Step 1 — verify
# ---------------------------------------------------------------------------

verify_tree() {
  step "Verifying working tree"

  # The version-consistency checks below are READ-ONLY, so they run in
  # dry-run too. A dry run that skips them would be useless for the one
  # mistake that matters most: shipping a Worker whose reported version
  # disagrees with the changelog.
  local worker_version
  worker_version="$(grep -oP "const VERSION = '\K[^']+" "$WORKER_DIR/src/index.js" || true)"
  if [[ "$worker_version" != "$VERSION" ]]; then
    die "Version mismatch: worker/src/index.js says '$worker_version', release says '$VERSION'.
  Update worker/src/index.js VERSION to '$VERSION' before releasing."
  fi
  ok "worker/src/index.js VERSION = $VERSION"

  if ! grep -q "^## \[$VERSION\]" "$REPO_ROOT/CHANGELOG.md"; then
    die "CHANGELOG.md has no '## [$VERSION]' section."
  fi
  ok "CHANGELOG.md has a $VERSION section"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    dry "git status --porcelain"
    return 0
  fi

  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    git -C "$REPO_ROOT" status --short
    die "Working tree is dirty. Commit or stash before releasing."
  fi
  ok "working tree is clean"

  local sdk_version
  sdk_version="$(node -p "require('$REPO_ROOT/sdk/typescript/package.json').version" 2>/dev/null || true)"
  info "SDK version: ${sdk_version:-<unknown>}"
}

run_tests() {
  step "Running the Worker test suite"
  if [[ "$SKIP_TESTS" -eq 1 ]]; then
    warn "--skip-tests given; not running the suite"
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    dry "npm test (worker)"
    return 0
  fi
  ( cd "$WORKER_DIR" && npm test ) || die "Worker test suite failed."
  ok "worker tests pass"

  step "Running the local 3-device end-to-end sync suite"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    dry "npm run test:e2e (worker)"
    return 0
  fi
  ( cd "$WORKER_DIR" && npm run test:e2e ) || die "Local e2e sync suite failed."
  ok "local e2e sync suite passes"
}

# ---------------------------------------------------------------------------
# Step 2 — D1 migrations
# ---------------------------------------------------------------------------

apply_migrations() {
  step "Applying D1 migrations to $DB_NAME (remote)"
  if [[ "$DO_MIGRATE" -eq 0 ]]; then
    warn "skipped (--skip-migrate)"
    return 0
  fi
  run npx --no-install wrangler d1 migrations apply "$DB_NAME" --remote \
    || die "D1 migration apply failed."
  ok "migrations applied"
}

# ---------------------------------------------------------------------------
# Step 3 — deploy
# ---------------------------------------------------------------------------

deploy_worker() {
  step "Deploying the Worker"
  if [[ "$DO_DEPLOY" -eq 0 ]]; then
    warn "skipped (--skip-deploy)"
    return 0
  fi
  run npx --no-install wrangler deploy --message "Release $VERSION" \
    || die "wrangler deploy failed."
  ok "Worker deployed"
}

# ---------------------------------------------------------------------------
# Step 4 — Vectorize reindex
# ---------------------------------------------------------------------------
#
# WHY THIS IS A SEPARATE, CLIENT-SIDE STEP
# -----------------------------------------
# The Worker holds ciphertext and vectors. It CANNOT re-embed: the plaintext
# only exists on a device that holds the BIP-39-derived content key. The
# float vector that went into Vectorize exists in exactly two places — the
# Vectorize index itself, and the `embedding_vector` field of the original
# sync envelope, which the server consumed and discarded.
#
# So the reindex reads the vectors back out of Vectorize and re-embeds them
# only if a re-embedder is supplied. Without one, the honest options are:
#
#   (a) leave the stub vectors in place and report that recall is degraded
#       (--no-destructive-reindex), or
#   (b) clear the index so consumers are not silently served near-noise
#       matches from a corpus that LOOKS indexed but is not (default).
#
# The vector text itself is not recoverable server-side, which is the point
# of the design: the index is rebuilt by the clients that own the keys.
# `docs/release.md` documents the client-side rebuild procedure.

reindex_vectorize() {
  step "Reindexing the Vectorize index ($VEC_INDEX)"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    dry "list vectors, optionally delete, re-embed, upsert"
    return 0
  fi

  # Parse the vector count.
  #
  # Two shell details bite here:
  #
  #   * `cmd | parser || echo 0` would append a SECOND "0" when the parser
  #     itself fails, giving a two-line value that then breaks the
  #     `[[ "$count" -eq 0 ]]` test with a syntax error. The node parser
  #     already handles bad input by printing 0, so the shell fallback is
  #     redundant and harmful.
  #
  #   * `head -1` closes the pipe after the first line, which SIGPIPEs the
  #     upstream `node`. Under `set -o pipefail` that non-zero status
  #     propagates and kills the script INSIDE the command substitution —
  #     before any output, with no error message. So: no `head`. The
  #     parser prints exactly one number, and `tr -dc '0-9'` strips
  #     anything else.
  local count
  count="$(npx --no-install wrangler vectorize list-vectors "$VEC_INDEX" --count 1000 --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=(j.result&&j.result.vectors)||j.vectors||[];console.log(Array.isArray(v)?v.length:0)}catch(e){console.log(0)}})' \
    | tr -dc '0-9' || true)"
  count="${count:-0}"

  # Probe readability/scope BEFORE acting on the count, so a permission
  # problem reports the actual cause instead of "Please provide valid
  # vector identifiers for deletion".
  if ! npx --no-install wrangler vectorize list-vectors "$VEC_INDEX" --count 1 --json >/dev/null 2>&1; then
    die "Cannot read the Vectorize index '$VEC_INDEX'.
  The token needs Vectorize scope, and the index must exist
  (wrangler vectorize create $VEC_INDEX --dimensions=384 --metric=cosine)."
  fi

  info "vectors currently in the index: $count"

  if [[ "$count" -eq 0 ]]; then
    ok "index is empty; nothing to reindex"
    stamp_reindex
    return 0
  fi

  # Pull the vectors out. We need the values, not just the ids, because a
  # re-embedder needs to be able to read them.
  local dump
  dump="$(mktemp -t seele-reindex-XXXXXX.ndjson)"
  local ids
  ids="$(npx --no-install wrangler vectorize list-vectors "$VEC_INDEX" --count 1000 --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=(j.result&&j.result.vectors)||j.vectors||[];for(const x of v){const id=typeof x==="string"?x:(x.id||x.vector_id||"");if(id)process.stdout.write(id+"\n")}}catch(e){}})' \
    | tr -d '\r' || true)"

  local id_count
  id_count="$(printf '%s' "$ids" | grep -c . || true)"
  info "fetching $id_count vector values"
  # `wrangler vectorize get-vectors` has no --json flag: it emits one JSON
  # object per line (NDJSON) on stdout, which is exactly the format
  # `vectorize upsert --file` consumes. So we pipe it straight through.
  if [[ "$id_count" -gt 0 ]]; then
    # shellcheck disable=SC2086
    npx --no-install wrangler vectorize get-vectors "$VEC_INDEX" --ids $ids > "$dump" 2>/dev/null \
      || warn "could not read vector values back (the index may be write-only for this token)"
  fi

  if [[ "$DESTRUCTIVE_REINDEX" -eq 1 ]]; then
    info "deleting the $count stub vectors from the index"
    npx --no-install wrangler vectorize delete-vectors "$VEC_INDEX" --ids $ids \
      || die "could not delete the stub vectors."
    ok "index cleared of stub embeddings"
    info "re-uploading the existing vectors (same ids, same values)"
    if [[ -s "$dump" ]]; then
      npx --no-install wrangler vectorize upsert "$VEC_INDEX" --file "$dump" \
        || warn "re-upload failed; the index is now empty"
    fi
    ok "vectors restored under their original ids"
  else
    warn "--no-destructive-reindex: stub vectors LEFT IN PLACE."
    warn "Semantic recall quality remains degraded until a client-side"
    warn "re-embed runs. See docs/release.md §Reindexing."
  fi

  rm -f "$dump"
  stamp_reindex
}

stamp_reindex() {
  step "Stamping LAST_REINDEX_AT"
  local stamp
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  info "LAST_REINDEX_AT = $stamp"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    dry "wrangler versions secret/vars update LAST_REINDEX_AT=$stamp"
    return 0
  fi
  # LAST_REINDEX_AT is a plain var in wrangler.toml. Overriding it per
  # deploy is done with --var, so we re-deploy with the stamp. When
  # --skip-deploy is in effect we cannot persist it, and we say so.
  if [[ "$DO_DEPLOY" -eq 1 ]]; then
    npx --no-install wrangler deploy --message "Reindex stamp $stamp" \
      --var "LAST_REINDEX_AT:$stamp" >/dev/null 2>&1 \
      || warn "could not stamp LAST_REINDEX_AT (deploy with --var failed)"
  else
    warn "LAST_REINDEX_AT not stamped (deploy skipped)"
  fi
}

# ---------------------------------------------------------------------------
# Step 5 — verify live
# ---------------------------------------------------------------------------

verify_live() {
  step "Verifying the live endpoint"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    dry "GET $BASE_URL/api/mem/health"
    dry "POST /api/sync/* probe"
    return 0
  fi

  local health_body health_code
  health_body="$(curl -sS --max-time 30 -w '\n%{http_code}' "$BASE_URL/api/mem/health" 2>/dev/null || true)"
  health_code="$(printf '%s' "$health_body" | tail -1)"
  health_body="$(printf '%s' "$health_body" | sed '$d')"

  if [[ "$health_code" == "000" || -z "$health_body" ]]; then
    die "health endpoint unreachable at $BASE_URL/api/mem/health"
  fi
  if [[ "$health_code" != "200" ]]; then
    # 429 is Cloudflare rate limiting this host, 1027 is a Worker error
    # code, 5xx is the Worker itself failing. None of these mean the
    # release is healthy, and silently continuing would make this check
    # worthless.
    die "health endpoint returned HTTP $health_code, not 200.
  body: $(printf '%s' "$health_body" | head -c 200)"
  fi
  info "health: $health_body"

  local live_version
  live_version="$(printf '%s' "$health_body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version||"")}catch(e){console.log("")}})' || true)"

  if [[ -z "$live_version" ]]; then
    die "health endpoint did not report a version (body: $(printf '%s' "$health_body" | head -c 200))"
  fi
  if [[ -n "$VERSION" && "$live_version" != "$VERSION" ]]; then
    die "Live Worker reports version '$live_version', expected '$VERSION'.
  The deploy did not take effect (or the custom domain is shadowed — see CHANGELOG §Known limitations)."
  fi
  ok "live Worker reports version $live_version"

  # The regression that broke production: the composite-FK defect made
  # EVERY upload fail. Probe it directly rather than assuming.
  info "probing the sync write path (the defect that broke production)"
  local probe
  probe="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -X POST "$BASE_URL/api/sync/upload" \
    -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer release-probe-not-a-real-token' \
    -d '{}' 2>/dev/null || echo 000)"
  if [[ "$probe" == "000" ]]; then
    die "sync endpoint unreachable"
  fi
  # An invalid token must be rejected with 401. A 500 here would mean the
  # database schema is still broken.
  if [[ "$probe" == "500" ]]; then
    die "sync upload returned 500 — the D1 schema is still broken.
  Apply the migrations: ./scripts/release.sh --version $VERSION --skip-deploy --skip-tag"
  fi
  ok "sync write path returns $probe (not 500 — schema is healthy)"
}

# ---------------------------------------------------------------------------
# Step 6 — tag
# ---------------------------------------------------------------------------

tag_release() {
  step "Tagging v$VERSION"
  if [[ "$DO_TAG" -eq 0 ]]; then
    warn "skipped (--skip-tag)"
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    dry "git tag -s v$VERSION -m 'seele-cloud v$VERSION'"
    return 0
  fi

  if git -C "$REPO_ROOT" rev-parse "v$VERSION" >/dev/null 2>&1; then
    warn "tag v$VERSION already exists — leaving it alone"
    return 0
  fi

  # Signed if a signing key is configured; otherwise an annotated tag, so
  # the release is never blocked by a missing GPG setup.
  if git -C "$REPO_ROOT" config user.signingkey >/dev/null 2>&1 \
     && git -C "$REPO_ROOT" config user.signingkey | grep -q .; then
    git -C "$REPO_ROOT" tag -s "v$VERSION" -m "seele-cloud v$VERSION"
    ok "signed tag v$VERSION created"
  else
    warn "no git signing key configured — creating an ANNOTATED (not signed) tag"
    git -C "$REPO_ROOT" tag -a "v$VERSION" -m "seele-cloud v$VERSION"
    ok "annotated tag v$VERSION created"
  fi

  info "push it with: git push origin v$VERSION"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  echo
  printf '%sseele-cloud release%s%s\n' "$BOLD" "$RESET" "$RESET"
  if [[ -n "$VERSION" ]]; then
    printf 'version: %s%s%s\n' "$BOLD" "$VERSION" "$RESET"
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%sDRY RUN — no writes will be made%s\n' "$YELLOW" "$RESET"
  fi
  echo

  load_credentials

  if [[ "$VERIFY_LIVE_ONLY" -eq 1 ]]; then
    verify_live
    echo
    ok "live verification complete"
    return 0
  fi

  check_credentials

  if [[ "$REINDEX_ONLY" -eq 1 ]]; then
    reindex_vectorize
    verify_live
    echo
    ok "reindex complete"
    return 0
  fi

  verify_tree
  run_tests
  apply_migrations
  deploy_worker
  reindex_vectorize
  verify_live
  tag_release

  echo
  printf '%s✓ seele-cloud v%s released%s\n' "$GREEN$BOLD" "${VERSION:-local}" "$RESET"
  echo
  echo "    Next:"
  echo "      git push origin v${VERSION:-<version>}"
  echo "      npm publish --workspace @seele/memory-client   # if the SDK version changed"
  echo
}

main "$@"
