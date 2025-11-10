#!/usr/bin/env bash
set -euo pipefail

# 作用：把主网 vaultpair 的 canister id 写入 canisters/www/.env.local
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WWW_DIR="$ROOT_DIR/canisters/www"
ENV_FILE="$WWW_DIR/.env.local"

CID="$(dfx canister --network ic id vaultpair 2>/dev/null || true)"
if [[ -z "$CID" ]]; then
  echo "ERROR: cannot resolve vaultpair canister id for network=ic" >&2
  exit 1
fi

# 保留现有的其它变量，只更新 VITE_VAULTPAIR_ID
TMP="$(mktemp)"
if [[ -f "$ENV_FILE" ]]; then
  grep -v '^VITE_VAULTPAIR_ID=' "$ENV_FILE" > "$TMP" || true
else
  : > "$TMP"
fi
echo "VITE_VAULTPAIR_ID=$CID" >> "$TMP"
mv "$TMP" "$ENV_FILE"

echo "[env] wrote $ENV_FILE with VITE_VAULTPAIR_ID=$CID"
