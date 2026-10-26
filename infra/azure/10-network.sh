#!/usr/bin/env bash
# Resource group, static public IP with a DNS label, and the network security group.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
require GMF_DNS_LABEL

az group create --name "$GMF_RG" --location "$GMF_LOCATION" --output none

az network public-ip create --resource-group "$GMF_RG" --name "$GMF_PIP_NAME" --location "$GMF_LOCATION" \
  --sku Standard --allocation-method Static --dns-name "$GMF_DNS_LABEL" --output none

az network nsg create --resource-group "$GMF_RG" --name "$GMF_NSG_NAME" --location "$GMF_LOCATION" --output none

az network nsg rule create --resource-group "$GMF_RG" --nsg-name "$GMF_NSG_NAME" --name allow-web \
  --priority 100 --direction Inbound --access Allow --protocol Tcp \
  --source-address-prefixes Internet --destination-port-ranges 80 443 --output none

# SSH stays closed unless an admin IP is given. Without it, use `az vm run-command` for maintenance.
if [[ -n "$GMF_ADMIN_IP" ]]; then
  az network nsg rule create --resource-group "$GMF_RG" --nsg-name "$GMF_NSG_NAME" --name allow-ssh-admin \
    --priority 110 --direction Inbound --access Allow --protocol Tcp \
    --source-address-prefixes "$GMF_ADMIN_IP/32" --destination-port-ranges 22 --output none
fi

az network public-ip show --resource-group "$GMF_RG" --name "$GMF_PIP_NAME" \
  --query "{ip:ipAddress, fqdn:dnsSettings.fqdn}" --output table
