#!/usr/bin/env bash
set -euo pipefail

target=${1:-.}
[[ -e "$target" ]] || { echo "scan target missing: $target" >&2; exit 2; }

pattern='(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|[Bb]earer[[:space:]]+[A-Za-z0-9._-]{24,})'

# A missing scanner used to make the `if` condition false, which fell through
# to the success message: the gate reported "clean" without reading a byte.
# Choose an available scanner explicitly and treat every other outcome as a
# failure, so a broken gate can never be mistaken for a passing one.
if command -v rg >/dev/null 2>&1; then
  scan() {
    rg -n -I --hidden --glob '!**/node_modules/**' --glob '!**/package-lock.json' \
      --glob '!*.AppImage' --glob '!*.deb' --glob '!*.tar.gz' -e "$pattern" "$target"
  }
elif command -v grep >/dev/null 2>&1; then
  scan() {
    grep -rIn -E --binary-files=without-match \
      --exclude-dir=node_modules --exclude=package-lock.json \
      --exclude='*.AppImage' --exclude='*.deb' --exclude='*.tar.gz' \
      -e "$pattern" "$target"
  }
else
  echo "FAIL: no secret scanner available (install ripgrep or grep)" >&2
  exit 2
fi

set +e
matches=$(scan)
status=$?
set -e

if [[ $status -eq 0 ]]; then
  printf '%s\n' "$matches" >&2
  echo "FAIL: possible credential or deployment-specific identifier found" >&2
  exit 1
fi
if [[ $status -ne 1 ]]; then
  echo "FAIL: secret scanner exited with status $status" >&2
  exit 2
fi
echo "OK: no known identifiers, private keys, or common token forms in $target"
