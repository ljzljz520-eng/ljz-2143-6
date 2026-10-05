#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
TMP=$(mktemp -d)
PORT=3399
cleanup(){ [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
PORT=$PORT DB_PATH="$TMP/wedding.db" UPLOAD_DIR="$TMP/uploads" node server.js >"$TMP/server.log" 2>&1 &
PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep .1; done
BASE_URL="http://127.0.0.1:$PORT" ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token}" bash test/e2e.sh
