#!/usr/bin/env bash
set -euo pipefail

runtime_root=${XDG_RUNTIME_DIR:-"/run/user/$(id -u)"}
runtime_dir="$runtime_root/openclaw-express-xvfb"
authority="$runtime_dir/Xauthority"
temporary="$runtime_dir/.Xauthority.$$"

install -d -m 700 "$runtime_dir"
trap 'rm -f "$temporary"' EXIT
umask 077
cookie=$(/usr/bin/mcookie)
/usr/bin/xauth -f "$temporary" add :97 MIT-MAGIC-COOKIE-1 "$cookie"
chmod 600 "$temporary"
mv -f "$temporary" "$authority"
trap - EXIT

exec /usr/bin/Xvfb :97 -screen 0 1600x1000x24 -nolisten tcp -auth "$authority"
