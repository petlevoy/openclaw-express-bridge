# Security policy

## Supported version

Security fixes are provided for the latest published release of
`openclaw-express-bridge`.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository. Include the affected
version, reproduction steps, expected impact, and any suggested mitigation.

Do not include live eXpress sessions, profile data, keyrings, tokens, phone
numbers, sender IDs, chat IDs, or OpenClaw configuration secrets in a report.

## Security boundaries

- The bridge controls only an official eXpress desktop client running locally.
- Chrome DevTools Protocol is bound to `127.0.0.1` and must not be exposed.
- Outbound messaging is fail-closed and requires both configured permission and
  an owner-controlled mode-0600 regular local switch file.
- Exact sender and chat UUIDs are required; wildcard allowlists are not created.
- Desktop outbound files must be regular, non-symlink local files under canonical
  allowed roots. OpenClaw's media directory is the only default root.
- Inbound desktop attachments are size-bounded and their sender/file metadata is
  revalidated before and after download.
- BotX inbound is disabled until verified JWT v2 authentication can be attached
  to OpenClaw's shared HTTP listener. An allowlist is not treated as authentication.
- CTS requests carrying a secret or Bearer token reject redirects; file URLs must
  stay on the configured CTS origin.
- Backups contain session credentials and must be stored as secrets.
- The proprietary eXpress client is downloaded from the official update host,
  verified by a pinned SHA-256, and excluded from public artifacts.
