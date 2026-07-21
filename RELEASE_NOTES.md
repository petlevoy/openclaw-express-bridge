# Release notes

## 1.0.0

First packaged release of the headless eXpress desktop bridge for OpenClaw.

### Included

- Redistributable Debian and portable archive builds for Ubuntu/Debian amd64.
- Installer for the verified official eXpress AppImage 3.68.44.
- Isolated Xvfb display, profile, and keyring managed by systemd user services.
- OpenClaw eXpress channel plugin 2.1.0.
- Loopback-only Chrome DevTools Protocol endpoint.
- Exact sender/chat allowlist bootstrap and double fail-closed outbound control.
- Login, configuration, status, probe, backup, restore, and uninstall commands.
- Deterministic packaging, smoke tests, and secret scanning.

### Distribution note

Public release artifacts do not contain the proprietary eXpress client. The
installer downloads it from the official eXpress update host and verifies its
pinned SHA-256. Bundles containing the client are not for public distribution
without written permission from eXpress.

### Known limitations

- First login requires interactive QR or phone/CAPTCHA/SMS confirmation.
- Chat and sender UUIDs must be supplied explicitly.
- Official client DOM changes can require a plugin update.
- Version 1.0.0 supports Linux amd64 and one exact direct chat.
