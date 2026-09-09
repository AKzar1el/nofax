# Security Policy

## Supported versions

Nofax is pre-1.0 software. Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Please do not publish credentials, exploit details, private ntfy topics, or sensitive hook payloads in a public issue.

If GitHub private vulnerability reporting is enabled for this repository, use it. Otherwise, open a minimal public issue asking for a private maintainer contact channel without including sensitive details.

## Important deployment assumptions

### Public ntfy is not end-to-end encryption

With the default `https://ntfy.sh` configuration, notification content transits and may be cached by the ntfy service. Random topic names reduce unauthorized discovery but do not encrypt the message from the service operator.

Use a trusted self-hosted ntfy server for sensitive source code, production operations, credentials, regulated data, or confidential prompts.

### Topics are capabilities

On anonymous ntfy servers, knowledge of a topic can be sufficient to subscribe or publish. Nofax generates high-entropy topics, but users must keep them private.

### Nofax is not a policy engine

Nofax answers approval requests that an upstream agent explicitly delegates to its hook interface. It does not decide which operations should require approval and it must not be used to bypass an agent's deny rules or sandbox.

### Failures never become approval

Timeout, malformed remote responses, publish failures, and poll failures never resolve to `allow`. Native Claude Code and Codex adapters return no decision so the upstream tool can continue with its normal approval path.

### Redaction is best-effort

Nofax redacts values under common secret-bearing object keys and bounds serialized payloads. It cannot reliably detect a secret embedded in arbitrary free-form command text. Treat notification content accordingly.
