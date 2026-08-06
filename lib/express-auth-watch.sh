#!/usr/bin/env bash
# Alert when the official eXpress client loses authentication.
#
# The client process stays `running` after a lost session, so process health
# is not authentication health. This check reads recent gateway logs for the
# bridge's `not authenticated` marker, keeps a small state file, and sends one
# alert when the failure threshold is crossed plus one recovery notice when
# the errors disappear.
#
# Configuration (environment, e.g. via the systemd unit):
#   AUTH_WATCH_JOURNAL_UNIT   journal unit to scan  (default: openclaw-gateway.service)
#   AUTH_WATCH_SINCE          journal window        (default: -5 min)
#   AUTH_WATCH_THRESHOLD      errors to alert on    (default: 3)
#   AUTH_WATCH_MARKER         log marker to count
#   AUTH_WATCH_STATE_FILE     state path            (default: $XDG_STATE_HOME/openclaw-express-bridge/auth-watch.state)
#   AUTH_WATCH_TELEGRAM_TOKEN_FILE  file whose first line is a Telegram bot token
#   AUTH_WATCH_TELEGRAM_CHAT_ID     Telegram chat id to notify
#
# Without Telegram settings the alert is only logged, which still surfaces in
# `journalctl --user -u openclaw-express-auth-watch.service`.
set -euo pipefail

unit=${AUTH_WATCH_JOURNAL_UNIT:-openclaw-gateway.service}
since=${AUTH_WATCH_SINCE:--5 min}
threshold=${AUTH_WATCH_THRESHOLD:-3}
marker=${AUTH_WATCH_MARKER:-"official eXpress desktop client is not authenticated"}
state_home=${XDG_STATE_HOME:-"$HOME/.local/state"}
state_file=${AUTH_WATCH_STATE_FILE:-"$state_home/openclaw-express-bridge/auth-watch.state"}

count=$(journalctl --user -u "$unit" --since "$since" --no-pager -o cat 2>/dev/null |
  grep -cF "$marker" || true)

previous=ok
[[ -f "$state_file" ]] && previous=$(<"$state_file")

notify() {
  local text=$1
  printf '%s\n' "$text"
  if [[ -n "${AUTH_WATCH_TELEGRAM_TOKEN_FILE:-}" && -n "${AUTH_WATCH_TELEGRAM_CHAT_ID:-}" ]]; then
    local token
    token=$(head -n 1 "$AUTH_WATCH_TELEGRAM_TOKEN_FILE")
    curl -fsS --max-time 20 \
      --data-urlencode "chat_id=$AUTH_WATCH_TELEGRAM_CHAT_ID" \
      --data-urlencode "text=$text" \
      "https://api.telegram.org/bot$token/sendMessage" >/dev/null ||
      printf 'WARNING: Telegram alert delivery failed\n' >&2
  fi
}

install -d -m 700 "$(dirname "$state_file")"
if (( count >= threshold )); then
  if [[ "$previous" != alerting ]]; then
    notify "eXpress bridge: client is NOT authenticated ($count errors in $since). Log in via the recovery runbook."
    printf 'alerting\n' >"$state_file"
  fi
else
  if [[ "$previous" == alerting ]]; then
    notify "eXpress bridge: authentication recovered, no new errors."
  fi
  printf 'ok\n' >"$state_file"
fi
