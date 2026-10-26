#!/usr/bin/env bash
# One-time setup on the VM: installs the systemd units that run the deploy.
set -euo pipefail

SRC=/opt/gmf/deploy/systemd

chmod 0755 /opt/gmf/deploy/deploy.sh /opt/gmf/deploy/fetch-secrets.sh
install -m 0644 "$SRC/gmf-deploy.service" /etc/systemd/system/gmf-deploy.service
install -m 0644 "$SRC/gmf-deploy.timer" /etc/systemd/system/gmf-deploy.timer
systemctl daemon-reload
systemctl enable --now gmf-deploy.timer
