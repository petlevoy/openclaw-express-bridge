# openclaw-express-bridge 1.0.1

An installable, fail-closed bridge between OpenClaw and the official eXpress
Linux desktop client. It runs the client headlessly on an isolated Xvfb display,
uses a dedicated profile/keyring, and exposes Chrome DevTools Protocol only on
`127.0.0.1:18997`. The bundled OpenClaw channel plugin reads and sends messages
through that local desktop session.

This is an independent integration, not an official eXpress product.

## Supported platform

- Ubuntu/Debian, amd64
- systemd user services and a user D-Bus session
- OpenClaw already installed and available as `openclaw`
- Node.js 22.22.3+, 24.15.0+, or 25.9.0+ within the OpenClaw-supported
  major-version ranges

The package installs a **headless/lightweight runtime**: no visible desktop is
required after login. It still uses the unmodified official AppImage; it does
not reimplement eXpress encryption or its private protocol.

## Artifact variants

1. **Redistributable** `.deb` and `.tar.gz`: bridge, plugin, units and tools;
   no eXpress binary. `install-client` downloads version 3.68.44 from the
   [official eXpress update host](https://updates.express.ms/desktop/eXpress-3.68.44.AppImage)
   and verifies its pinned SHA-256 before extracting it.
2. **Private bundle** `.deb` and `.tar.gz`: identical bridge plus the locally
   obtained official AppImage. This is for authorized internal transfer only.
   Do not publish it without written redistribution permission from eXpress.

The eXpress client is proprietary and is not covered by this project's MIT
license. The public artifacts deliberately exclude it because no redistribution
grant was found in the client payload.

## Install

Debian package:

```bash
sudo apt install ./openclaw-express-bridge_1.0.1_amd64.deb
openclaw-express-bridge install
openclaw-express-bridge install-client
```

Portable archive:

```bash
tar -xzf openclaw-express-bridge-1.0.1-linux-amd64.tar.gz
cd openclaw-express-bridge-1.0.1
./install.sh
~/.local/bin/openclaw-express-bridge install-client
```

For a private bundle, `install` detects `client/eXpress.AppImage` and installs it
without downloading. You can also pass an exact local AppImage:

```bash
openclaw-express-bridge install --client /path/to/eXpress.AppImage
```

Dependencies installed by the `.deb`: `curl`, `dbus-user-session`,
`gnome-keyring`, `nodejs`, `python3`, `tar`, `xvfb`. The portable installer
checks what it needs but does not run a package manager.

## First-time bootstrap

1. Start the isolated client and create a screenshot:

   ```bash
   openclaw-express-bridge login
   ```

   Open the printed PNG path and complete login by QR or phone/SMS. The PNG and
   profile stay in the current user's private data directory.

2. Obtain the exact direct-chat UUID and sender UUID from your approved eXpress
   environment, then configure the single allowed conversation:

   ```bash
   openclaw-express-bridge configure \
     --chat-id 00000000-0000-4000-8000-000000000001 \
     --chat-title "Approved chat" \
     --sender-id 00000000-0000-4000-8000-000000000002 \
     --sender-name "Approved user" \
     --non-interactive
   ```

   The two UUIDs are both written to `allowFrom`; wildcard allowlists are never
   generated. Configuration leaves outbound disabled.

3. Restart the OpenClaw gateway using your normal deployment procedure. Check:

   ```bash
   openclaw-express-bridge status
   openclaw-express-bridge probe
   ```

4. After an inbound-only test succeeds, explicitly enable replies:

   ```bash
   openclaw-express-bridge enable-outbound
   ```

## Safety model

Outbound requires **both**:

- `channels.express.desktopOutboundEnabled=true`; and
- the local mode-0600 switch file in the bridge state directory.

Fresh install, configure and restore close both gates. To close them immediately:

```bash
openclaw-express-bridge disable-outbound
```

Use `--no-restart` with either outbound command if the gateway must be restarted
separately. CDP binds only to loopback. Profile, keyring password, state,
screenshots and backups are mode 0700/0600 and are never part of build artifacts.

## Command reference

- `install [--dry-run] [--client FILE]` — per-user runtime/plugin/unit setup.
- `install-client [FILE]` — verify and extract the pinned official AppImage.
- `configure` — interactive or scripted exact allowlist setup.
- `login` — start services and capture the current login window.
- `status` — local state summary; sends no messages.
- `probe` — CDP, systemd, config and channel health; sends no messages.
- `enable-outbound` / `disable-outbound` — operate both safety gates.
- `backup [FILE]` — encrypted-transport agnostic local backup; output contains
  credentials/session data and is therefore mode 0600.
- `restore FILE` — makes a pre-restore backup and forces outbound off.
- `uninstall` — removes integration but preserves profile/backups.
- `uninstall --purge` — also deletes all bridge-owned user data.

## Backup and restore

```bash
openclaw-express-bridge backup
openclaw-express-bridge restore ~/.local/share/openclaw-express-bridge/backups/FILE.tar.gz
```

Backups contain the dedicated eXpress profile and keyring. Treat them as secrets.
Restore rejects absolute and `..` archive paths, takes a safety backup first,
stops only the three bridge services, and restores with outbound disabled.

## Uninstall

```bash
openclaw-express-bridge uninstall
```

This preserves the dedicated profile and local backups. To remove them too:

```bash
openclaw-express-bridge uninstall --purge
```

If a previous `~/.openclaw/extensions/openclaw-express` existed at install time,
the installer preserves it and the uninstaller restores it.

## Build and test

```bash
./build.sh
./tests/run.sh
```

`build.sh` uses `SOURCE_DATE_EPOCH`, sorted tar input, normalized mtimes and
`gzip -n`. It builds redistributable and private variants when the authorized
AppImage is present at the local build path or `EXPRESS_PRIVATE_CLIENT`.

Release-specific changes are documented in [`RELEASE_NOTES.md`](RELEASE_NOTES.md).
Please report suspected vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md).

## Limitations

- First login is interactive and may require CAPTCHA/SMS/QR confirmation.
- Chat and sender UUID discovery is deployment-specific and intentionally not
  guessed. Exact values must be supplied during `configure`.
- The bridge depends on the official client's DOM/state shape and may require a
  plugin update after a client upgrade.
- The public build pins one verified client release; a newer release requires a
  reviewed URL and SHA-256 update in `client.env`.
- Only Linux amd64 and one exact direct chat are covered by the 1.0.1 bootstrap.
- Backups are access-controlled but not encrypted by this tool.

## License

Bridge code and packaging: MIT, see `LICENSE`. Official eXpress client: separate
third-party terms; excluded from redistributable artifacts.
