#!/usr/bin/env bash
# Pull-based deploy. Fetches secrets, pulls the image, switches the app
# container and rolls back to the previous image if the new one is not healthy.
set -euo pipefail

VM_ENV="${GMF_VM_ENV:-/etc/gmf/vm.env}"
APP_DIR="${GMF_APP_DIR:-/opt/gmf}"
DATA_DIR="${GMF_DATA_DIR:-/var/lib/gmf}"
ENV_OUT="${GMF_ENV_OUT:-/run/gmf/app.env}"
IMAGE_REPO="${GMF_IMAGE_REPO:-ghcr.io/franklinclf/gata-molhada-finance}"
HEALTH_TIMEOUT="${GMF_HEALTH_TIMEOUT:-60}"
KEEP_BACKUPS="${GMF_KEEP_BACKUPS:-5}"
FAILED_MARKER="$DATA_DIR/.failed-image-id"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Update the deploy files first, then restart this script so it runs the new version.
if [[ "${1:-}" != "--no-pull" ]]; then
  git -C "$APP_DIR" pull --ff-only --quiet || log "git pull failed, using the current deploy files"
  exec "$0" --no-pull
fi

# shellcheck disable=SC1090
source "$VM_ENV"
export GMF_HOST

compose() { docker compose --env-file "$VM_ENV" -f "$APP_DIR/deploy/docker-compose.yml" "$@"; }

wait_healthy() {
  local waited=0 status
  while (( waited < HEALTH_TIMEOUT )); do
    status="$(docker inspect -f '{{.State.Health.Status}}' gmf-app 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    [[ "$status" == "unhealthy" ]] && return 1
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

"$APP_DIR/deploy/fetch-secrets.sh"
env_hash="$(sha256sum "$ENV_OUT" | cut -d' ' -f1)"

docker pull --quiet "$IMAGE_REPO:latest" > /dev/null
new_id="$(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:latest")"
cur_id="$(docker inspect -f '{{.Image}}' gmf-app 2>/dev/null || true)"
cur_health="$(docker inspect -f '{{.State.Health.Status}}' gmf-app 2>/dev/null || true)"
cur_env_hash="$(docker inspect -f '{{index .Config.Labels "gmf.env-hash"}}' gmf-app 2>/dev/null || true)"

if [[ -f "$FAILED_MARKER" && "$(cat "$FAILED_MARKER")" == "$new_id" ]]; then
  log "image $new_id already failed its health check; waiting for a newer one"
  compose up -d --no-deps caddy > /dev/null
  exit 0
fi

if [[ "$new_id" == "$cur_id" && "$cur_health" == "healthy" && "$env_hash" == "$cur_env_hash" ]]; then
  compose up -d --no-deps caddy > /dev/null
  exit 0
fi

if [[ -n "$cur_id" && -f "$DATA_DIR/gmf.sqlite" ]]; then
  mkdir -p "$DATA_DIR/backups"
  backup="/data/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  if ! docker exec gmf-app node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/gmf.sqlite');d.exec(\"VACUUM INTO '${backup}'\");d.close()"; then
    if [[ "$cur_health" == "healthy" ]]; then
      log "database backup failed while the current version is healthy; aborting the deploy"
      exit 1
    fi
    log "database backup failed, but the current version is not healthy; continuing"
  fi
fi

if [[ -n "$cur_id" ]]; then
  docker tag "$cur_id" gmf-rollback:previous
fi

log "deploying $new_id"
export GMF_ENV_HASH="$env_hash"
compose up -d --no-deps --force-recreate app

if ! wait_healthy; then
  log "new version failed its health check; rolling back"
  docker logs --tail 50 gmf-app || true
  echo "$new_id" > "$FAILED_MARKER"
  if docker image inspect gmf-rollback:previous > /dev/null 2>&1; then
    GMF_IMAGE=gmf-rollback:previous compose up -d --no-deps --force-recreate app
    log "rolled back to the previous image"
  else
    log "no previous image to roll back to"
  fi
  exit 1
fi

rm -f "$FAILED_MARKER"
compose up -d --no-deps caddy > /dev/null

# shellcheck disable=SC2012
{ ls -1t "$DATA_DIR"/backups/pre-deploy-*.sqlite 2> /dev/null || true; } | tail -n +"$((KEEP_BACKUPS + 1))" | while IFS= read -r old; do
  rm -f -- "$old"
done
log "deployed $new_id"
