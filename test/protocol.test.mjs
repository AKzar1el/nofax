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

test('secret-key normalization stays bounded on long acronym-style names', () => {
  const longPrefix = 'A'.repeat(20000);
  const result = redactAndBound({
    [`${longPrefix}Token`]: 'long-secret',
    [`${longPrefix}TokenizedValue`]: 'keep-me'
  });

  assert.equal(result[`${longPrefix}Token`], '[REDACTED]');
  assert.equal(result[`${longPrefix}TokenizedValue`], 'keep-me');
});

test('redacts values in secret-key tuple entries without hiding ordinary tuples', () => {
  const marker = 'NOFAX_SECRET_TUPLE_CANARY_XYZ';
  const result = redactAndBound([
    ['Authorization', `Bearer ${marker}`],
    ['authorization', `Digest username="alice", response="${marker}"`],
    ['Cookie', `session=${marker}`],
    ['X-Api-Key', marker],
    ['Accept', 'application/json']
  ]);
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'WebFetch',
    cwd: '/tmp/project',
    toolInput: {
      headers: [
        ['Authorization', `Bearer ${marker}`],
        ['Accept', 'application/json']
      ]
    }
  });

  assert.deepEqual(result, [
    ['Authorization', '[REDACTED]'],
    ['authorization', '[REDACTED]'],
    ['Cookie', '[REDACTED]'],
    ['X-Api-Key', '[REDACTED]'],
    ['Accept', 'application/json']
  ]);
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(summary, /"Authorization",\n\s+"\[REDACTED\]"/);
  assert.match(summary, /"Accept",\n\s+"application\/json"/);
});

test('redacts secret values in name/value and key/value entry objects', () => {
  const marker = 'NOFAX_SECRET_ENTRY_OBJECT_CANARY_XYZ';
  const result = redactAndBound([
    { name: 'Authorization', value: `Bearer ${marker}`, enabled: true },
    { name: 'Cookie', value: `session=${marker}` },
    { key: 'X-Api-Key', value: marker },
    { name: 'Accept', value: 'application/json' }
  ]);
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'WebFetch',
    cwd: '/tmp/project',
    toolInput: {
      headers: [
        { name: 'Authorization', value: `Bearer ${marker}` },
        { name: 'Accept', value: 'application/json' }
      ]
    }
  });

  assert.deepEqual(result, [
    { name: 'Authorization', value: '[REDACTED]', enabled: true },
    { name: 'Cookie', value: '[REDACTED]' },
    { key: 'X-Api-Key', value: '[REDACTED]' },
    { name: 'Accept', value: 'application/json' }
  ]);
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(summary, /"name": "Authorization",\n\s+"value": "\[REDACTED\]"/);
  assert.match(summary, /"name": "Accept",\n\s+"value": "application\/json"/);
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

test('redacts complete Cookie and Set-Cookie header values', () => {
  const marker = 'NOFAX_COOKIE_HEADER_SECRET_CANARY_XYZ';
  const cookie = redactAndBound(`Cookie: theme=dark; session=${marker}; locale=en`);
  const setCookie = redactAndBound(`Set-Cookie: theme=dark; session=${marker}; Path=/; HttpOnly`);
  const multiline = redactAndBound(`Accept: application/json\nCookie: theme=dark; session=${marker}\nX-Mode: safe`);
  const benign = redactAndBound('headerPolicy: keep-visible');
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: { headers: `Cookie: theme=dark; session=${marker}` }
  });

  assert.doesNotMatch(cookie, new RegExp(marker));
  assert.doesNotMatch(setCookie, new RegExp(marker));
  assert.doesNotMatch(multiline, new RegExp(marker));
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.equal(cookie, 'Cookie: [REDACTED]');
  assert.equal(setCookie, 'Set-Cookie: [REDACTED]');
  assert.equal(multiline, 'Accept: application/json\nCookie: [REDACTED]\nX-Mode: safe');
  assert.equal(benign, 'headerPolicy: keep-visible');
});

test('redacts complete parameterized Authorization header lines', () => {
  const marker = 'NOFAX_AUTH_HEADER_SECRET_CANARY_XYZ';
  const digest = redactAndBound(`Authorization: Digest username="alice", realm="test", nonce="${marker}", response="${marker}"`);
  const aws = redactAndBound(`Authorization: AWS4-HMAC-SHA256 Credential=AKIA/${marker}, SignedHeaders=host;x-amz-date, Signature=${marker}`);
  const proxy = redactAndBound(`Proxy-Authorization: Digest username="alice", response="${marker}"`);
  const multiline = redactAndBound(`Accept: application/json\n  Authorization: Digest response="${marker}"\nX-Mode: safe`);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: { headers: `Authorization: Digest response="${marker}"` }
  });

  for (const value of [digest, aws, proxy, multiline, summary]) {
    assert.doesNotMatch(value, new RegExp(marker));
  }
  assert.equal(digest, 'Authorization: [REDACTED]');
  assert.equal(aws, 'Authorization: [REDACTED]');
  assert.equal(proxy, 'Proxy-Authorization: [REDACTED]');
  assert.equal(multiline, 'Accept: application/json\n  Authorization: [REDACTED]\nX-Mode: safe');
});

test('redacts inline quoted and assignment-style Authorization values', () => {
  const marker = 'NOFAX_INLINE_AUTH_SECRET_CANARY_XYZ';
  const digestInline = redactAndBound(`curl -H 'Authorization: Digest username="alice", realm="test", response="${marker}"' https://example.test/path`);
  const awsInline = redactAndBound(`curl -H "Authorization: AWS4-HMAC-SHA256 Credential=AKIA/${marker}, SignedHeaders=host;x-amz-date, Signature=${marker}" https://example.test/path`);
  const proxyInline = redactAndBound(`curl -H 'Proxy-Authorization: Digest username="alice", response="${marker}"' https://example.test/path`);
  const assigned = redactAndBound(`Authorization = Digest username="alice", response="${marker}"`);
  const proxyAssigned = redactAndBound(`Proxy-Authorization = AWS4-HMAC-SHA256 Credential=AKIA/example, Signature=${marker}`);
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'Bash',
    cwd: '/tmp/project',
    toolInput: { command: `curl -H 'Authorization: Digest username="alice", response="${marker}"' https://example.test/path` }
  });

  for (const value of [digestInline, awsInline, proxyInline, assigned, proxyAssigned, summary]) {
    assert.doesNotMatch(value, new RegExp(marker));
  }
  assert.equal(digestInline, `curl -H 'Authorization: [REDACTED]' https://example.test/path`);
  assert.equal(awsInline, `curl -H "Authorization: [REDACTED]" https://example.test/path`);
  assert.equal(proxyInline, `curl -H 'Proxy-Authorization: [REDACTED]' https://example.test/path`);
  assert.equal(assigned, 'Authorization = [REDACTED]');
  assert.equal(proxyAssigned, 'Proxy-Authorization = [REDACTED]');
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

test('redacts embedded private-key blocks without hiding public certificate blocks', () => {
  const marker = 'NOFAX_PRIVATE_KEY_SECRET_CANARY_XYZ';
  const result = redactAndBound({
    pem: `cat <<'EOF'\n-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----\nEOF`,
    openssh: `-----BEGIN OPENSSH PRIVATE KEY-----\n${marker}\n-----END OPENSSH PRIVATE KEY-----`,
    pgp: `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${marker}\n-----END PGP PRIVATE KEY BLOCK-----`,
    unterminated: `-----BEGIN RSA PRIVATE KEY-----\n${marker}`,
    certificate: '-----BEGIN CERTIFICATE-----\nPUBLIC-CERT-DATA\n-----END CERTIFICATE-----'
  });

  assert.doesNotMatch(result.pem, new RegExp(marker));
  assert.doesNotMatch(result.openssh, new RegExp(marker));
  assert.doesNotMatch(result.pgp, new RegExp(marker));
  assert.doesNotMatch(result.unterminated, new RegExp(marker));
  assert.match(result.pem, /BEGIN PRIVATE KEY-----\n\[REDACTED\]/);
  assert.match(result.openssh, /BEGIN OPENSSH PRIVATE KEY-----\n\[REDACTED\]/);
  assert.match(result.pgp, /BEGIN PGP PRIVATE KEY BLOCK-----\n\[REDACTED\]/);
  assert.equal(result.certificate, '-----BEGIN CERTIFICATE-----\nPUBLIC-CERT-DATA\n-----END CERTIFICATE-----');
});

test('buildAgentSummary does not expose embedded private-key blocks', () => {
  const marker = 'NOFAX_PRIVATE_KEY_SUMMARY_CANARY_XYZ';
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'Bash',
    cwd: '/tmp/project',
    toolInput: {
      command: `cat > key.pem <<'EOF'\n-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----\nEOF`
    }
  });

  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(summary, /BEGIN PRIVATE KEY-----\\n\[REDACTED\]\\n-----END PRIVATE KEY/);
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
