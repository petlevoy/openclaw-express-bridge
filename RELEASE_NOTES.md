# Release notes

## 1.0.1

Baseline compatibility update.

### Changed

- Updated the OpenClaw development baseline from `2026.6.10` to `2026.7.1-2`.
- Declared OpenClaw `>=2026.7.1-2` as the minimum compatible host version.
- Updated the eXpress channel plugin to 2.1.1.
- Switched schema validation to OpenClaw's exported Zod runtime so the plugin
  uses the same validator instance as the host.
- Removed the redundant bundled Zod runtime from release artifacts.

### Compatibility

- TypeScript, lint, formatting, all plugin tests, packaging smoke tests and
  secret scans pass against OpenClaw `2026.7.1-2`.
- The shipped plugin has no standalone npm runtime dependencies. npm's audit
  endpoint still reports advisories from OpenClaw's development-only nested
  shrinkwrap; those packages are excluded from the release artifacts.
- No change to the fail-closed outbound gates, exact allowlist or loopback-only
  CDP binding.

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
