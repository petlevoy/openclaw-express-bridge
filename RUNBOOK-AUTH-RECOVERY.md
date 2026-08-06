# Runbook: eXpress authentication loss and recovery

Use this when the channel reports healthy services but no messages arrive,
logs repeat `official eXpress desktop client is not authenticated`, or an
outage started right after a renderer reload.

Key fact: the official client process stays `running` after the session is
lost. Process health never proves authentication health.

## Diagnose

1. Channel and services:
   ```bash
   openclaw channels status
   systemctl --user status openclaw-express-client.service openclaw-express-keyring.service
   ```
2. Find the authentication loss and the event immediately before it:
   ```bash
   journalctl --user -u openclaw-gateway.service -u openclaw-express-client.service \
     --since "48 hours ago" --no-pager -o short-iso |
     grep -iE "not authenticated|renderer|Memory Clean|reload|CDP|failed|inbound"
   ```
3. Read the official client log:
   ```bash
   grep -iE "Memory Clean|Window reloaded|error" \
     ~/.local/share/openclaw-express-bridge/profile/config/eXpress/log.log
   ```

## Recover

1. Expose the existing virtual display through a temporary VNC service. Do
   not drive the client through raw CDP or DOM automation while the bridge
   is running.
2. Log in manually in the GUI. If the QR code returns `Server error`, log in
   by phone number instead.
3. Confirm the persistent keyring was rewritten (do not print its contents):
   ```bash
   stat ~/.local/share/openclaw-express-bridge/profile/data/keyrings/login.keyring
   ```
4. While VNC is still available, run one controlled restart and verify the
   session survives it:
   ```bash
   systemctl --user restart openclaw-express-client.service
   ```
   Watch for at least 30 seconds: the service must stay active with no new
   `not authenticated` events. This proves the keyring restores the session.
5. Remove the temporary VNC service afterwards.

## Prevent renderer-triggered logout

The client's `electron/src/main/memoryCleaner.js` schedules a daily hard
renderer reload plus another one on high memory usage. Those reloads have
repeatedly dropped the authenticated session in headless deployments.

Apply the bundled patch (client stopped):

```bash
node tools/patch-client-disable-hard-reloads.mjs
```

It backs up the original `app.asar`, disables only the two hard-reload
schedulers, keeps the safe cache cleaner, verifies the repacked archive, and
swaps it atomically. `--restore` rolls back to the backup.

Re-apply after every official client update: an update replaces `app.asar`.
Keep the systemd memory limits; they bound the process now that hard reloads
are off.

## Monitor authentication, not the process

Install and enable the bundled timer:

```bash
systemctl --user enable --now openclaw-express-auth-watch.timer
```

`lib/express-auth-watch.sh` counts recent `not authenticated` log entries,
alerts once when a threshold is crossed (optionally via Telegram; token comes
from a file referenced by environment, never inlined), and sends a single
recovery notice when the errors stop.

## Dead ends already ruled out

- Auto-restarting a logged-out client does not restore the session; it only
  restarts the login screen.
- Process-liveness checks miss the failure entirely.
