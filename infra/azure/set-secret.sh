#!/usr/bin/env bash
# Stores one secret in Key Vault. The value is read from the terminal without echo
# and never appears in the process list or the shell history.
# Usage: infra/azure/set-secret.sh SECRET-NAME
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
require GMF_KEYVAULT

name="${1:?usage: set-secret.sh SECRET-NAME}"
if [[ ! "$name" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "Secret names allow letters, digits and dashes only." >&2
  exit 1
fi

read -r -s -p "Value for $name: " value
echo
if [[ -z "$value" ]]; then
  echo "Empty value; nothing stored." >&2
  exit 1
fi

umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf '%s' "$value" > "$tmp"
az keyvault secret set --vault-name "$GMF_KEYVAULT" --name "$name" --file "$tmp" --encoding utf-8 --output none
echo "Stored $name in $GMF_KEYVAULT."
