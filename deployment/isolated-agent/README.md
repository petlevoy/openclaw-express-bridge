# Generic isolated agent provisioning

This directory is a reusable template. It contains no user identity, chat UUID,
credential, active OpenClaw configuration, or pre-created agent.

## One-time sandbox image

Build one shared image for isolated agent workspaces:

```bash
docker build \
  -t openclaw-sandbox-agent:bookworm-slim \
  -f deployment/isolated-agent/Dockerfile \
  deployment/isolated-agent
```

The image contains common document, spreadsheet, presentation, image/audio and
shell tooling. Runtime containers have no direct network, host bind mount or
credential injection. Web search and browser access remain separate
OpenClaw-mediated tools and can be audited or denied per agent.

Build the matching OpenClaw sandbox-browser image with the reviewed setup script
from the same OpenClaw version as the Gateway.

## Create one agent and workspace

Prepare a non-secret input:

```json
{
  "agentId": "alice-express",
  "agentName": "Alice Assistant",
  "userDisplayName": "Alice Example"
}
```

Run:

```bash
node tools/create-isolated-agent.mjs \
  ./alice-agent.json \
  /home/operator/.openclaw/agents \
  > ./alice-agent-fragment.json
```

The command:

- refuses to overwrite an existing agent directory;
- creates a private mode-0700 workspace and mode-0600 instruction files;
- creates no symlinks and copies no credential or memory file;
- prints one non-secret `agents.list` object;
- never reads or modifies `openclaw.json`.

Append the printed `agent` object to the existing `agents.list` only after
review. Add the user's exact peer binding with
`tools/generate-desktop-routing.mjs`; merge arrays as complete reviewed arrays,
validate the config, then restart the Gateway.

Use one isolated agent per user when files, memory and sessions must not be
shared. Several users may still share the same eXpress desktop session because
the bridge serializes all UI operations and routes each inbound event by its
exact sender UUID.
