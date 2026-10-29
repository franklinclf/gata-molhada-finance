#!/usr/bin/env bash
# Copies the secrets listed below from a local .env file to Key Vault, one secret per variable.
# Values are read from the file and sent through a private temp file, so they never show up on
# the screen, in the process list or in the shell history.
# Usage: GMF_KEYVAULT=name infra/azure/push-env.sh [--dry-run] [path/to/.env]
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
require GMF_KEYVAULT

dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
env_file="${1:-.env}"
[[ -f "$env_file" ]] || { echo "No such file: $env_file" >&2; exit 1; }

VARIABLES=(
  PLUGGY_CLIENT_ID
  PLUGGY_CLIENT_SECRET
  PLUGGY_ITEMS
  AUTH_PASSWORD_HASH
  AUTH_TOTP_SECRET
  AUTH_RECOVERY_HASHES
)

umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for var in "${VARIABLES[@]}"; do
  line="$(grep -m1 "^${var}=" "$env_file" || true)"
  value="${line#*=}"
  # Drop one pair of surrounding quotes, if present.
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
  secret="${var//_/-}"
  if [[ -z "$value" ]]; then
    echo "skip   $secret (empty or missing in $env_file)"
    continue
  fi
  if $dry_run; then
    echo "would store $secret (${#value} characters)"
    continue
  fi
  printf '%s' "$value" > "$tmp"
  az keyvault secret set --vault-name "$GMF_KEYVAULT" --name "$secret" --file "$tmp" --encoding utf-8 --output none
  echo "stored $secret (${#value} characters)"
done
