# openclaw-express-bridge 1.1.5

An installable, fail-closed bridge between OpenClaw and the official eXpress
Linux desktop client. It runs the client headlessly on an isolated Xvfb display,
uses a dedicated profile/keyring, and exposes Chrome DevTools Protocol only on
`127.0.0.1:18997`. The bundled OpenClaw channel plugin reads and sends text and
bounded file attachments through that local desktop session.

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
sudo apt install ./openclaw-express-bridge_1.1.5_amd64.deb
openclaw-express-bridge install
openclaw-express-bridge install-client
```

Portable archive:

```bash
tar -xzf openclaw-express-bridge-1.1.5-linux-amd64.tar.gz
cd openclaw-express-bridge-1.1.5
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

The switch must be an owner-controlled, mode-0600 regular file; symlinks,
directories and loose permissions keep outbound locked.

## Immediate inbound acknowledgement

Acknowledgement is disabled by default. Set `desktopAckMode` to `typing` to
invoke the official client's own native `ChatInputText.onUserTyping` action as
soon as an unseen inbound message has passed exact sender/chat validation and
deduplication. The bridge refreshes the indicator while OpenClaw is working and
stops it before the first reply. It does not insert placeholder text into the
composer. If client drift makes that verified action unavailable, the bridge
sends one short `desktopAckText` message instead; its default is
`Взял в работу`. Set the mode to `message` to always use the short message, or
`off` to disable acknowledgement.

Typing, keepalives, stop actions, and the text fallback each re-check the same
configuration gate and owner-controlled switch file as normal replies. Old
baseline messages, already-seen IDs, own messages and non-allowlisted senders
never reach the acknowledgement path.

## File attachments and transcription

Desktop mode supports inbound and outbound PDF, DOC/DOCX, XLS/XLSX and PPT/PPTX
documents. Images are received and sent through the official client's native
attachment inputs. Audio, voice and video entries are accepted inbound when the
official client exposes complete, valid file metadata; video also has a native
outbound input, while audio outbound uses the document input.

For client 3.68.44 the bridge resolves the exact nested attachment message and
invokes its official
`MessageEntryBody.loadAttachment({message, downloadToBlob: true})` handler for
documents, images, audio/voice and video. `MessageEntryDocument.onClick` remains
a document-only compatibility fallback. It reads attachment metadata from
`message.payload.payload` or the client's compatible file envelope, resolves
only verified nested/direct blob fields, and copies only a `Blob` or
`blob:file:` URL from the canonical nested message into OpenClaw in bounded
512 KiB chunks. Stale outer-envelope blobs are ignored whenever the exact nested
message is present. File UUID, sender UUID, name, size and MIME type are checked
before and after the download; generic Electron blob types are accepted only
when the declared file metadata is allowlisted and compatible. The saved path
and declared media type are passed through OpenClaw's standard inbound media
context.

The bridge does not bundle a speech-to-text service. Audio and voice arrive
through OpenClaw's generic inbound media context, so transcription is performed
only if the OpenClaw operator configures an STT-capable provider in their own
deployment. Each operator selects, supplies credentials for, and pays for that
provider; this package contains no provider-specific transcription script,
credential or account configuration.

A failed attachment is retried three times with a durable per-message counter.
If it remains unreadable, only that exact message ID is quarantined; later
messages continue and the CDP channel is not reconnected in a loop. Transport
and active-chat failures still use the channel reconnect path.

Desktop outbound `sendMedia` accepts only a local regular, non-symlink file. The
default allowed root is `~/.openclaw/media`; additional exact roots require the
explicit `desktopMediaRoots` setting. Credential-like paths are rejected. The
default limit is 20 MB and the hard configuration ceiling is 100 MB. Known image
and video extensions use the client's exact image/video inputs; documents,
audio and unknown extensions use the document input.

BotX outbound file upload is not implemented and fails with an error; the bridge
never substitutes a text link and claims that a file was uploaded.

## BotX security status

BotX text delivery to CTS remains available. BotX inbound is disabled: the old
unsigned per-account HTTP listener is no longer reachable from the channel
lifecycle. It will stay disabled until a verified BotX JWT v2 contract/SDK and
OpenClaw's shared HTTP-listener routing are implemented. Sender allowlists and
`bot_id` comparisons are authorization policy, not request authentication.
The legacy `webhookPort` field is accepted for config compatibility but ignored.
The retained BotX text path uses the legacy CTS bearer-token exchange; it does
not claim BotX JWT v2 inbound verification or CTS v2 request signing.

CTS credential-bearing requests reject redirects. File downloads accept only
HTTP(S) URLs on the configured CTS origin, reject embedded credentials and
redirects, and enforce the media limit both from `Content-Length` and while
streaming. Non-loopback CTS endpoints must use HTTPS.

## Feature scope matrix

| Requirement | 1.1.5 state |
|---|---|
| Native OpenClaw channel lifecycle | Implemented |
| Default/named account configuration | Implemented; concurrent desktop accounts require separate client/CDP sessions |
| Concurrent BotX accounts on one listener | Blocked with BotX inbound |
| BotX JWT v2 inbound authentication | Not implemented; fail-closed |
| Shared HTTP listener and account routing | Not implemented |
| Standard inbound routing/session context | Desktop implemented |
| Access policies | Desktop exact allowlist only |
| Standard outbound text delivery | Desktop and BotX implemented |
| PDF, DOC(X), XLS(X), PPT(X) | Desktop receive/send implemented |
| Images | Desktop receive/send implemented |
| Video | Desktop receive; native outbound input |
| Voice/audio | Desktop receive as standard OpenClaw audio media; outbound uses the document input |
| Speech-to-text | Delegated to the operator's generic OpenClaw STT/provider configuration; no provider bundled |
| Reactions | Not implemented |
| Chat/thread creation | Not implemented |
| Typing indicator | Desktop native action with interlocked text fallback; opt-in |
| Markdown conversion | Outbound Markdown-to-plain-text only |

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
- Only Linux amd64 and one exact direct chat are covered by the 1.1.5 bootstrap.
- No live eXpress file was sent by the automated test suite; the desktop file
  contract is covered by unit tests and must be canary-tested in an approved chat.
- BotX inbound, shared-listener routing, reactions and chat/thread creation are
  not implemented.
- Backups are access-controlled but not encrypted by this tool.

## License

Bridge code and packaging: MIT, see `LICENSE`. Official eXpress client: separate
third-party terms; excluded from redistributable artifacts.
