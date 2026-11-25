# Claude Desktop extension

The local MCPB distribution contains the released Node.js MCP server and its locked production dependencies. It installs no agent hooks and does not override Claude or OS permissions. It is separate from the optional self-hosted Worker.

## Setup

1. Install the matching `.mcpb` asset from the [GitHub Releases](https://github.com/AKzar1el/nofax/releases) page using your desktop client's local extension installation flow. Review the declared tools.
2. Configure your own notification transport using the [Nofax quick start](../README.md#quick-start). If you have no existing Nofax configuration, run `npx -y nofax@0.2.51 init` in a terminal and subscribe your own ntfy app to the topic shown locally. Treat that topic as a secret. Use your trusted HTTPS ntfy server for sensitive use. No Nofax account is required.
3. Use the following examples with synthetic or non-sensitive content and your own recipient/topic:
   - "Send a Nofax notification titled Test with the message Desktop extension check."
   - "Ask me whether to proceed with a harmless draft preview via Nofax; wait for my actual decision."
   - "List my pending Nofax requests without sending anything."

An unresolved request is never authorization. Nofax does not bypass the client's own confirmation requirements. See [privacy](../PRIVACY.md) and [security](../SECURITY.md).

## Build from the released source

Use the release tag, verify its version and install the lockfile with `npm ci --omit=dev --ignore-scripts`. Use `npm pack` to obtain the distribution files, extract them to a new staging directory, include the tagged manifest, privacy documentation, production dependencies, and lockfile, and run `npx --yes @anthropic-ai/mcpb@2.1.2 validate manifest.json` and `npx --yes @anthropic-ai/mcpb@2.1.2 pack . nofax-0.2.51.mcpb`. Never include configuration, local request state, credentials, or hooks. Independently extract the bundle and test `node bin/nofax.mjs mcp` over stdio with a disposable Nofax home and loopback notification fixture before publishing.
