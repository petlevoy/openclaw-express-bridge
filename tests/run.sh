#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
echo "[1/7] shell syntax"
bash -n "$ROOT/bin/openclaw-express-bridge" "$ROOT/install.sh" "$ROOT/uninstall.sh" \
  "$ROOT/lib/common.sh" "$ROOT/lib/express-keyring-service.sh" "$ROOT/build.sh" \
  "$ROOT/tests/scan-secrets.sh"

echo "[2/7] node helper syntax"
node --check "$ROOT/helpers/cdp-screenshot.mjs"
node --check "$ROOT/tools/generate-desktop-routing.mjs"
node --check "$ROOT/tools/create-isolated-agent.mjs"
generator_input=$(mktemp)
generator_output=$(mktemp)
agent_input=$(mktemp)
agent_output=$(mktemp)
agent_root=$(mktemp -d)
trap 'rm -f "$generator_input" "$generator_output" "$agent_input" "$agent_output"; rm -rf "$agent_root"' EXIT
printf '%s\n' \
  '[{"chatId":"00000000-0000-4000-8000-000000000001","chatTitle":"Fixture","senderId":"00000000-0000-4000-8000-000000000002","agentId":"fixture-agent"},{"chatId":"00000000-0000-4000-8000-000000000003","chatTitle":"Disabled","senderId":"00000000-0000-4000-8000-000000000004","agentId":"disabled-agent","enabled":false}]' \
  >"$generator_input"
node "$ROOT/tools/generate-desktop-routing.mjs" "$generator_input" >"$generator_output"
node - "$generator_output" <<'NODE'
const fs = require("node:fs");
const output = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (output.channels.express.desktopChats.length !== 2) process.exit(1);
if (output.channels.express.allowFrom.length !== 2) process.exit(1);
if (output.channels.express.allowFrom.some((id) => id.endsWith("000004"))) process.exit(1);
if (output.bindings.length !== 1 || output.bindings[0].agentId !== "fixture-agent") process.exit(1);
NODE
printf '%s\n' \
  '{"agentId":"fixture-agent","agentName":"Fixture Assistant","userDisplayName":"Fixture User"}' \
  >"$agent_input"
node "$ROOT/tools/create-isolated-agent.mjs" "$agent_input" "$agent_root" >"$agent_output"
node - "$agent_output" "$agent_root" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const output = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = process.argv[3];
if (output.agent.id !== "fixture-agent") process.exit(1);
if (output.agent.workspace !== path.join(root, "fixture-agent", "workspace")) process.exit(1);
if (output.agent.sandbox?.docker?.network !== "none") process.exit(1);
if (!output.agent.tools?.deny?.includes("message")) process.exit(1);
if (!fs.statSync(output.agent.workspace).isDirectory()) process.exit(1);
if ((fs.statSync(output.agent.workspace).mode & 0o777) !== 0o700) process.exit(1);
if ((fs.statSync(path.join(output.agent.workspace, "AGENTS.md")).mode & 0o777) !== 0o600) process.exit(1);
NODE
if node "$ROOT/tools/create-isolated-agent.mjs" "$agent_input" "$agent_root" >/dev/null 2>&1; then
  echo "FAIL: agent creator overwrote an existing target" >&2
  exit 1
fi

echo "[3/7] unit validation"
unit_output=$(systemd-analyze verify "$ROOT/systemd/"*.service 2>&1 || true)
if grep -Eiq '(failed to parse|unknown lvalue|invalid section|bad unit setting)' <<<"$unit_output"; then
  printf '%s\n' "$unit_output" >&2
  exit 1
fi
echo "OK: unit files parsed (missing runtime paths are expected before install)"

echo "[4/7] CLI smoke and dry-run installer"
test "$(OPENCLAW_EXPRESS_BRIDGE_ROOT="$ROOT" "$ROOT/bin/openclaw-express-bridge" version)" = "1.1.16"
OPENCLAW_EXPRESS_BRIDGE_ROOT="$ROOT" "$ROOT/bin/openclaw-express-bridge" --help >/dev/null
smoke_home=$(mktemp -d)
trap 'rm -rf "$smoke_home" "$agent_root"; rm -f "$generator_input" "$generator_output" "$agent_input" "$agent_output"' EXIT
XDG_DATA_HOME="$smoke_home/data" XDG_STATE_HOME="$smoke_home/state" \
  XDG_CONFIG_HOME="$smoke_home/config" OPENCLAW_HOME="$smoke_home/openclaw" \
  OPENCLAW_EXPRESS_BRIDGE_HOME="$smoke_home/bridge" \
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
