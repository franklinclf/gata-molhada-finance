#!/usr/bin/env bash
# Tests for set-secret.sh with a stubbed az. Run: bash infra/azure/tests/set-secret.test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../set-secret.sh"
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

tmp="$(mktemp -d)"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/az" << 'EOF'
#!/usr/bin/env bash
echo "$*" >> "$AZ_LOG"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--file" ]]; then
    cp "$2" "$AZ_CAPTURE"
    ls -l "$2" | cut -c1-10 > "$AZ_CAPTURE.perms"
  fi
  shift
done
EOF
chmod +x "$tmp/bin/az"
export PATH="$tmp/bin:$PATH" AZ_LOG="$tmp/az.log" AZ_CAPTURE="$tmp/captured" GMF_KEYVAULT=kv-test

printf 'sk-secret-value\n' | bash "$script" PLUGGY-CLIENT-ID > /dev/null 2>&1
check "passes the value through a file" "sk-secret-value" "$(cat "$tmp/captured")"
check "the temporary file is private" "-rw-------" "$(cat "$tmp/captured.perms")"
check "the value never appears in the az arguments" "0" "$(grep -c 'sk-secret-value' "$tmp/az.log" || true)"
check "targets the right vault and name" "1" "$(grep -c -- '--vault-name kv-test --name PLUGGY-CLIENT-ID' "$tmp/az.log")"

if printf 'x\n' | bash "$script" bad_name > /dev/null 2>&1; then rc=0; else rc=$?; fi
check "rejects invalid names" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

if printf '\n' | bash "$script" EMPTY-VALUE > /dev/null 2>&1; then rc=0; else rc=$?; fi
check "rejects an empty value" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

if GMF_KEYVAULT= bash "$script" ANY-NAME < /dev/null > /dev/null 2>&1; then rc=0; else rc=$?; fi
check "requires GMF_KEYVAULT" "nonzero" "$([[ $rc -ne 0 ]] && echo nonzero || echo zero)"

if (( failures > 0 )); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
