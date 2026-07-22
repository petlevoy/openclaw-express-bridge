# Release notes

## 1.1.2

- Ships plugin 2.2.2 with the live eXpress 3.68.44 document component shape covered by regression tests: the message envelope remains on `MessageEntry`, while `MessageEntryDocument` passes the nested document payload to its official loader.
- Accepts the verified nested and compatibility blob locations, rejects conflicting blob sources, and falls back to the official generic loader when a document component does not expose `onClick`.
- Preserves declared OpenXML MIME metadata when Electron returns an empty, generic octet-stream, or ZIP blob type for DOCX, XLSX, and PPTX files.
- Rebuilds `dist/` from the checked TypeScript sources during packaging so the installed entry point cannot lag behind the manifest and source tree.

## 1.1.1

- Ships plugin 2.2.1 with an executable regression fixture for document messages that combine a text body with metadata at `message.payload.payload` and a downloaded blob URL at `message.payload.payload.fileBlob`.
- Deployment note: replacing the plugin files requires a full gateway process restart. The gateway's in-process restart keeps already-imported ESM modules cached and can otherwise report the new manifest version while continuing to run the previous plugin code.

## 1.1.0

Desktop file transfer and fail-closed BotX hardening.

### Added

- Receive desktop document, image, audio/voice and video attachments through the
  official client's verified `MessageEntryDocument.onClick` or
  `MessageEntry.loadAttachment` download-to-blob path. Client 3.68.44 stores the
  attachment metadata and resulting `blob:file:` URL at
  `message.payload.payload`; the former top-level blob path remains a
  compatibility fallback.
- Preserve file name, MIME type and OpenClaw media context while moving bounded
  blobs in 512 KiB chunks.
- Send local files with OpenClaw `sendMedia` through the official client's exact
  document, image or video input; captions remain separate text messages.
- Configure additional exact outbound roots with `desktopMediaRoots`; the default
  root is limited to OpenClaw's media directory.
- Added tests for attachment metadata, exact sender checks, blob chunking, local
  path policy, symlinks, interlocks, CTS origins, redirects and stream limits.

### Security

- Removed the unsigned per-account BotX listener from the active lifecycle.
  BotX inbound now fails closed until verified JWT v2 authentication and the
  OpenClaw shared-listener contract are implemented.
- Removed the unused private task queue and its manual inbound bypass.
- CTS secret/Bearer requests reject redirects. Downloads accept only the
  configured CTS origin and enforce both declared and streamed byte counts.
- Desktop outbound requires an owner-controlled mode-0600 regular switch file;
  symlinks and permissive switch files do not unlock delivery.
- Desktop files must be regular, non-symlink local files below canonical allowed
  roots, below the configured limit, and outside credential-like paths.

### Compatibility and limits

- Bridge version 1.1.0 ships plugin 2.2.0 for OpenClaw `2026.7.1-2` or newer.
- BotX text delivery remains supported. BotX file upload is explicitly unsupported
  and is never represented by a fake text link.
- The retained BotX text path is the legacy CTS bearer-token exchange; this
  release does not claim JWT v2 inbound verification or CTS v2 request signing.
- Audio and unknown outbound extensions use the document input. Reactions,
  chat/thread creation, typing indicators, shared BotX listener routing and full
  bidirectional Markdown conversion remain outside this release.
- No live eXpress send was performed by the automated suite.

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
