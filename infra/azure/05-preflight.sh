#!/usr/bin/env bash
# Read-only checks (plus provider registration) before creating anything.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"

echo "== Account"
az account show --query "{name:name, id:id, state:state, user:user.name}" --output table

echo "== Resource providers"
for ns in Microsoft.Compute Microsoft.Network Microsoft.KeyVault; do
  state="$(az provider show --namespace "$ns" --query registrationState --output tsv)"
  echo "$ns: $state"
  if [[ "$state" != "Registered" ]]; then
    az provider register --namespace "$ns" --wait
  fi
done

echo "== VM size $GMF_VM_SIZE in $GMF_LOCATION"
az vm list-skus --location "$GMF_LOCATION" --size "$GMF_VM_SIZE" --resource-type virtualMachines \
  --query "[].{name:name, restrictions:restrictions[].reasonCode}" --output table
echo "An empty restrictions column means the size is available. If the list is empty or restricted, choose another size or region."
