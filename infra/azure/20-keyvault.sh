#!/usr/bin/env bash
# Key Vault with RBAC. The signed-in user may manage secrets; the VM identity gets read access in 30-vm.sh.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
require GMF_KEYVAULT

az keyvault create --resource-group "$GMF_RG" --name "$GMF_KEYVAULT" --location "$GMF_LOCATION" \
  --enable-rbac-authorization true --retention-days 7 --output none

kv_id="$(az keyvault show --name "$GMF_KEYVAULT" --query id --output tsv)"
user_id="${GMF_USER_OBJECT_ID:-$(az ad signed-in-user show --query id --output tsv)}"

az role assignment create --assignee-object-id "$user_id" --assignee-principal-type User \
  --role "Key Vault Secrets Officer" --scope "$kv_id" --output none

echo "Key Vault ready: https://$GMF_KEYVAULT.vault.azure.net"
