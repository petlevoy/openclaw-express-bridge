#!/usr/bin/env bash
set -euo pipefail

target=${1:-.}
[[ -e "$target" ]] || { echo "scan target missing: $target" >&2; exit 2; }

pattern='(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|[Bb]earer[[:space:]]+[A-Za-z0-9._-]{24,})'

if rg -n -I --hidden --glob '!**/node_modules/**' --glob '!**/package-lock.json' \
  --glob '!*.AppImage' --glob '!*.deb' --glob '!*.tar.gz' -e "$pattern" "$target"; then
  echo "FAIL: possible credential or deployment-specific identifier found" >&2
  exit 1
fi
echo "OK: no known identifiers, private keys, or common token forms in $target"
