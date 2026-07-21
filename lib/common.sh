#!/usr/bin/env bash
set -euo pipefail

bridge_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

bridge_note() {
  printf '%s\n' "$*"
}

bridge_have() {
  command -v "$1" >/dev/null 2>&1
}

bridge_require() {
  local item
  for item in "$@"; do
    bridge_have "$item" || bridge_die "required command is missing: $item"
  done
}

bridge_is_uuid() {
  [[ "${1:-}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]
}

bridge_resolve_root() {
  if [[ -n "${OPENCLAW_EXPRESS_BRIDGE_ROOT:-}" ]]; then
    printf '%s\n' "$OPENCLAW_EXPRESS_BRIDGE_ROOT"
    return
  fi
  local self candidate
  self=$(readlink -f "${BASH_SOURCE[1]}")
  candidate=$(cd "$(dirname "$self")/.." && pwd)
  if [[ -d "$candidate/plugin" ]]; then
    printf '%s\n' "$candidate"
  else
    printf '%s\n' /usr/lib/openclaw-express-bridge
  fi
}

bridge_json_quote() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

bridge_config_get() {
  openclaw config get "$1" 2>/dev/null || true
}

bridge_restart_gateway() {
  if systemctl --user list-unit-files openclaw-gateway.service >/dev/null 2>&1; then
    systemctl --user restart openclaw-gateway.service
  else
    bridge_note "Gateway unit not found; restart OpenClaw manually."
  fi
}
