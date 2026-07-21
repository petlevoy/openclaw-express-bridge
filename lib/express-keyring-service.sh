#!/usr/bin/env bash
set -euo pipefail

data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
bridge_home=${OPENCLAW_EXPRESS_BRIDGE_HOME:-"$data_home/openclaw-express-bridge"}
credential="$bridge_home/credentials/keyring-password"
control="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/openclaw-express-keyring"

[[ -s "$credential" ]] || { echo "eXpress keyring credential is missing" >&2; exit 1; }

install -d -m 700 "$control" "$bridge_home/profile/data/keyrings"
export GNOME_KEYRING_CONTROL="$control"
export XDG_DATA_HOME="$bridge_home/profile/data"

/usr/bin/gnome-keyring-daemon --login --components=secrets \
  --control-directory="$control" < "$credential" >/dev/null
/usr/bin/gnome-keyring-daemon --start --components=secrets \
  --control-directory="$control" >/dev/null

daemon_pid=""
for _ in {1..50}; do
  daemon_pid=$(ps -u "$(id -u)" -o pid=,args= | awk -v marker="--control-directory=$control" \
    '$0 ~ /gnome-keyring-daemon/ && index($0, marker) { print $1; exit }')
  [[ -n "$daemon_pid" ]] && break
  sleep 0.1
done
[[ -n "$daemon_pid" ]] || { echo "eXpress secret-service daemon did not start" >&2; exit 1; }

for _ in {1..50}; do
  if /usr/bin/busctl --user --no-pager list 2>/dev/null | \
    /usr/bin/awk '$1 == "org.freedesktop.secrets" { found = 1 } END { exit !found }'; then
    [[ -z "${NOTIFY_SOCKET:-}" ]] || /usr/bin/systemd-notify --ready \
      --status="eXpress Secret Service is ready"
    while kill -0 "$daemon_pid" 2>/dev/null; do sleep 5; done
    exit 1
  fi
  sleep 0.1
done
echo "eXpress secret-service bus name is not ready" >&2
exit 1
