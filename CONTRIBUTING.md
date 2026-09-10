# Contributing to Nofax

Thanks for improving Nofax.

## Principles

Changes should preserve five invariants:

1. A transport failure never becomes approval.
2. Agent-specific schemas stay in adapters.
3. Runtime dependencies are added only when they provide a clear, reviewed benefit.
4. Compatibility claims require a documented upstream contract and tests.
5. Remote capabilities stay narrower than local capabilities unless their trust boundary is explicitly designed and tested.

## Development setup

Nofax requires Node.js 20 or newer. Install the pinned dependencies before running checks:

```bash
npm ci
npm test
npm run check
npm pack --dry-run
```

Worker development uses its own lockfile under `worker/` and requires Node.js 22 or newer.

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

For Worker changes, also run `npm run check` from `worker/`; this includes TypeScript, Vitest, and a Wrangler deployment dry-run.
