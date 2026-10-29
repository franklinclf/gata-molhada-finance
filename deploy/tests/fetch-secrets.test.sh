#!/usr/bin/env bash
# Tests for fetch-secrets.sh using a stubbed curl. Run: bash deploy/tests/fetch-secrets.test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../fetch-secrets.sh"
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

new_env() {
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/bin" "$tmp/run"
  cp "$here/stubs/curl" "$tmp/bin/curl"
  chmod +x "$tmp/bin/curl"
  echo "GMF_KEYVAULT=kv-test" > "$tmp/vm.env"
  export PATH="$tmp/bin:$PATH" GMF_VM_ENV="$tmp/vm.env" GMF_ENV_OUT="$tmp/run/app.env" GMF_SECRETS_LIST="$tmp/secrets.list"
}

# 1. Reads secrets, skips comments and blanks, maps dashes to underscores.
new_env
printf '# comment\n\nPLUGGY-CLIENT-ID\nGMF-SMOKE-TEST\n' > "$GMF_SECRETS_LIST"
bash "$script"
check "writes mapped variable names and values" \
  $'PLUGGY_CLIENT_ID=\'value-of-PLUGGY-CLIENT-ID\'\nGMF_SMOKE_TEST=\'value-of-GMF-SMOKE-TEST\'' "$(cat "$GMF_ENV_OUT")"
check "output file is readable only by the owner" "-rw-------" "$(ls -l "$GMF_ENV_OUT" | cut -c1-10)"

# 2. A missing secret fails and keeps the previous file untouched.
new_env
echo "OLD=1" > "$GMF_ENV_OUT"
printf 'GOOD-SECRET\nMISSING-SECRET\n' > "$GMF_SECRETS_LIST"
if bash "$script" 2> /dev/null; then rc=0; else rc=$?; fi
check "fails when a secret cannot be read" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"
check "keeps the previous environment file" "OLD=1" "$(cat "$GMF_ENV_OUT")"
check "leaves no temporary files behind" "app.env" "$(ls "$tmp/run")"

# 3. Rejects invalid names and multi-line values.
new_env
printf 'bad_name\n' > "$GMF_SECRETS_LIST"
if bash "$script" 2> /dev/null; then rc=0; else rc=$?; fi
check "rejects a name with underscores" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

new_env
printf 'MULTILINE-SECRET\n' > "$GMF_SECRETS_LIST"
if bash "$script" 2> /dev/null; then rc=0; else rc=$?; fi
check "rejects a multi-line value" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

new_env
printf 'QUOTE-SECRET\n' > "$GMF_SECRETS_LIST"
if bash "$script" 2> /dev/null; then rc=0; else rc=$?; fi
check "rejects a value with a single quote" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

# 4. A secret marked optional ("NAME?") is skipped when it does not exist, but other failures still stop the run.
new_env
printf 'GOOD-SECRET\nOPTIONAL-MISSING?\nOTHER-SECRET?\n' > "$GMF_SECRETS_LIST"
bash "$script"
check "skips an optional secret the vault does not have" $'GOOD_SECRET=\'value-of-GOOD-SECRET\'\nOTHER_SECRET=\'value-of-OTHER-SECRET\'' "$(cat "$GMF_ENV_OUT")"
check "leaves no temporary files behind after a run" "app.env" "$(ls "$tmp/run")"

new_env
printf 'MISSING-SECRET\n' > "$GMF_SECRETS_LIST"
if bash "$script" 2> /dev/null; then rc=0; else rc=$?; fi
check "a missing secret that is not optional still fails" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

new_env
printf 'BROKEN-SECRET?\n' > "$GMF_SECRETS_LIST"
if bash "$script" 2> /dev/null; then rc=0; else rc=$?; fi
check "an optional secret with a server error still fails" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

if (( failures > 0 )); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
