#!/usr/bin/env bash
# Tests for deploy.sh using stubbed docker, git and sha256sum.
# Run: bash deploy/tests/deploy.test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
deploy_dir="$here/.."
failures=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "ok   - $label"
  else
    echo "FAIL - $label"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    failures=$((failures + 1))
  fi
}

state() { cat "$STUB_STATE/$1" 2> /dev/null || echo "<none>"; }
app_ups() { grep -c ' up .* app$' "$STUB_STATE/compose.log" 2> /dev/null || true; }

setup() {
  tmp="$(mktemp -d)"
  export STUB_STATE="$tmp/state"
  mkdir -p "$STUB_STATE" "$tmp/bin" "$tmp/app/deploy" "$tmp/data" "$tmp/run"
  cp "$here/stubs/docker" "$here/stubs/git" "$here/stubs/sha256sum" "$tmp/bin/"
  chmod +x "$tmp/bin/"*
  cp "$deploy_dir/deploy.sh" "$tmp/app/deploy/deploy.sh"
  printf '#!/usr/bin/env bash\necho "GMF_SMOKE_TEST=x" > "$GMF_ENV_OUT"\necho fetched >> "$STUB_STATE/fetch.log"\n' > "$tmp/app/deploy/fetch-secrets.sh"
  chmod +x "$tmp/app/deploy/"*.sh
  echo "GMF_HOST=example.test" > "$tmp/vm.env"
  export PATH="$tmp/bin:$PATH" GMF_VM_ENV="$tmp/vm.env" GMF_APP_DIR="$tmp/app" \
    GMF_DATA_DIR="$tmp/data" GMF_ENV_OUT="$tmp/run/app.env" GMF_HEALTH_TIMEOUT=3
  unset STUB_NEW_HEALTH STUB_EXEC_EXIT
}

run_deploy() {
  if bash "$tmp/app/deploy/deploy.sh" > "$tmp/out.log" 2>&1; then rc=0; else rc=$?; fi
}

setup

# 1. First deploy on an empty host.
echo "sha256:aaa" > "$STUB_STATE/latest_id"
run_deploy
check "first deploy succeeds" "0" "$rc"
check "first deploy runs the latest image" "sha256:aaa" "$(state current_id)"
check "first deploy recreates the app once" "1" "$(app_ups)"

# 2. Nothing changed: no new app container.
run_deploy
check "unchanged image is a no-op" "0" "$rc"
check "unchanged image does not recreate the app" "1" "$(app_ups)"

# 2b. A run with nothing new does not read the secrets again; a stale copy, a changed image or --refresh-secrets does.
fetches() { grep -c fetched "$STUB_STATE/fetch.log" 2> /dev/null || true; }
before="$(fetches)"
run_deploy
check "a run with nothing new makes no Key Vault call" "$before" "$(fetches)"
touch -t 202001010000 "$tmp/run/app.env"
run_deploy
check "a saved copy older than the limit is read again" "$((before + 1))" "$(fetches)"
bash "$tmp/app/deploy/deploy.sh" --refresh-secrets > "$tmp/out.log" 2>&1
check "--refresh-secrets reads them again" "$((before + 2))" "$(fetches)"
if bash "$tmp/app/deploy/deploy.sh" --bogus > "$tmp/out.log" 2>&1; then rc=0; else rc=$?; fi
check "an unknown argument is refused" "2" "$rc"

# 3. A healthy update takes a database backup and keeps the previous image.
touch "$tmp/data/gmf.sqlite"
echo "sha256:bbb" > "$STUB_STATE/latest_id"
run_deploy
check "healthy update succeeds" "0" "$rc"
check "healthy update runs the new image" "sha256:bbb" "$(state current_id)"
check "healthy update remembers the previous image" "sha256:aaa" "$(state previous_id)"
check "healthy update backs up the database first" "1" "$(grep -c 'VACUUM INTO' "$STUB_STATE/exec.log")"

# 4. An unhealthy update rolls back and records the bad image.
echo "sha256:ccc" > "$STUB_STATE/latest_id"
export STUB_NEW_HEALTH=unhealthy
run_deploy
check "unhealthy update fails the deploy" "1" "$rc"
check "unhealthy update rolls back to the previous image" "sha256:bbb" "$(state current_id)"
check "unhealthy update marks the image as bad" "sha256:ccc" "$(cat "$tmp/data/.failed-image-id")"

# 5. The known-bad image is not retried.
before="$(app_ups)"
run_deploy
check "known bad image is skipped without error" "0" "$rc"
check "known bad image does not recreate the app" "$before" "$(app_ups)"

# 6. A newer image after a failure is deployed and clears the marker.
echo "sha256:ddd" > "$STUB_STATE/latest_id"
export STUB_NEW_HEALTH=healthy
run_deploy
check "newer image after a failure deploys" "0" "$rc"
check "newer image becomes current" "sha256:ddd" "$(state current_id)"
check "failure marker is cleared" "no" "$([[ -f "$tmp/data/.failed-image-id" ]] && echo yes || echo no)"

# 7. A failed backup of a healthy app aborts the deploy.
echo "sha256:eee" > "$STUB_STATE/latest_id"
export STUB_EXEC_EXIT=1
run_deploy
check "failed backup aborts the deploy" "1" "$rc"
check "failed backup leaves the current image running" "sha256:ddd" "$(state current_id)"

# 8. Old pre-deploy backups are pruned to the configured count.
unset STUB_EXEC_EXIT
mkdir -p "$tmp/data/backups"
for n in 1 2 3 4; do
  touch -t "20260101010${n}" "$tmp/data/backups/pre-deploy-$n.sqlite"
done
export GMF_KEEP_BACKUPS=2
echo "sha256:fff" > "$STUB_STATE/latest_id"
run_deploy
check "update after a failed backup deploys once the backup works" "0" "$rc"
check "keeps only the newest backups" "pre-deploy-3.sqlite pre-deploy-4.sqlite" "$(ls "$tmp/data/backups" | tr '\n' ' ' | sed 's/ $//')"

if (( failures > 0 )); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
