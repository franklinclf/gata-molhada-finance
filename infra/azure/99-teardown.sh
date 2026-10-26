#!/usr/bin/env bash
# Deletes the whole resource group (VM, disk, IP, network, Key Vault). Asks for confirmation.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"

read -r -p "Type the resource group name ($GMF_RG) to delete everything in it: " answer
if [[ "$answer" != "$GMF_RG" ]]; then
  echo "Aborted."
  exit 1
fi

az group delete --name "$GMF_RG" --yes --no-wait
echo "Deletion started. A deleted Key Vault keeps its name for 7 days; to reuse the name run:"
echo "  az keyvault purge --name ${GMF_KEYVAULT:-<vault>} --location $GMF_LOCATION"
