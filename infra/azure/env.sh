#!/usr/bin/env bash
# Shared settings for the Azure scripts. Override any value from the environment.
export GMF_LOCATION="${GMF_LOCATION:-chilecentral}"
export GMF_RG="${GMF_RG:-rg-gmf}"
export GMF_VM_NAME="${GMF_VM_NAME:-vm-gmf}"
export GMF_VM_SIZE="${GMF_VM_SIZE:-Standard_B2ats_v2}"
export GMF_ADMIN_USER="${GMF_ADMIN_USER:-azureuser}"
export GMF_SSH_PUBKEY="${GMF_SSH_PUBKEY:-$HOME/.ssh/id_ed25519_gmf_vm.pub}"
export GMF_PIP_NAME="${GMF_PIP_NAME:-pip-gmf}"
export GMF_NSG_NAME="${GMF_NSG_NAME:-nsg-gmf}"
export GMF_ADMIN_IP="${GMF_ADMIN_IP:-}"

# Exits with a message if any of the named variables is empty.
require() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      echo "Set $name before running this script." >&2
      exit 1
    fi
  done
}
