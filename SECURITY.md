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
  a local switch file.
- Exact sender and chat UUIDs are required; wildcard allowlists are not created.
- Backups contain session credentials and must be stored as secrets.
- The proprietary eXpress client is downloaded from the official update host,
  verified by a pinned SHA-256, and excluded from public artifacts.
