# Nofax local MCP privacy notice

Last updated: November 24, 2026

This notice applies to the local Nofax CLI, stdio MCP server, and desktop extension. The optional separately self-deployed Worker is described in [the remote MCP documentation](docs/remote-mcp.md) and [the security policy](SECURITY.md).

## Data processed

Nofax processes notification titles and messages, requested choices, request identifiers, and the responses needed for the specific interaction you initiate. It does not provide a Nofax-hosted account service or intentionally send telemetry to the project maintainer. Only send content that you are authorized to disclose; never send passwords, private keys, authentication codes, or confidential prompts to a public notification service.

## Notification provider

The configured ntfy server receives notification content, topic identifiers, and response messages needed to deliver or poll the request. The default is https://ntfy.sh, operated independently under its [privacy policy](https://docs.ntfy.sh/privacy/). Its public service may cache messages and process network metadata; the default service is not end-to-end encrypted. A random topic is a bearer capability, not encryption. For sensitive use, choose a trusted authenticated or self-hosted HTTPS transport and consult that operator's policies. Optional publishing credentials are supplied by the user, are not saved in config.json, and must remain secret. An explicitly invoked iOS refinement shortcut can process your refinement text and the one-time response URL on your device.

## Local storage and deletion

By default, Nofax keeps its configuration and durable request records under ~/.nofax (or NOFAX_HOME if you configure it). Records contain request metadata, response-topic capabilities, permitted decisions, timestamps, and terminal decisions or refinement text where applicable. The MCP-facing inspection tools omit secret response topics. The configuration and records remain on your computer until you remove them; protect the directory with your operating system's account permissions. After resolving or explicitly abandoning outstanding requests, you can remove the relevant records or configuration yourself. Deleting local records does not delete notification-provider caches or MCP-client transcripts. Do not interpret deletion, transport failure, timeout or silence as approval.

## Desktop and host permissions

The desktop bundle launches only the local MCP server. It installs no approval hooks, does not change host permissions, and must not be used to override Claude, operating-system or organizational authorization controls. Your MCP host and notification client may separately retain inputs and outputs under their own policies.

## Contact

For privacy or support questions, use info@tomiseregi.si or the [issue tracker](https://github.com/AKzar1el/nofax/issues). Never post secrets in a public issue; follow [SECURITY.md](SECURITY.md) for security reports.
