#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export OPENCLAW_EXPRESS_BRIDGE_ROOT=$ROOT
exec "$ROOT/bin/openclaw-express-bridge" uninstall "$@"
