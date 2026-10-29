#!/usr/bin/env bash
# Starts a deploy on the VM now, without waiting for the webhook or the 30-minute timer, and prints its log.
# Usage: infra/azure/deploy-now.sh [--refresh-secrets]
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"

flag="${1:-}"
case "$flag" in
  "" | --refresh-secrets) ;;
  *) echo "usage: deploy-now.sh [--refresh-secrets]" >&2; exit 2 ;;
esac

az vm run-command invoke -g "$GMF_RG" -n "$GMF_VM_NAME" --command-id RunShellScript \
  --scripts "/opt/gmf/deploy/deploy.sh $flag; journalctl -u gmf-deploy --no-pager -n 5" \
  --query "value[0].message" -o tsv
