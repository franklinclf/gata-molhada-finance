#!/usr/bin/env bash
# The VM: Ubuntu 24.04, system-assigned identity, cloud-init that clones the repo and installs the deploy timer.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
require GMF_DNS_LABEL GMF_KEYVAULT

if [[ ! -f "$GMF_SSH_PUBKEY" ]]; then
  echo "SSH public key not found: $GMF_SSH_PUBKEY (create one with: ssh-keygen -t ed25519 -f ${GMF_SSH_PUBKEY%.pub})" >&2
  exit 1
fi

host="${GMF_DNS_LABEL}.${GMF_LOCATION}.cloudapp.azure.com"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
sed -e "s/__HOST__/${host}/g" -e "s/__KEYVAULT__/${GMF_KEYVAULT}/g" "$(dirname "$0")/cloud-init.yaml" > "$rendered"

az vm create --resource-group "$GMF_RG" --name "$GMF_VM_NAME" --location "$GMF_LOCATION" \
  --image Canonical:ubuntu-24_04-lts:server:latest --size "$GMF_VM_SIZE" \
  --admin-username "$GMF_ADMIN_USER" --ssh-key-values "$GMF_SSH_PUBKEY" --authentication-type ssh \
  --public-ip-address "$GMF_PIP_NAME" --nsg "$GMF_NSG_NAME" \
  --assign-identity '[system]' --custom-data "$rendered" \
  --os-disk-size-gb 30 --storage-sku Standard_LRS \
  --os-disk-delete-option Delete --nic-delete-option Delete --output none

principal_id="$(az vm show --resource-group "$GMF_RG" --name "$GMF_VM_NAME" --query identity.principalId --output tsv)"
kv_id="$(az keyvault show --name "$GMF_KEYVAULT" --query id --output tsv)"

az role assignment create --assignee-object-id "$principal_id" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$kv_id" --output none

echo "VM created. The app will be served at https://$host once the first image is published."
