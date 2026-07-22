#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
echo "[1/7] shell syntax"
bash -n "$ROOT/bin/openclaw-express-bridge" "$ROOT/install.sh" "$ROOT/uninstall.sh" \
  "$ROOT/lib/common.sh" "$ROOT/lib/express-keyring-service.sh" "$ROOT/build.sh" \
  "$ROOT/tests/scan-secrets.sh"

echo "[2/7] node helper syntax"
node --check "$ROOT/helpers/cdp-screenshot.mjs"

echo "[3/7] unit validation"
unit_output=$(systemd-analyze verify "$ROOT/systemd/"*.service 2>&1 || true)
if grep -Eiq '(failed to parse|unknown lvalue|invalid section|bad unit setting)' <<<"$unit_output"; then
  printf '%s\n' "$unit_output" >&2
  exit 1
fi
echo "OK: unit files parsed (missing runtime paths are expected before install)"

echo "[4/7] CLI smoke and dry-run installer"
test "$(OPENCLAW_EXPRESS_BRIDGE_ROOT="$ROOT" "$ROOT/bin/openclaw-express-bridge" version)" = "1.1.1"
OPENCLAW_EXPRESS_BRIDGE_ROOT="$ROOT" "$ROOT/bin/openclaw-express-bridge" --help >/dev/null
smoke_home=$(mktemp -d)
trap 'rm -rf "$smoke_home"' EXIT
HOME="$smoke_home" XDG_DATA_HOME="$smoke_home/data" XDG_STATE_HOME="$smoke_home/state" \
  XDG_CONFIG_HOME="$smoke_home/config" OPENCLAW_HOME="$smoke_home/openclaw" \
  OPENCLAW_EXPRESS_BRIDGE_ROOT="$ROOT" \
  "$ROOT/bin/openclaw-express-bridge" install --dry-run | tee "$smoke_home/dry-run.log"
grep -q 'outbound=false' "$smoke_home/dry-run.log"
test ! -e "$smoke_home/openclaw"

echo "[5/7] fail-closed and loopback-only assertions"
grep -q 'desktopOutboundEnabled.*False' "$ROOT/bin/openclaw-express-bridge"
grep -q 'rm -f.*SWITCH_PATH' "$ROOT/bin/openclaw-express-bridge"
grep -q -- '--remote-debugging-address=127.0.0.1' "$ROOT/systemd/openclaw-express-client.service"
! grep -REq '(0\.0\.0\.0|desktopOutboundEnabled.*True)' "$ROOT/systemd" "$ROOT/client.env"

echo "[6/7] secret scan"
"$ROOT/tests/scan-secrets.sh" "$ROOT"

echo "[7/7] optional ShellCheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x "$ROOT/bin/openclaw-express-bridge" "$ROOT/install.sh" "$ROOT/uninstall.sh" \
    "$ROOT/lib/common.sh" "$ROOT/lib/express-keyring-service.sh" "$ROOT/build.sh" \
    "$ROOT/tests/scan-secrets.sh"
else
  echo "SKIP: shellcheck not installed"
fi
echo "OK: packaging smoke tests passed"
