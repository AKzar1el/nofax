# Contributing to Nofax

Thanks for improving Nofax.

## Principles

Changes should preserve four invariants:

1. A transport failure never becomes approval.
2. Agent-specific schemas stay in adapters.
3. Runtime dependencies are added only when they provide a clear, reviewed benefit.
4. Compatibility claims require a documented upstream contract and tests.

## Development setup

Nofax requires Node.js 20 or newer and has no runtime dependencies.

```bash
npm test
npm run check
npm pack --dry-run
```

## Tests

Use Node's built-in `node:test` runner. Network boundaries should be injected and mocked; ordinary tests must not send live ntfy messages.

For a new bidirectional agent adapter, include fixtures for:

- allow;
- deny;
- timeout/native fallback;
- malformed input;
- transport failure;
- absence of unsupported/reserved native fields.

## Pull requests

Keep pull requests focused. Explain the upstream agent contract you are integrating and link to its official documentation or canonical schema when possible.

Do not add an adapter that claims remote approval when the upstream interface is notification-only.
