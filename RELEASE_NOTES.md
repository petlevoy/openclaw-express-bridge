# Release notes

## 1.1.12

- Ships eXpress plugin 2.3.4 with a native durable text adapter. Before the
  official desktop client is allowed to send, the adapter records the exact
  chat, text and visible own-message baseline; startup recovery can therefore
  prove `sent` or `not_sent` instead of dropping an answer or replaying blind.
- Bounds eXpress-originated native tool fan-out to three concurrent calls so a
  large document-analysis turn cannot starve the Gateway event loop used by
  channel polling and SQLite delivery state.
- Initializes the delivery journal before the desktop monitor starts and keeps
  legacy pre-journal queue entries fail-closed.

## 1.1.11

- Ships eXpress plugin 2.3.3 and fixes live outbound
  `desktop native text send failed closed: text-mismatch` failures.
- Polls the official `ChatInputText.getMessage()` contract for up to two
  seconds after `setInputText()` instead of assuming Slate synchronizes within
  100 ms. The existing exact-text verification and fail-closed send remain.
- Waits up to 15 seconds for the authorized UI during the official client's
  periodic memory-clean renderer reload instead of immediately entering
  reconnect backoff and losing the acknowledgement window.
- Retains the compatible trailing editor-newline normalization discovered in
  the live client and adds delayed-composer and transient-reload regressions.

## 1.1.10

- Ships eXpress plugin 2.3.2 with UUID-first desktop navigation, bounded
  renderer recovery and safer text delivery for the official client 3.68.x.
- Routes mounted chats by their React `groupChatId` and uses the official
  router for virtualized/off-screen entries. The configured title remains a
  mandatory post-navigation identity check and is no longer the selector.
- Detects the fatal “Something went wrong” renderer state before reporting an
  authentication or missing-chat failure, performs one controlled `Page.reload`
  and waits for the authenticated UI to return.
- Sends through the verified native `ChatInputText` component instead of a
  single synthetic `Input.insertText` payload. Text chunks are capped at 1,800
  characters, including deployments with a larger legacy configured limit.
- Confirms a new outbound text by both message ID and exact normalized body.
  After renderer recovery an unresolved send fails closed and is not blindly
  retried, avoiding duplicate replies.
- Bounds multi-chat UI switches to one per second. The previous full-cycle
  interval was divided by the chat count, making three configured chats force a
  route change about every 333 ms and keeping the renderer CPU/memory hot.
- Adds regression coverage for UUID selection, router fallback, renderer-state
  classification, native text sending, chunk limits and exact delivery
  reconciliation. The automated suite performs no live eXpress send.

## 1.1.9

- Ships eXpress plugin 2.3.1 with priority cancellation and reload-safe inbound
  claims for the multi-chat desktop bridge.

- Handles standalone `/stop`, `stop`, `стоп` and the other OpenClaw abort
  phrases as priority control events. They bypass the busy chat's normal FIFO
  and shared model semaphore, then enter OpenClaw's standard fast-abort path, so
  cancellation does not wait behind the turn it must interrupt.
- Durably claims each validated inbound message before placing it in an
  in-memory queue. Version-5 state is serialized by a per-state-path mutex and
  replaced atomically; reload/reconnect can no longer submit the same claimed
  event twice while its dispatch is active. Claims become normal seen IDs after
  success and are released after a definitive dispatch or attachment failure.
  Process-owned claims survive provider reloads but become retryable after a
  full Gateway process restart, preventing permanent loss.
- Tracks active OpenClaw session keys and requests bounded `chat.abort` cleanup
  when the desktop provider is stopped. This prevents channel shutdown from
  leaving its own agent turn running after the CDP monitor has closed.
- Documents the OpenClaw-wide reload deferral boundary and the supported
  detached-work contract. The bridge does not silently transform arbitrary
  foreground prompts into background tasks.
- Adds regression coverage for priority cancellation, durable claim recovery,
  concurrent cross-instance claim serialization and active-session shutdown.
  The test suite performs no live eXpress send.

## 1.1.8

- Ships eXpress plugin 2.3.0 with backward-compatible `desktopChats` support for
  multiple exact direct chats through one official desktop client and one CDP
  endpoint.
- Polls chats round-robin, serializes all active-chat, download,
  acknowledgement and outbound UI work with one endpoint-wide async mutex, and
  keeps model execution outside that lock.
- Adds a bounded FIFO queue per chat plus a shared dispatch concurrency of 2 by
  default, so a long agent turn does not stop polling or processing another
  user.
- Separates durable baseline, dedupe, acknowledgement, retry and poison-message
  quarantine state by chat. Legacy single-chat deployments retain their
  existing state path.
- Routes with standard `resolveAgentRoute(peer.id=senderId)` and binds every
  reply to the inbound event's chat UUID. Every send opens the exact configured
  title and re-checks both UUID and title before mutating the desktop client.
- Adds schema uniqueness checks, exact fail-closed `allowFrom` validation, a
  non-applying routing-fragment generator, a generic isolated agent/workspace
  creator with no embedded user data, and regression coverage for legacy
  config, multi-chat routing, round-robin scheduling, queue isolation, global
  UI serialization, media handling and no-cross-send behavior.
- Retains the 2.2.6 inbound image/attachment fixes unchanged. No live eXpress
  send is performed by the automated suite.

## 1.1.7

- Ships eXpress plugin 2.2.6 and accepts the official desktop client's
  extensionless screenshot names when they carry an explicit allowlisted image
  MIME type. Arbitrary extensionless files and SVG remain rejected.
- Resolves the live image attachment component when its internal `msgId`
  differs from the visible message `syncId`, and checks both current and
  alternate React fiber state for the blob published after
  `MessageEntryBody.loadAttachment`.
- Preserves bounded UUID/sender/name/size/MIME validation, then stores the image
  through OpenClaw's `media/inbound` path and supplies standard `MediaPath` and
  `MediaType` context for vision/OCR.
- Stops revalidating and relogging an attachment after its exact message ID has
  already been quarantined.

## 1.1.6

- Ships eXpress plugin 2.2.5 and routes generic
  `message(action="send", media|filePath|attachments=...)` calls through the
  durable OpenClaw outbound adapter. Previous releases let the legacy
  plugin-owned text action swallow the media fields and report
  `ok: true, messageId: ""` without invoking the desktop file sender.
- After selecting the attachment through the official client's native input,
  the bridge clicks the client's normal send button instead of treating file
  selection as delivery.
- Confirms a desktop file send only after the official client exposes a new
  own attachment with the expected media kind, filename and byte size. A
  concurrent own text message can no longer produce a false successful file
  receipt, and an unconfirmed send never returns a successful `ok` result.

## 1.1.5

- Publishes bridge 1.1.5 with the unchanged eXpress plugin 2.2.4. There is no
  plugin runtime-code change from bridge 1.1.4.
- Documents bidirectional desktop transfer for PDF, DOC/DOCX, XLS/XLSX and
  PPT/PPTX documents, plus bidirectional images and inbound audio/voice/video.
  Video retains its native outbound input; outbound audio continues to use the
  document input.
- Documents the generic OpenClaw speech-to-text boundary. The bridge passes
  audio and voice through standard inbound media context and does not bundle a
  transcription provider. Each operator selects, supplies credentials for, and
  pays for their own STT-capable provider in OpenClaw.
- Documents opt-in native typing acknowledgement with its gated short-text
  fallback, durable per-event quarantine after three failed attachment attempts,
  and the fail-closed outbound/configuration security gates.
- Public artifacts contain no provider-specific transcription script,
  credentials, local state, chat/user identifiers or deployment configuration.

## 1.1.4

- Ships plugin 2.2.4 with the live eXpress 3.68.44 attachment shape fixed for
  images and audio/voice: the downloadable message and `loadAttachment` handler
  live together on the nested `MessageEntryBody`, not on the outer envelope.
- Uses that exact nested official-client loader as the primary path for
  documents, images, audio/voice and video; document `onClick` remains a
  compatibility fallback.
- Isolates attachment failures per message. A failed event receives three
  durable attempts, then only its ID is quarantined; later messages continue
  without closing CDP or entering a reconnect/replay loop.
- Preserves global reconnect behavior for CDP transport, authentication and
  active-chat allowlist failures.
- Keeps immediate native typing/text fallback acknowledgements deduplicated and
  ahead of attachment download and OpenClaw processing.
- No live outbound canary or public release was performed for this patch.

## 1.1.3

- Ships plugin 2.2.3 with opt-in immediate desktop acknowledgement after exact
  sender/chat validation and persistent message-ID deduplication.
- Uses the official eXpress 3.68.44 `ChatInputText.onUserTyping` action for a
  native typing indicator without changing the editor or sending placeholder
  keystrokes. The indicator is refreshed during processing and stopped before
  the first response.
- Adds `desktopAckMode=off|typing|message` with the fail-closed default `off` and
  bounded `desktopAckText`. If the exact native client action is unavailable,
  `typing` mode sends one short text acknowledgement instead.
- Re-checks both existing outbound interlocks before each typing, keepalive,
  stop or text-fallback action. Baseline, seen, own and non-allowlisted messages
  remain outside the acknowledgement path.
- No live eXpress message was sent while implementing or testing this release.

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
