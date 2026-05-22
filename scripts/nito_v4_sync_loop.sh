#!/usr/bin/env bash
set -u

APP_DIR="${NITO_EQUIDUS_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN_DIR="${NITO_EQUIDUS_NODE_BIN_DIR:-}"
INTERVAL="${NITO_EQUIDUS_SYNC_INTERVAL:-45}"
ERROR_INTERVAL="${NITO_EQUIDUS_SYNC_ERROR_INTERVAL:-90}"

if [ -n "$NODE_BIN_DIR" ]; then
  export PATH="$NODE_BIN_DIR:$PATH"
fi

cd "$APP_DIR"

printf '[%s] nito_v4_sync_loop starting, app=%s, interval=%ss\n' "$(date -Is)" "$APP_DIR" "$INTERVAL"

while true; do
  printf '[%s] sync-blocks begin\n' "$(date -Is)"
  npm run sync-blocks
  rc=$?
  printf '[%s] sync-blocks end rc=%s\n' "$(date -Is)" "$rc"
  if [ "$rc" -eq 0 ]; then
    sleep "$INTERVAL"
  else
    sleep "$ERROR_INTERVAL"
  fi
done
