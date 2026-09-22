import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSummary, createRequestId, createResponseTopic, redactAndBound } from '../src/protocol.mjs';

test('request identifiers and response topics are high-entropy URL-safe values', () => {
  const id = createRequestId();
  const topic = createResponseTopic();
  assert.match(id, /^nfx_[A-Za-z0-9_-]{22,}$/);
  assert.match(topic, /^nofax_r_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(topic, createResponseTopic());
});

test('redacts secret-like keys and bounds nested values', () => {
  const cyclic = { token: 'top-secret', nested: { password: 'nope', ok: 'x'.repeat(800) } };
  cyclic.self = cyclic;
  const result = redactAndBound(cyclic);
  assert.equal(result.token, '[REDACTED]');
  assert.equal(result.nested.password, '[REDACTED]');
  assert.ok(result.nested.ok.length <= 520);
  assert.equal(result.self, '[CIRCULAR]');
});

test('redacts camelCase and PascalCase variants of known secret keys', () => {
  const result = redactAndBound({
    accessToken: 'access-secret',
    RefreshToken: 'refresh-secret',
    clientSecret: 'client-secret',
    dbPassword: 'db-secret',
    apiKey: 'api-secret',
    privateKey: 'private-secret',
    safeTokenizedValue: 'keep-me',
    secretaryName: 'also-keep-me'
  });

  assert.equal(result.accessToken, '[REDACTED]');
  assert.equal(result.RefreshToken, '[REDACTED]');
  assert.equal(result.clientSecret, '[REDACTED]');
  assert.equal(result.dbPassword, '[REDACTED]');
  assert.equal(result.apiKey, '[REDACTED]');
  assert.equal(result.privateKey, '[REDACTED]');
  assert.equal(result.safeTokenizedValue, 'keep-me');
  assert.equal(result.secretaryName, 'also-keep-me');
});

test('redacts secret values embedded inside ordinary string fields', () => {
  const marker = 'NOFAX_EMBEDDED_SECRET_CANARY_XYZ';
  const result = redactAndBound({
    command: `curl -H "Authorization: Bearer ${marker}" "https://example.test/?token=${marker}&mode=safe"`,
    envLine: `OPENAI_API_KEY=${marker}`,
    cli: `tool --password ${marker} --tokenize keep-me`,
    json: `{"clientSecret":"${marker}","safeTokenizedValue":"keep-me"}`,
    benign: 'secretaryName=alice safeTokenizedValue=visible apiKeynote=keep'
  });

  assert.doesNotMatch(result.command, new RegExp(marker));
  assert.doesNotMatch(result.envLine, new RegExp(marker));
  assert.doesNotMatch(result.cli, new RegExp(marker));
  assert.doesNotMatch(result.json, new RegExp(marker));
  assert.match(result.command, /Authorization: Bearer \[REDACTED\]/);
  assert.match(result.command, /token=\[REDACTED\]/);
  assert.match(result.envLine, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(result.cli, /--password \[REDACTED\]/);
  assert.match(result.cli, /--tokenize keep-me/);
  assert.match(result.json, /safeTokenizedValue":"keep-me/);
  assert.equal(result.benign, 'secretaryName=alice safeTokenizedValue=visible apiKeynote=keep');
});

test('redacts URI userinfo passwords inside ordinary string fields', () => {
  const marker = 'NOFAX_URI_USERINFO_SECRET_CANARY_XYZ';
  const result = redactAndBound({
    database: `postgres://alice:${marker}@db.example.test/app`,
    web: `https://alice:${marker}@example.test/private`,
    encoded: `mongodb+srv://service:${marker}%2Fpart@cluster.example.test/app`,
    cacheUri: `redis://:${marker}@cache.example.test:6379/0`,
    usernameOnly: 'https://alice@example.test/path',
    portOnly: 'https://example.test:8443/path'
  });

  assert.doesNotMatch(result.database, new RegExp(marker));
  assert.doesNotMatch(result.web, new RegExp(marker));
  assert.doesNotMatch(result.encoded, new RegExp(marker));
  assert.doesNotMatch(result.cacheUri, new RegExp(marker));
  assert.equal(result.database, 'postgres://alice:[REDACTED]@db.example.test/app');
  assert.equal(result.web, 'https://alice:[REDACTED]@example.test/private');
  assert.equal(result.encoded, 'mongodb+srv://service:[REDACTED]@cluster.example.test/app');
  assert.equal(result.cacheUri, 'redis://:[REDACTED]@cache.example.test:6379/0');
  assert.equal(result.usernameOnly, 'https://alice@example.test/path');
  assert.equal(result.portOnly, 'https://example.test:8443/path');
});

test('buildAgentSummary does not expose URI userinfo passwords', () => {
  const marker = 'NOFAX_URI_SUMMARY_SECRET_CANARY_XYZ';
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: { command: `psql postgres://alice:${marker}@db.example.test/app` }
  });

  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(summary, /postgres:\/\/alice:\[REDACTED\]@db\.example\.test\/app/);
});

test('redacts secrets before applying the per-string truncation boundary', () => {
  const marker = 'NOFAX_TRUNCATION_SECRET_CANARY_XYZ';
  const input = `${'x'.repeat(440)} clientSecret="${marker}${'z'.repeat(120)}"`;

  const redacted = redactAndBound(input);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: { command: input }
  });

  assert.doesNotMatch(redacted, new RegExp(marker));
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(redacted, /clientSecret="\[REDACTED\]"/);
  assert.match(redacted, /…\[truncated\]$/);
  assert.ok(redacted.length <= 520);
});

test('buildAgentSummary is stable, bounded, and does not expose known secret keys', () => {
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'Bash',
    cwd: '/tmp/project',
    toolInput: { command: 'npm test', api_key: 'abc123', accessToken: 'def456', clientSecret: 'ghi789' }
  });
  assert.match(summary, /Claude Code/);
  assert.match(summary, /Bash/);
  assert.match(summary, /npm test/);
  assert.doesNotMatch(summary, /abc123/);
  assert.doesNotMatch(summary, /def456/);
  assert.doesNotMatch(summary, /ghi789/);
  assert.ok(summary.length <= 2200);
});
