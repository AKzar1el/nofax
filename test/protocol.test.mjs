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

test('redacts standalone auth credential fields without hiding auth-related metadata', () => {
  const marker = 'NOFAX_AUTH_FIELD_SECRET_CANARY_XYZ';
  const input = {
    auth: marker,
    Auth: marker,
    authMode: 'oauth2',
    authentication: 'required'
  };
  const result = redactAndBound(input);
  const textResult = redactAndBound(`auth=${marker} authMode=oauth2 authentication=required`);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'http_request',
    cwd: '/tmp/project',
    toolInput: input
  });

  assert.equal(result.auth, '[REDACTED]');
  assert.equal(result.Auth, '[REDACTED]');
  assert.equal(result.authMode, 'oauth2');
  assert.equal(result.authentication, 'required');
  assert.equal(textResult, 'auth=[REDACTED] authMode=oauth2 authentication=required');
  assert.doesNotMatch(summary, new RegExp(marker));
});

test('redacts authHeader credential fields without hiding auth-related metadata', () => {
  const marker = 'NOFAX_AUTH_HEADER_SECRET_CANARY_XYZ';
  const input = {
    authHeader: `Bearer ${marker}`,
    proxyAuthHeader: `Basic ${marker}`,
    authHeaderValue: `Bearer ${marker}`,
    proxyAuthHeaderValue: `Basic ${marker}`,
    authHeaderValues: [`Bearer ${marker}`],
    proxyAuthHeaderValues: [`Basic ${marker}`],
    authHeaderName: 'Authorization',
    authMode: 'oauth2',
    authentication: 'required'
  };
  const result = redactAndBound(input);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'http_request',
    cwd: '/tmp/project',
    toolInput: input
  });

  assert.equal(result.authHeader, '[REDACTED]');
  assert.equal(result.proxyAuthHeader, '[REDACTED]');
  assert.equal(result.authHeaderValue, '[REDACTED]');
  assert.equal(result.proxyAuthHeaderValue, '[REDACTED]');
  assert.equal(result.authHeaderValues, '[REDACTED]');
  assert.equal(result.proxyAuthHeaderValues, '[REDACTED]');
  assert.equal(result.authHeaderName, 'Authorization');
  assert.equal(result.authMode, 'oauth2');
  assert.equal(result.authentication, 'required');
  assert.doesNotMatch(summary, new RegExp(marker));
});

test('redacts passphrase credential fields without hiding passphrase metadata', () => {
  const marker = 'NOFAX_PASSPHRASE_SECRET_CANARY_XYZ';
  const input = {
    passphrase: marker,
    keyPassphrase: marker,
    keyPassPhrase: marker,
    signingPassphrase: marker,
    passphraseHint: 'stored in the password manager',
    phrase: 'keep-visible'
  };
  const result = redactAndBound(input);
  const textResult = redactAndBound(`passphrase=${marker} keyPassphrase=${marker} passphraseHint=visible`);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: input
  });

  assert.equal(result.passphrase, '[REDACTED]');
  assert.equal(result.keyPassphrase, '[REDACTED]');
  assert.equal(result.keyPassPhrase, '[REDACTED]');
  assert.equal(result.signingPassphrase, '[REDACTED]');
  assert.equal(result.passphraseHint, 'stored in the password manager');
  assert.equal(result.phrase, 'keep-visible');
  assert.equal(textResult, 'passphrase=[REDACTED] keyPassphrase=[REDACTED] passphraseHint=visible');
  assert.doesNotMatch(summary, new RegExp(marker));
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

test('redacts case-variant structured header entry fields', () => {
  const marker = 'NOFAX_HEADER_ENTRY_CASE_CANARY_XYZ';
  const input = {
    headers: [
      { name: 'Authorization', Value: marker },
      { Header: 'X-Api-Key', Values: [marker] },
      { Name: 'Accept', Value: 'application/json' }
    ]
  };
  const result = redactAndBound(input);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'http_request',
    toolInput: input
  });

  assert.equal(result.headers[0].Value, '[REDACTED]');
  assert.equal(result.headers[1].Values, '[REDACTED]');
  assert.equal(result.headers[2].Value, 'application/json');
  assert.doesNotMatch(summary, new RegExp(marker));
});

test('redacts secret values in flat alternating key/value arrays', () => {
  const marker = 'NOFAX_FLAT_HEADER_CANARY_XYZ';
  const input = {
    rawHeaders: [
      'X-Api-Key', marker,
      'Accept', 'application/json',
      'Cookie', `session=${marker}`
    ]
  };
  const result = redactAndBound(input);
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'WebFetch',
    cwd: '/tmp/project',
    toolInput: input
  });

  assert.deepEqual(result.rawHeaders, [
    'X-Api-Key', '[REDACTED]',
    'Accept', 'application/json',
    'Cookie', '[REDACTED]'
  ]);
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(summary, /"X-Api-Key",\n\s+"\[REDACTED\]"/);
  assert.match(summary, /"Accept",\n\s+"application\/json"/);
});

test('redacts secret pairs when a flat alternating array has an odd trailing element', () => {
  const marker = 'NOFAX_ODD_FLAT_HEADER_CANARY_XYZ';
  const input = {
    rawHeaders: [
      'X-Api-Key', marker,
      'Accept', 'application/json',
      'X-Dangling'
    ]
  };
  const result = redactAndBound(input);
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'WebFetch',
    cwd: '/tmp/project',
    toolInput: input
  });

  assert.deepEqual(result.rawHeaders, [
    'X-Api-Key', '[REDACTED]',
    'Accept', 'application/json',
    'X-Dangling'
  ]);
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(summary, /"Accept",\n\s+"application\/json"/);
  assert.match(summary, /"X-Dangling"/);
});

test('redacts valid secret pairs even when another flat-array key slot is malformed', () => {
  const marker = 'NOFAX_MALFORMED_FLAT_HEADER_CANARY_XYZ';
  const input = {
    rawHeaders: [
      'Authorization', marker,
      42, 'malformed-value',
      'Accept', 'application/json'
    ]
  };
  const result = redactAndBound(input);
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'WebFetch',
    cwd: '/tmp/project',
    toolInput: input
  });

  assert.deepEqual(result.rawHeaders, [
    'Authorization', '[REDACTED]',
    42, 'malformed-value',
    'Accept', 'application/json'
  ]);
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(summary, /"Authorization",\n\s+"\[REDACTED\]"/);
  assert.match(summary, /42,\n\s+"malformed-value"/);
});
test('redacts secret values in name/key entry objects with singular or plural value fields', () => {
  const marker = 'NOFAX_SECRET_ENTRY_OBJECT_CANARY_XYZ';
  const result = redactAndBound([
    { name: 'Authorization', value: `Bearer ${marker}`, enabled: true },
    { name: 'Cookie', value: `session=${marker}` },
    { key: 'X-Api-Key', value: marker },
    { name: 'Authorization', values: [`Bearer ${marker}`], enabled: true },
    { name: 'Cookie', values: [`session=${marker}`] },
    { key: 'X-Api-Key', values: [marker] },
    { name: 'Accept', value: 'application/json' },
    { name: 'Accept', values: ['application/json'] }
  ]);
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'WebFetch',
    cwd: '/tmp/project',
    toolInput: {
      headers: [
        { name: 'Authorization', values: [`Bearer ${marker}`] },
        { name: 'Accept', value: 'application/json' }
      ]
    }
  });

  assert.deepEqual(result, [
    { name: 'Authorization', value: '[REDACTED]', enabled: true },
    { name: 'Cookie', value: '[REDACTED]' },
    { key: 'X-Api-Key', value: '[REDACTED]' },
    { name: 'Authorization', values: '[REDACTED]', enabled: true },
    { name: 'Cookie', values: '[REDACTED]' },
    { key: 'X-Api-Key', values: '[REDACTED]' },
    { name: 'Accept', value: 'application/json' },
    { name: 'Accept', values: ['application/json'] }
  ]);
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(summary, /"name": "Authorization",\n\s+"values": "\[REDACTED\]"/);
  assert.match(summary, /"name": "Accept",\n\s+"value": "application\/json"/);
});

test('redacts secret values in header/value entry objects', () => {
  const marker = 'NOFAX_HEADER_ENTRY_SECRET_CANARY_XYZ';
  const input = {
    headers: [
      { header: 'Authorization', value: `Bearer ${marker}` },
      { header: 'Cookie', value: `session=${marker}` },
      { header: 'X-Api-Key', value: marker },
      { header: 'Accept', value: 'application/json' }
    ]
  };
  const result = redactAndBound(input);
  const summary = buildAgentSummary({
    source: 'Claude Code',
    toolName: 'WebFetch',
    cwd: '/tmp/project',
    toolInput: input
  });

  assert.deepEqual(result.headers, [
    { header: 'Authorization', value: '[REDACTED]' },
    { header: 'Cookie', value: '[REDACTED]' },
    { header: 'X-Api-Key', value: '[REDACTED]' },
    { header: 'Accept', value: 'application/json' }
  ]);
  assert.doesNotMatch(summary, new RegExp(marker));
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

test('redacts secret values in URL fragment parameters', () => {
  const marker = 'NOFAX_FRAGMENT_SECRET_CANARY_XYZ';
  const access = redactAndBound(`https://example.test/callback#access_token=${marker}&token_type=bearer`);
  const id = redactAndBound(`https://example.test/callback#id_token=${marker}&state=safe`);
  const benign = redactAndBound('https://example.test/page#section=install&mode=compact');
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'browser',
    cwd: '/tmp/project',
    toolInput: { url: `https://example.test/callback#access_token=${marker}&state=safe` }
  });

  for (const value of [access, id, summary]) {
    assert.doesNotMatch(value, new RegExp(marker));
  }
  assert.equal(access, 'https://example.test/callback#access_token=[REDACTED]&token_type=[REDACTED]');
  assert.equal(id, 'https://example.test/callback#id_token=[REDACTED]&state=safe');
  assert.equal(benign, 'https://example.test/page#section=install&mode=compact');
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

test('redacts folded Authorization continuation lines', () => {
  const marker = 'NOFAX_FOLDED_AUTH_SECRET_CANARY_XYZ';
  const digest = redactAndBound(`Authorization: Digest username="alice",\n response="${marker}"`);
  const proxy = redactAndBound(`Proxy-Authorization: Digest username="alice",\n\tresponse="${marker}"`);
  const multiline = redactAndBound(`Accept: application/json\nAuthorization: Digest username="alice",\n response="${marker}"\nX-Mode: safe`);
  const wrapped = redactAndBound(`headers={Authorization: Digest username=alice,\n Signature=${marker}}`);
  const quotedWrapped = redactAndBound(`headers={"Authorization": Digest username=alice,\n Signature=${marker}}`);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: { headers: `Authorization: Digest username="alice",\n response="${marker}"` }
  });

  for (const value of [digest, proxy, multiline, wrapped, quotedWrapped, summary]) {
    assert.doesNotMatch(value, new RegExp(marker));
  }
  assert.equal(digest, 'Authorization: [REDACTED]');
  assert.equal(proxy, 'Proxy-Authorization: [REDACTED]');
  assert.equal(multiline, 'Accept: application/json\nAuthorization: [REDACTED]\nX-Mode: safe');
  assert.equal(wrapped, 'headers={Authorization: [REDACTED]}');
  assert.equal(quotedWrapped, 'headers={"Authorization": [REDACTED]}');
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

test('redacts unquoted inline parameterized Authorization values', () => {
  const marker = 'NOFAX_UNQUOTED_INLINE_AUTH_SECRET_CANARY_XYZ';
  const digestInline = redactAndBound(`prefix Authorization: Digest username=alice, response="${marker}"`);
  const awsInline = redactAndBound(`header=Authorization: AWS4-HMAC-SHA256 Credential=AKIA/example, Signature=${marker}`);
  const proxyInline = redactAndBound(`prefix Proxy-Authorization: Digest username=alice, response="${marker}"`);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: { command: `prefix Authorization: Digest username=alice, response="${marker}"` }
  });

  for (const value of [digestInline, awsInline, proxyInline, summary]) {
    assert.doesNotMatch(value, new RegExp(marker));
  }
  assert.equal(digestInline, 'prefix Authorization: [REDACTED]');
  assert.equal(awsInline, 'header=Authorization: [REDACTED]');
  assert.equal(proxyInline, 'prefix Proxy-Authorization: [REDACTED]');
});

test('redacts punctuation-delimited parameterized Authorization values', () => {
  const marker = 'NOFAX_PUNCTUATION_AUTH_SECRET_CANARY_XYZ';
  const objectLike = redactAndBound(`headers={Authorization: Digest username=alice, response="${marker}"}`);
  const wrapped = redactAndBound(`wrapper(Authorization: Digest username=alice, response="${marker}")`);
  const listLike = redactAndBound(`list,[Proxy-Authorization: Digest username=alice, response="${marker}"]`);
  const commaDelimited = redactAndBound(`x,Authorization: Digest username=alice, response=${marker}`);
  const nestedKey = redactAndBound(`header:Authorization: AWS4-HMAC-SHA256 Credential=AKIA/example, Signature=${marker}`);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: { command: `headers={Authorization: Digest username=alice, response="${marker}"}` }
  });

  for (const value of [objectLike, wrapped, listLike, commaDelimited, nestedKey, summary]) {
    assert.doesNotMatch(value, new RegExp(marker));
  }
  assert.equal(objectLike, 'headers={Authorization: [REDACTED]}');
  assert.equal(wrapped, 'wrapper(Authorization: [REDACTED])');
  assert.equal(listLike, 'list,[Proxy-Authorization: [REDACTED]]');
  assert.equal(commaDelimited, 'x,Authorization: [REDACTED]');
  assert.equal(nestedKey, 'header:Authorization: [REDACTED]');
});

test('redacts quoted Authorization keys with unquoted parameterized values', () => {
  const marker = 'NOFAX_QUOTED_KEY_AUTH_SECRET_CANARY_XYZ';
  const jsonLike = redactAndBound(`headers={"Authorization": Digest username=alice, response=${marker}}`);
  const singleQuoted = redactAndBound(`headers={'Authorization': AWS4-HMAC-SHA256 Credential=AKIA/example, Signature=${marker}}`);
  const proxy = redactAndBound(`headers={"Proxy-Authorization": Bearer ${marker}}`);
  const lineStart = redactAndBound(`"Authorization": Basic ${marker}`);
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: { command: `headers={"Authorization": Digest response=${marker}}` }
  });

  for (const value of [jsonLike, singleQuoted, proxy, lineStart, summary]) {
    assert.doesNotMatch(value, new RegExp(marker));
  }
  assert.equal(jsonLike, 'headers={"Authorization": [REDACTED]}');
  assert.equal(singleQuoted, "headers={'Authorization': [REDACTED]}");
  assert.equal(proxy, 'headers={"Proxy-Authorization": [REDACTED]}');
  assert.equal(lineStart, '"Authorization": [REDACTED]');
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

test('redacts curl user-info credentials in command strings', () => {
  const marker = 'NOFAX_CURL_USER_SECRET_CANARY_XYZ';
  const short = redactAndBound(`curl -u alice:${marker} https://example.test`);
  const long = redactAndBound(`curl --user=alice:${marker} https://example.test`);
  const proxy = redactAndBound(`curl --proxy-user 'proxy:${marker}' https://example.test`);
  const benign = redactAndBound('curl --user alice https://example.test');
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    cwd: '/tmp/project',
    toolInput: { command: `curl -u alice:${marker} https://example.test` }
  });

  for (const value of [short, long, proxy, summary]) {
    assert.doesNotMatch(value, new RegExp(marker));
  }
  assert.equal(short, 'curl -u alice:[REDACTED] https://example.test');
  assert.equal(long, 'curl --user=alice:[REDACTED] https://example.test');
  assert.equal(proxy, "curl --proxy-user 'proxy:[REDACTED]' https://example.test");
  assert.equal(benign, 'curl --user alice https://example.test');
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

test('marks truncation when redaction expansion crosses the per-string boundary', () => {
  const input = Array.from({ length: 45 }, (_, index) => `token=t${index}`).join(' ');
  assert.ok(input.length <= 500);

  const redacted = redactAndBound(input);

  assert.doesNotMatch(redacted, /token=t\d+/);
  assert.match(redacted, /…\[truncated\]$/);
});

test('summary truncation never splits astral Unicode', () => {
  const hasUnpairedSurrogate = (value) => {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  };

  const perString = redactAndBound(`${'a'.repeat(499)}\u{1F680}${'z'.repeat(30)}`);
  assert.equal(hasUnpairedSurrogate(perString), false);

  const baseInput = {
    first: 'a'.repeat(500),
    second: 'b'.repeat(500),
    third: `\u{1F680}${'z'.repeat(500)}`
  };
  const baseSerialized = JSON.stringify(redactAndBound(baseInput), null, 2);
  const padding = 1399 - baseSerialized.indexOf('\u{1F680}');
  assert.ok(padding > 0 && padding < 500);
  const serializedBoundary = buildAgentSummary({
    toolInput: {
      ...baseInput,
      third: `${'c'.repeat(padding)}\u{1F680}${'z'.repeat(500)}`
    }
  });
  assert.equal(hasUnpairedSurrogate(serializedBoundary), false);

  for (let paddingLength = 0; paddingLength <= 300; paddingLength += 1) {
    const finalBoundary = buildAgentSummary({
      source: 's'.repeat(500),
      toolName: 't'.repeat(500),
      cwd: 'c'.repeat(500),
      message: 'm'.repeat(500),
      toolInput: { note: `${'x'.repeat(paddingLength)}\u{1F680}${'y'.repeat(300)}` }
    });
    assert.equal(hasUnpairedSurrogate(finalBoundary), false);
  }
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
