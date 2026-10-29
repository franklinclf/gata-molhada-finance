#!/usr/bin/env bash
# Writes the container environment file from Azure Key Vault, using the VM's
# managed identity. Existing output is replaced only if every secret was read.
set -euo pipefail

VM_ENV="${GMF_VM_ENV:-/etc/gmf/vm.env}"
SECRETS_LIST="${GMF_SECRETS_LIST:-/opt/gmf/deploy/secrets.list}"
OUT="${GMF_ENV_OUT:-/run/gmf/app.env}"

# shellcheck disable=SC1090
source "$VM_ENV"
: "${GMF_KEYVAULT:?GMF_KEYVAULT is not set in $VM_ENV}"

mkdir -p "$(dirname "$OUT")"
umask 077
tmp="$(mktemp "${OUT}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

token="$(curl -fsS -H 'Metadata: true' \
  'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' \
  | jq -er .access_token)"

body="$(mktemp)"
trap 'rm -f "$tmp" "$body"' EXIT

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  # A trailing "?" marks a secret that may not exist yet: it is skipped when the vault says 404.
  optional=false
  if [[ "$name" == *\? ]]; then
    optional=true
    name="${name%\?}"
  fi
  if [[ ! "$name" =~ ^[A-Za-z0-9-]+$ ]]; then
    echo "invalid secret name: $name" >&2
    exit 1
  fi
  status="$(curl -sS -o "$body" -w '%{http_code}' -H "Authorization: Bearer $token" \
    "https://${GMF_KEYVAULT}.vault.azure.net/secrets/${name}?api-version=7.4")" || { echo "could not reach the vault for $name" >&2; exit 1; }
  if [[ "$status" == 404 && "$optional" == true ]]; then
    continue
  fi
  if [[ "$status" != 200 ]]; then
    echo "reading secret $name failed with HTTP $status" >&2
    exit 1
  fi
  value="$(jq -er .value < "$body")"
  if [[ "$value" == *$'\n'* ]]; then
    echo "secret $name has a newline; only single-line values are supported" >&2
    exit 1
  fi
  if [[ "$value" == *"'"* ]]; then
    echo "secret $name has a single quote; it cannot be written to the environment file safely" >&2
    exit 1
  fi
  # Single quotes keep Compose from expanding "$" in the value (password hashes contain it).
  printf "%s='%s'\n" "${name//-/_}" "$value" >> "$tmp"
done < "$SECRETS_LIST"

chmod 600 "$tmp"
mv "$tmp" "$OUT"
rm -f "$body"
trap - EXIT
