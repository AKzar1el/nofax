import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSummary, createRequestId, createResponseTopic, redactAndBound } from '../src/protocol.mjs';

test('inline interpreter argv previews mask credential targets and retain benign context', () => {
  const marker = 'NOFAX_SYNTHETIC_INTERPRETER_X95';
  const python = [
    "import os; os.environ['API_KEY']='" + marker + "'",
    "import os; os.putenv('TOKEN','" + marker + "')",
    "import os; os.environ['API_'+'KEY']='" + marker + "'",
    "from os import environ as e; e['API_KEY']='" + marker + "'",
    "import os as x; x.environ['API_KEY']='" + marker + "'",
    "import os; os.environ.update({'API_KEY':'" + marker + "'})",
    "import os; os.environ[name]='" + marker + "'",
    "import os; os.environ.setdefault('API_KEY','" + marker + "')",
    "import os; getattr(os,'environ')['API_KEY']='" + marker + "'",
    "import os as x; getattr(x, attr)[name]='" + marker + "'",
    "from os import putenv as p; p('API_KEY','" + marker + "')",
    "import os; e=os.environ; e['API_KEY']='" + marker + "'",
    "import os; os.environ['API\\x5fKEY']='" + marker + "'",
    "import os; os.environ['API_KEY'] += '" + marker + "'",
    "import os; os.environb[b'API_KEY']=b'" + marker + "'",
    "import os; os.environ['API_KEY']=sys.argv[1]",
    "import os; os.environ.setdefault(name,'" + marker + "')",
    "__import__('os').environ['API_KEY']='" + marker + "'",
  ];
  const node = [
    "process.env['API_KEY']='" + marker + "'",
    "process.env[key]='" + marker + "'",
    "const e=process.env; e.API_KEY='" + marker + "'",
    "const {env:e}=require('process'); e['API_KEY']='" + marker + "'",
    "Reflect.set(process.env,'API_KEY','" + marker + "')",
    "process['env']['API_KEY']='" + marker + "'",
    "process.env['API_'+'KEY']='" + marker + "'",
    "process.env.API_KEY += '" + marker + "'",
    "const p=process; p.env.API_KEY='" + marker + "'",
    "globalThis['process'].env.API_KEY='" + marker + "'",
    "const p=require('node:process'); p.env.API_KEY='" + marker + "'",
    "Object.defineProperty(process.env,'API_KEY',{value:'" + marker + "'})",
    "process.env['API\\x5fKEY']='" + marker + "'",
    "process[env][key]='" + marker + "'",
    "process.env.API_KEY=process.argv[1]",
    "Reflect.set(process['env'],key,'" + marker + "')",
    "const p = globalThis.process; p.env.API_KEY='" + marker + "'",
  ];
  const sensitive = [
    ...python.map(code => ['python', '-c', code, marker]),
    ...node.map(code => ['node', '-e', code, marker]),
    ['C:\\Python\\python3.11.exe', '-W', 'ignore', '-c', python[0]],
    ['py', '-3.11', '-c' + python[1]],
    ['node', '-r', 'example-module', '--eval', node[0]],
    ['node.exe', '--eval=' + node[1]],
    ['node', '-pe', node[0]],
    ['node', '--print', node[2]],
    ['python', '-Ic', python[0]],
    ['pythonw.exe', '-c', python[0]],
    ['pyw.exe', '-c', python[0]],
    ['nodejs', '-e', node[0]],
    ['python', '-IW', 'ignore', '-c', python[0]],
    ['node', '-e', 'console.log(1)', '-e', node[0]],
    ['node', '--experimental-policy', 'policy.json', '-e', node[0]],
    ['node', '-e', "const r=/[//]/; " + node[0]],
    ['node', '-e', "const p=require('pro'+'cess'); p.env['API_KEY']='" + marker + "'"],
    ['node', '-e', "globalThis[which].env['API_KEY']='" + marker + "'"],
  ];
  const benign = [
    ['python', '-c', "import os; os.environ['NOTE']='" + marker + "'"],
    ['python', '-c', "print('" + marker + " os.environ')"],
    ['python', '-c', "# os.environ['API_KEY']\nprint('" + marker + "')"],
    ['python', '-c', "import os; os.putenv('NOTE','" + marker + "')"],
    ['python', '-c', "import os; print(os.environ.get('NOTE'),'" + marker + "')"],
    ['python', '-c', "import os; print(os.getcwd(),'" + marker + "')"],
    ['python', '-c', "print('''" + marker + " os.environ['API_KEY']''')"],
    ['python', '-c', "import os as x; x.environ['NOTE']='" + marker + "'"],
    ['node', '-e', "process.env.NOTE='" + marker + "'"],
    ['node', '-e', "console.log('" + marker + " process.env')"],
    ['node', '-e', "// process.env.API_KEY\nconsole.log('" + marker + "')"],
    ['node', '-e', "process.env['NOTE']='" + marker + "'"],
    ['node', '-e', "process['env']['NOTE']='" + marker + "'"],
    ['node', '-e', "console.log(process.cwd(),'" + marker + "')"],
    ['node', '-e', "/* process.env.API_KEY */console.log('" + marker + "')"],
    ['node', '-e', "console.log('" + marker + "')"],
    ['echo', 'node', marker],
    ['python', 'script.py', '-c', "print('" + marker + "')"],
    ['node', 'script.js', '-e', marker],
    ['python', '-Ic', "print('" + marker + "')"],
    ['pythonw.exe', '-c', "print('" + marker + "')"],
    ['nodejs', '-e', "console.log('" + marker + "')"],
    ['python', '-IW', 'ignore', '-c', "print('" + marker + "')"],
    ['node', '-r', 'example-module', '-e', "console.log('" + marker + "')"],
    ['node', '-e', "const r=/hello/; console.log('" + marker + "')"],
    ['node', '-e', "console.log(4 / 2, '" + marker + "')"],
  ];
  for (const [argv, masked] of [...sensitive.map(a => [a, true]), ...benign.map(a => [a, false])]) {
    const object = { command: argv, note: 'safe sibling' };
    for (const input of [argv, object, JSON.stringify(argv), JSON.stringify(object), JSON.stringify(JSON.stringify(object)), JSON.stringify({ nested: JSON.stringify(object), note: 'safe sibling' })]) {
      for (const output of [JSON.stringify(redactAndBound(input)), buildAgentSummary({ toolInput: input })]) {
        assert.equal(output.includes(marker), !masked, 'interpreter preview privacy or benign context: ' + argv[0]);
        if (masked) assert.match(output, /REDACTED/);
        if (input !== argv && input !== JSON.stringify(argv)) assert.match(output, /safe sibling/);
      }
    }
  }
  const duplicate = '{"argv":["\\u006eode","-e",' + JSON.stringify(node[0]) + '],"mode":"one","mode":"two"}';
  assert.ok(!redactAndBound(duplicate).includes(marker));
  assert.match(redactAndBound(duplicate), /"mode":"one","mode":"two"/);
});

test('typed PowerShell provider argv preserves privacy and benign review context', () => {
  const marker = 'NOFAX_SYNTHETIC_PS_ARGV_X92';
  const sensitive = [
    ['Set-Item', 'Env:API_KEY', marker],
    ['Set-Item', '-Path', 'Env:TOKEN', '-Value', marker],
    ['Set-Item', '-Value', marker, '-LiteralPath', 'Variable:API_KEY'],
    ['New-Item', '-Path', 'Env:', '-Name', 'API_KEY', '-Value', marker],
    ['New-Item', '-Path', 'Env:', '-Value', marker],
    ['Set-Content', '-Path:Environment::API_KEY', '-Value:' + marker],
    ['Set-Variable', 'API_KEY', marker],
    ['Set-Variable', '-Value', marker, '-Name', 'API_KEY'],
    ['Set-Variable', '-Name', 'NOTE', 'API_KEY', '-Value', marker],
    ['Set-Item', '-Path', ['Env:NOTE', 'Env:API_KEY'], '-Value', marker],
    ['Set-Item', '-Path', 'Env:NOTE', 'Env:API_KEY', '-Value', marker],
    ['Set-Item', '-Path', 'Env:NOTE', '-Path', 'Env:API_KEY', '-Value', marker],
    ['Set-Item', '-P', 'Env:API_KEY', '-V', marker],
    ['Microsoft.PowerShell.Management\\Set-Item', '-Path', 'Environment::API_KEY', '-Value', marker],
    ['Set-Variable', '-Name', 'NOTE', '-Credential', marker, '-Value', 'safe'],
    ['Set-Item', '-Path', 'Env:$name', '-Value', marker],
  ];
  for (const argv of sensitive) {
    const object = { command: argv, note: 'safe sibling' };
    for (const input of [argv, object, JSON.stringify(argv), JSON.stringify(object), JSON.stringify(JSON.stringify(object)), JSON.stringify({ nested: JSON.stringify(object), note: 'safe sibling' })]) {
      for (const output of [JSON.stringify(redactAndBound(input)), buildAgentSummary({ toolInput: input })]) {
        assert.ok(!output.includes(marker), 'credential argv leaked for ' + argv[0]);
        assert.match(output, /REDACTED/);
        if (input !== argv && input !== JSON.stringify(argv)) assert.match(output, /safe sibling/);
      }
    }
  }
  const duplicate = '{"argv":["\\u0053et-Item","Env:API_KEY","' + marker + '"],"mode":"one","mode":"two"}';
  assert.ok(!redactAndBound(duplicate).includes(marker));
  assert.match(redactAndBound(duplicate), /"mode":"one","mode":"two"/);
  for (const argv of [
    ['Set-Item', 'Env:NOTE', marker],
    ['Set-Item', '-Path', 'Env:NOTE', '-Value', marker],
    ['Set-Variable', '-Value', marker, '-Name', 'NOTE'],
    ['Set-Variable', 'NOTE', marker],
    ['New-Item', '-Path', 'Env:', '-Name', 'NOTE', '-Value', marker],
    ['Set-Content', '-Value', marker, '-Path', 'notes with spaces.txt'],
    ['Microsoft.PowerShell.Management\\Set-Item', '-Path', 'Environment::NOTE', '-Value', marker],
    ['echo', 'Set-Item', marker],
  ]) {
    assert.deepEqual(redactAndBound(argv), argv);
    const serialized = JSON.stringify({ command: argv, note: 'safe sibling' });
    assert.equal(redactAndBound(serialized), serialized);
    assert.match(buildAgentSummary({ toolInput: { command: argv } }), new RegExp(marker));
  }
});

test('structured setx credential argv is private in typed and serialized previews', () => {
  const marker = 'NOFAX_SYNTHETIC_ARGV_X91';
  const cases = [
    ['setx', 'API_KEY', marker],
    ['SETX.EXE', 'GITHUB_PAT', marker, '/m'],
    ['C:\\Windows\\System32\\setx.exe', 'TOKEN', marker],
    ['setx', '/m', 'API_KEY', marker],
    ['setx', '/s', 'example.invalid', '/u', 'synthetic', '/p', marker, 'NOTE', 'safe'],
    ['setx', 'API_KEY', { value: marker }],
  ];
  for (const argv of cases) {
    const object = { command: argv, note: 'safe sibling' };
    for (const input of [argv, object, JSON.stringify(argv), JSON.stringify(object), JSON.stringify(JSON.stringify(object)), JSON.stringify({ nested: JSON.stringify(object), note: 'safe sibling' })]) {
      const bounded = JSON.stringify(redactAndBound(input));
      const summary = buildAgentSummary({ toolInput: input });
      for (const output of [bounded, summary]) {
        assert.ok(!output.includes(marker), 'credential argv leaked');
        assert.match(output, /REDACTED/);
        if (input !== argv && input !== JSON.stringify(argv)) assert.match(output, /safe sibling/);
      }
    }
  }
  const duplicate = `{"argv":["\\u0073etx","API_KEY","${marker}"],"mode":"first","mode":"second"}`;
  const output = redactAndBound(duplicate);
  assert.ok(!output.includes(marker));
  assert.match(output, /"mode":"first","mode":"second"/);
  for (const argv of [['setx', 'NOTE', marker], ['setx.exe', 'NOTE', marker, '/m'], ['echo', 'API_KEY', marker], ['setx', '/?']]) {
    assert.deepEqual(redactAndBound(argv), argv);
    const serialized = JSON.stringify({ command: argv, note: 'safe sibling' });
    assert.equal(redactAndBound(serialized), serialized);
  }
});

test('PowerShell provider credential command previews omit sensitive arguments', () => {
  const marker = 'NOFAX_CANARY_X91';
  const commands = [
    `Set-Item Env:API_KEY '${marker}'`,
    `Set-Item -Path 'Env:API_KEY' -Value '${marker}'`,
    `Set-Item -Value '${marker}' -LiteralPath Env:API_KEY`,
    `Set-Item -Confirm:$false -Path Env:API_KEY -Value '${marker}'`,
    `Set-Item -WhatIf -Path:Env:API_KEY -Value:'${marker}'`,
    `New-Item -Path Env:API_KEY -Value '${marker}' -Force`,
    `Set-Content -Value '${marker}' -LiteralPath 'Variable:API_KEY'`,
    `Set-Variable API_KEY '${marker}'`,
    `Set-Variable -Value '${marker}' -Name API_KEY -Scope Global`,
    `Set-Variable -Name:API_KEY -Value:'${marker}'`,
    `Set-Variable -Confirm:$false -Name API_KEY -Value '${marker}'`,
    `Set-Item Env:API_KEY ('${marker};nested')`,
    `Set-Item -P:Env:API_KEY -V:'${marker}'`,
    `New-Item -Path Env: -Name API_KEY -Value '${marker}'`,
    `Set-Item -Path @('Env:NOTE','Env:API_KEY') -Value '${marker}'`,
    `Set-Item -Path (Join-Path Env: API_KEY) -Value '${marker}'`,
    `Microsoft.PowerShell.Management\\Set-Item -Path Environment::API_KEY -Value '${marker}'`,
  ];
  for (const command of commands) {
    const input = `${command}; echo mode=safe`;
    for (const preview of [input, JSON.stringify(input), JSON.stringify(JSON.stringify(input))]) {
      const bounded = redactAndBound(preview);
      const summary = buildAgentSummary({ source: 'Codex', toolName: 'shell', toolInput: { command: preview } });
      for (const output of [bounded, summary]) {
        assert.ok(!output.includes(marker), `credential value leaked for ${command.split(' ')[0]}`);
        assert.match(output, /REDACTED/);
        assert.match(output, /mode=safe/);
      }
    }
  }
  for (const malformed of [`Set-Item Env:API_KEY '${marker}`, `Set-Variable -Name API_KEY -Value '${marker}`]) {
    assert.ok(!redactAndBound(malformed).includes(marker));
  }
  const hereString = ["Set-Item Env:API_KEY @'", "unpaired ' quote", marker, "'@", 'echo mode=safe'].join('\n');
  for (const input of [hereString, JSON.stringify(hereString)]) {
    const output = redactAndBound(input);
    assert.ok(!output.includes(marker));
    assert.match(output, /mode=safe/);
  }
  const serialized = JSON.stringify({
    command: commands[2],
    mode: 'safe',
    nested: JSON.stringify({ command: commands[8], note: 'safe sibling' }),
  });
  for (const input of [serialized, JSON.stringify(serialized)]) {
    const output = redactAndBound(input);
    assert.ok(!output.includes(marker));
    assert.match(output, /safe sibling/);
    assert.match(output, /mode/);
  }
  const duplicateFields = '{"command":"Set-Item Env:NOTE harmless","mode":"one","mode":"two"}';
  assert.equal(redactAndBound(duplicateFields), duplicateFields);
  for (const benign of [
    `Set-Item Env:NOTE '${marker}'; echo mode=safe`,
    `Set-Content -Value '${marker}' -Path 'notes.txt'`,
    `Set-Variable -Value '${marker}' -Name NOTE`,
    `Set-Variable NOTE '${marker}'`,
    `Set-Variable -Value 'api_key' -Name NOTE`,
    `New-Item -Path Env: -Name NOTE -Value '${marker}'`,
    `Microsoft.PowerShell.Management\\Set-Item -Path Environment::NOTE -Value '${marker}'`,
  ]) {
    assert.equal(redactAndBound(benign), benign);
  }
});

test('approval summaries expose display-control characters literally instead of executing them', () => {
  const input = 'echo safe\rOVERWRITE\u001b[2K\u202e--hidden\u2066\u0000\u2028Spoofed heading\u2029';
  const marker = 'NOFAX_SYNTHETIC_DISPLAY_CONTROL_SECRET_12345';
  const summary = buildAgentSummary({
    source: 'Codex',
    message: `Review this command: ${input}; api_key=${marker}`
  });
  const bounded = redactAndBound(input);
  for (const output of [summary, bounded]) {
    assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/u);
    assert.match(output, /\\u000dOVERWRITE\\u001b\[2K\\u202e--hidden\\u2066\\u0000\\u2028Spoofed heading\\u2029/);
    assert.match(output, /echo safe/);
  }
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.match(summary, /api_key=\[REDACTED\]/);
});

test('control-interrupted credential labels cannot expose values in serialized approval previews', () => {
  const marker = 'NOFAX_SYNTHETIC_CONTROL_KEY_SECRET_20261122';
  for (const key of ['api\u001b[0m_key', 'to\u001b[0mken', 'api\u0000_key']) {
    const object = { [key]: marker, note: 'safe detail' };
    assert.equal(redactAndBound(object)[key], '[REDACTED]', 'structured credential keys must be classified');
    assert.equal(redactAndBound({ name: key, value: marker }).value, '[REDACTED]');
    for (const fixture of [`${key}=${marker} mode=safe`, JSON.stringify(object), `echo ${JSON.stringify(object)}`]) {
      for (const input of [fixture, JSON.stringify(fixture), JSON.stringify(JSON.stringify(fixture))]) {
        for (const output of [redactAndBound(input), buildAgentSummary({ toolInput: { command: input } })]) {
          assert.equal(output.includes(marker), false, 'control-interrupted key must mask its value');
          assert.match(output, /safe/, 'benign approval context must survive');
        }
      }
    }
  }

  const benign = `no\u001b[0mte=${marker} mode=safe`;
  for (const input of [benign, JSON.stringify(benign), JSON.stringify(JSON.stringify(benign))]) {
    assert.match(redactAndBound(input), new RegExp(marker), 'nonsecret control-interrupted keys remain readable');
  }

  const malformed = `echo {"api\\u001b[0m_key":${marker},"note":"safe detail"}`;
  for (const output of [redactAndBound(malformed), buildAgentSummary({ toolInput: { command: malformed } })]) {
    assert.equal(output.includes(marker), false, 'malformed encoded control-key context must fail closed');
  }
});

test('approval summaries visibly escape hidden format marks but preserve emoji joiners', () => {
  const message = 'Allow\u034f\u061c\u200b\u200e\u200f\u2060\u2061\u2062\u2063\u2064\ufeff now\nDeveloper 👩\u200d💻';
  const outputs = [
    redactAndBound(message),
    buildAgentSummary({ message, toolInput: { note: message } })
  ];
  for (const output of outputs) {
    for (const codePoint of ['034f', '061c', '200b', '200e', '200f', '2060', '2061', '2062', '2063', '2064', 'feff']) {
      assert.doesNotMatch(output, new RegExp(String.fromCodePoint(Number.parseInt(codePoint, 16))));
      assert.ok(output.includes(`\\u${codePoint}`), `format mark U+${codePoint} must be visible`);
    }
    assert.ok(output.includes('Developer 👩\u200d💻'), 'joined emoji must remain intact');
  }
  assert.ok(outputs[1].includes(' now\nDeveloper'), 'ordinary line breaks remain readable');
});

test('approval summaries expose blank filler glyphs and soft hyphens in decision words', () => {
  for (const codePoint of ['00ad', '115f', '1160', '180e', '2800', '3164', 'ffa0']) {
    const hidden = String.fromCodePoint(Number.parseInt(codePoint, 16));
    const message = `ap${hidden}prove`;
    for (const output of [redactAndBound(message), buildAgentSummary({ message, toolInput: { note: message } })]) {
      assert.equal(output.includes(hidden), false, `U+${codePoint} must not remain invisible`);
      assert.ok(output.includes(`ap\\u${codePoint}prove`), `U+${codePoint} must be shown as an escape`);
    }
  }
});

test('approval summaries expose non-emoji joiners without breaking emoji sequences', () => {
  const message = 'A\u200cllow D\u200deny Team 👩🏽\u200d💻';
  for (const output of [
    redactAndBound(message),
    buildAgentSummary({ message, toolInput: { note: message } })
  ]) {
    assert.ok(output.includes('A\\u200cllow D\\u200deny'), 'hidden joiners in words must be visible');
    assert.ok(output.includes('👩🏽\u200d💻'), 'emoji ZWJ with skin-tone modifier stays joined');
  }
});

test('YAML anchors referenced by credential aliases hide their source values in approval previews', () => {
  const marker = 'NOFAX_YAML_ALIAS_SYNTHETIC_SECRET_8642';
  const fixtures = [
    `metadata: &shared ${marker}\napi_key: *shared\nmode: safe`,
    `config:\n  note: &shared "${marker}"\n  token: *shared\n  mode: safe`,
    `config:\n  note: &shared |\n    ${marker}\n  password: *shared\n  mode: safe`,
    `metadata: &shared >\r\n  ${marker}\r\nauthorization: *shared\r\nmode: safe`
  ];
  for (const fixture of fixtures) {
    for (const input of [fixture, JSON.stringify(fixture), JSON.stringify(JSON.stringify(fixture))]) {
      for (const output of [redactAndBound(input), buildAgentSummary({ toolInput: { command: input } })]) {
        assert.equal(output.includes(marker), false, 'a credential alias must taint its anchor definition');
        assert.match(output, /mode: safe/, 'unrelated approval context remains readable');
      }
    }
  }
  const benign = `metadata: &safe ${marker}\nmode: *safe`;
  for (const input of [benign, JSON.stringify(benign), JSON.stringify(JSON.stringify(benign))]) {
    assert.match(redactAndBound(input), new RegExp(marker), 'unreferenced benign anchor remains readable');
  }
});

test('YAML flow mappings cannot expose source values referenced by credential aliases', () => {
  const marker = 'NOFAX_YAML_FLOW_ALIAS_SYNTHETIC_SECRET_4912';
  const fixtures = [
    `metadata: &shared ${marker}\nconfig: {api_key: *shared, mode: safe}\nmode: safe`,
    `metadata: &shared "${marker}"\nconfig: {"token": *shared}\nmode: safe`,
    `metadata: &shared ${marker}\nconfig: {'password': *shared, note: okay}\nmode: safe`,
    `metadata: &shared ${marker}\nconfig: [{authorization: *shared}]\nmode: safe`,
    `metadata: &shared ${marker}\nconfig: {note: okay,\n  api_key: *shared}\nmode: safe`
  ];
  for (const fixture of fixtures) {
    for (const input of [fixture, JSON.stringify(fixture), JSON.stringify(JSON.stringify(fixture))]) {
      for (const output of [redactAndBound(input), buildAgentSummary({ toolInput: { command: input } })]) {
        assert.equal(output.includes(marker), false, 'flow-map credential aliases must taint their anchor definition');
        // Escaped multiline flow maps may conservatively suppress a following
        // scalar; their preceding nonsecret mapping must remain visible.
        assert.match(output, fixture.includes('note: okay,\n') ? /note: okay/ : /mode: safe/,
          'independent nonsecret context remains readable');
      }
    }
  }
  const benign = `metadata: &shared ${marker}\nconfig: {mode: *shared}`;
  for (const input of [benign, JSON.stringify(benign), JSON.stringify(JSON.stringify(benign))]) {
    assert.match(redactAndBound(input), new RegExp(marker), 'nonsecret flow aliases must not taint their anchor');
  }
});

test('serialized credential previews retain independent YAML sibling context', () => {
  const marker = 'NOFAX_SERIALIZED_CONTEXT_SYNTHETIC_SECRET_6427';
  const fixtures = [
    `metadata: &shared ${marker}\nconfig: {note: okay,\n  api_key: *shared}\nmode: safe`,
    `metadata: &shared "${marker}"\nconfig: {"token": *shared,\n  hint: clear}\nmode: safe`,
    `api_key: ${marker}\nmode: safe`
  ];
  for (const fixture of fixtures) {
    for (const input of [JSON.stringify(fixture), JSON.stringify(JSON.stringify(fixture))]) {
      for (const output of [redactAndBound(input), buildAgentSummary({ toolInput: { command: input } })]) {
        assert.equal(output.includes(marker), false, 'serialized credential content remains masked');
        assert.match(output, /mode: safe/, 'an independent YAML sibling remains readable');
      }
    }
  }
});

test('TOML and dotenv multiline credentials hide their bodies without hiding safe sibling fields', () => {
  const marker = 'NOFAX_TOML_MULTILINE_SYNTHETIC_SECRET_4197';
  const fixtures = [
    `api_key = """\n${marker}\n"""\nmode = safe`,
    `token = '''\r\n${marker}\r\n'''\r\nmode = safe`,
    `credentials.password = """\nquoted \\""" then ${marker}\n"""\nmode = safe`,
    `export PRIVATE_KEY="first line\n${marker}\nlast line"\nmode = safe`,
    `TOKEN='first line\n${marker}\nlast line'\nmode = safe`,
    `password = """\n${marker}\nmode = safe`
  ];

  for (const fixture of fixtures) {
    for (const input of [fixture, JSON.stringify(fixture), JSON.stringify(JSON.stringify(fixture))]) {
      for (const output of [redactAndBound(input), buildAgentSummary({ toolInput: { command: input } })]) {
        assert.equal(output.includes(marker), false, 'multiline credential body must not appear in approval preview');
        if (fixture.includes('last line') || fixture.includes('"""\nmode') || fixture.includes("'''\r\nmode")) {
          assert.match(output, /mode = safe/, 'valid nonsecret sibling must remain readable');
        }
      }
    }
  }

  const benign = `notes = """\n${marker}\n"""\nmode = safe`;
  for (const input of [benign, JSON.stringify(benign), JSON.stringify(JSON.stringify(benign))]) {
    assert.match(redactAndBound(input), new RegExp(marker), 'nonsecret multiline text remains readable');
    assert.match(redactAndBound(input), /mode = safe/);
  }
});

test('shell heredoc and PowerShell here-string credentials hide bodies but retain safe commands', () => {
  const marker = 'NOFAX_SHELL_MULTILINE_SYNTHETIC_SECRET_5729';
  const fixtures = [
    `export TOKEN=$(cat <<'SECRET_END'\n${marker}\nSECRET_END\n)\nmode=safe`,
    `API_KEY=$(cat <<-EOF\r\n\tNOT_EOF\r\n\t${marker}\r\n\tEOF\r\n)\r\nmode=safe`,
    `$env:PRIVATE_KEY = @'\n${marker}\n'@\nmode=safe`,
    `$password = @"\r\n${marker}\r\n"@\r\nmode=safe`
  ];

  for (const fixture of fixtures) {
    for (const input of [fixture, JSON.stringify(fixture), JSON.stringify(JSON.stringify(fixture))]) {
      for (const output of [redactAndBound(input), buildAgentSummary({ toolInput: { command: input } })]) {
        assert.equal(output.includes(marker), false, 'credential block contents must be hidden');
        assert.match(output, /mode=safe/, 'a command after the terminator must stay visible');
      }
    }
  }

  const unclosed = `TOKEN=$(cat <<EOF\n${marker}\nNOT_EOF\nmode=safe`;
  for (const output of [redactAndBound(unclosed), buildAgentSummary({ message: unclosed })]) {
    assert.equal(output.includes(marker), false, 'unterminated credential blocks fail closed');
  }

  const deceptiveClosingLine = "$password = @'\n" + marker + "\n  '@\n" + marker + "\n'@\nmode=safe";
  const deceptiveHeredoc = 'TOKEN=$(cat <<EOF\n  EOF\n' + marker + '\nEOF\n)\nmode=safe';
  for (const fixture of [deceptiveClosingLine, deceptiveHeredoc]) {
    for (const input of [fixture, JSON.stringify(fixture), JSON.stringify(JSON.stringify(fixture))]) {
      const output = buildAgentSummary({ toolInput: { command: input } });
      assert.equal(output.includes(marker), false, 'an indented false terminator must not expose remaining secrets');
      assert.match(output, /mode=safe/);
    }
  }

  const benign = `notes=$(cat <<'END'\n${marker}\nEND\n)\nmode=safe`;
  for (const input of [benign, JSON.stringify(benign), JSON.stringify(JSON.stringify(benign))]) {
    assert.match(redactAndBound(input), new RegExp(marker), 'nonsecret heredocs remain readable');
    assert.match(redactAndBound(input), /mode=safe/);
  }
});

test('redacts credentials from escaped and double-escaped JSON in agent summaries', () => {
  const marker = 'NOFAX_SYNTHETIC_ESCAPED_JSON_SECRET_CANARY_12345';
  const object = JSON.stringify({ api_key: marker, accessToken: marker, note: 'run tests' });
  const escaped = JSON.stringify(object);
  for (const text of [escaped, JSON.stringify(escaped), 'echo ' + escaped]) {
    const summary = buildAgentSummary({ source: 'Codex', toolName: 'shell', toolInput: { command: text } });
    const bounded = redactAndBound(text);
    assert.equal(summary.includes(marker), false, 'approval summary must not expose escaped secret');
    assert.equal(bounded.includes(marker), false, 'bounded string must not expose escaped secret');
    assert.match(summary, /Source: Codex/, 'redaction must retain the approval source');
    assert.match(summary, /run tests/, 'nonsecret JSON content must remain visible');
    assert.match(bounded, /run tests/, 'nonsecret bounded content must remain visible');
  }

  const quotedSecret = JSON.stringify({ api_key: 'prefix"' + marker + '"suffix', note: 'safe detail' });
  for (const text of [JSON.stringify(quotedSecret), JSON.stringify(JSON.stringify(quotedSecret))]) {
    const summary = buildAgentSummary({ source: 'Codex', toolName: 'shell', toolInput: { command: text } });
    assert.equal(summary.includes(marker), false, 'escaped quotes inside a credential must not end redaction early');
    assert.match(summary, /safe detail/, 'later nonsecret fields must remain visible');
  }
});

test('redacts credentials whose JSON property names use Unicode escapes', () => {
  const marker = 'NOFAX_SYNTHETIC_UNICODE_KEY_CANARY_98765';
  const raw = `{"\\u0061pi\\u005fkey":"${marker}","note":"safe detail"}`;
  const quoted = `{"access\\u0054oken":"prefix\\\"${marker}\\\"suffix","note":"safe detail"}`;
  for (const serialized of [raw, quoted]) {
    for (const text of [serialized, JSON.stringify(serialized), JSON.stringify(JSON.stringify(serialized)), `echo ${serialized}`]) {
      const summary = buildAgentSummary({ source: 'Codex', toolName: 'shell', toolInput: { command: text } });
      const bounded = redactAndBound(text);
      assert.equal(summary.includes(marker), false, 'summary must not expose obfuscated JSON credentials');
      assert.equal(bounded.includes(marker), false, 'bounded string must not expose obfuscated JSON credentials');
      assert.match(summary, /safe detail/, 'preserve nonsecret JSON fields');
    }
  }
  const benign = '{"he\\u006clo":"safe detail"}';
  assert.match(redactAndBound(benign), /safe detail/, 'unrelated Unicode escapes remain visible');
});

test('redacts compatibility-width credential labels without changing benign approval context', () => {
  const marker = 'NOFAX_SYNTHETIC_NFKC_CREDENTIAL_CANARY_20261121';
  const keys = ['ａｐｉ＿ｋｅｙ', 'ａｃｃｅｓｓＴｏｋｅｎ', 'ｐａｓｓｗｏｒｄ', 'ａｕｔｈｏｒｉｚａｔｉｏｎ'];
  for (const key of keys) {
    const object = { [key]: marker, notes: 'safe detail' };
    const boundedObject = redactAndBound(object);
    const objectSummary = buildAgentSummary({ source: 'Codex', toolInput: object });
    assert.equal(boundedObject[key], '[REDACTED]', `structured key ${key} must be classified`);
    assert.doesNotMatch(objectSummary, new RegExp(marker));
    assert.match(objectSummary, /safe detail/);
    assert.equal(redactAndBound({ name: key, value: marker, notes: 'safe detail' }).value, '[REDACTED]');

    const encoded = JSON.stringify(object);
    const samples = [
      `${key}=${marker} mode=safe`,
      encoded,
      JSON.stringify(encoded),
      JSON.stringify(JSON.stringify(encoded))
    ];
    for (const sample of samples) {
      const outputs = [
        redactAndBound(sample),
        buildAgentSummary({ source: 'Claude Code', toolName: 'Bash', toolInput: { command: sample } })
      ];
      for (const output of outputs) {
        assert.equal(output.includes(marker), false, `preview must redact compatibility key ${key}`);
        assert.match(output, /safe/, 'nonsecret context must remain visible');
      }
    }

    const quoted = JSON.stringify({ [key]: `prefix\\"${marker}\\"suffix`, notes: 'safe detail' });
    for (const sample of [quoted, JSON.stringify(quoted), JSON.stringify(JSON.stringify(quoted))]) {
      assert.equal(redactAndBound(sample).includes(marker), false, 'nested quoted credential stays redacted');
      assert.equal(buildAgentSummary({ toolInput: { command: sample } }).includes(marker), false);
    }
  }

  const benign = { 'ｎｏｔｅｓ': marker, mode: 'safe' };
  const benignText = JSON.stringify(benign);
  assert.equal(redactAndBound(benign)['ｎｏｔｅｓ'], marker);
  assert.match(redactAndBound(benignText), new RegExp(marker), 'benign compatibility label remains readable');
  assert.match(buildAgentSummary({ toolInput: benign }), new RegExp(marker));
});

test('Unicode spacing inside credential labels cannot expose values in serialized previews', () => {
  const marker = 'NOFAX_SYNTHETIC_UNICODE_SPACING_SECRET_20261123';
  for (const space of ['\u00a0', '\u2007', '\u2009', '\u202f']) {
    const key = `api${space}key`;
    const object = { [key]: marker, note: 'safe detail' };
    assert.equal(redactAndBound(object)[key], '[REDACTED]');

    const fixtures = [
      `${key}=${marker} mode=safe`,
      `${key}="${marker}" mode=safe`,
      JSON.stringify(object),
      `echo ${JSON.stringify(object)}`
    ];
    for (const fixture of fixtures) {
      for (const input of [fixture, JSON.stringify(fixture), JSON.stringify(JSON.stringify(fixture))]) {
        for (const output of [redactAndBound(input), buildAgentSummary({ toolInput: { command: input } })]) {
          assert.equal(output.includes(marker), false, 'Unicode-spaced credential value must be hidden');
          assert.match(output, /safe/, 'independent benign context must remain');
        }
      }
    }

    for (const input of [`no${space}te=${marker} mode=safe`, JSON.stringify(`no${space}te=${marker} mode=safe`)]) {
      assert.match(redactAndBound(input), new RegExp(marker), 'benign Unicode-spaced keys remain readable');
    }
  }
});

test('shell expression credential values stay hidden without erasing benign sibling context', () => {
  const marker = 'NOFAX_SYNTHETIC_SHELL_EXPANSION_CANARY_20261124';
  const samples = [
    `export api_key=$'prefix_${marker}' mode=safe`,
    `api_key=$"prefix_${marker}" mode=safe`,
    `api_key=$(printf '%s' '${marker}') mode=safe`,
    `api_key=prefix$'${marker}' mode=safe`,
    `api_key=prefix"${marker}" mode=safe`,
    `api_key=prefix$(printf '%s' '${marker}') mode=safe`,
    `api_key=prefix\`printf_${marker}\` mode=safe`,
    `api_key=prefix\\ ${marker} mode=safe`,
    `api_key="$(printf '%s' '${marker}')" mode=safe`,
    `api_key=prefix\${UNSET:-${marker}} mode=safe`,
    `api_key=prefix\${UNSET:-$(printf '%s' '${marker}')} mode=safe`,
    `api_key=prefix\\\n${marker}\nmode=safe`
  ];

  for (const sample of samples) {
    for (const input of [sample, JSON.stringify(sample), JSON.stringify(JSON.stringify(sample))]) {
      for (const output of [
        redactAndBound(input),
        buildAgentSummary({ source: 'Claude Code', toolName: 'Bash', toolInput: { command: input } })
      ]) {
        assert.equal(output.includes(marker), false, `shell credential must be redacted: ${sample.split('=')[0]}`);
        assert.match(output, /mode=safe/, 'independent shell argument must remain visible');
      }
    }
  }

  for (const input of [`api_key=$(printf '%s' '${marker}' mode=safe`, `api_key=$'${marker} mode=safe`]) {
    assert.equal(redactAndBound(input).includes(marker), false, 'malformed shell expressions must fail closed');
  }
  assert.match(redactAndBound(`note=$'${marker}' mode=safe`), new RegExp(marker));
});

test('redacts credentials hidden by percent-encoded query parameter names', () => {
  const marker = 'NOFAX_SYNTHETIC_ENCODED_QUERY_SECRET_12345';
  for (const key of ['api_key', 'api%5Fkey', 'tok%65n', '%74oken', 'api+key', 'access+token', '%61pi+key']) {
    const command = `curl https://example.invalid/path?${key}=${marker}&mode=safe`;
    const summary = buildAgentSummary({ source: 'Codex', toolName: 'shell', toolInput: { command } });
    const bounded = redactAndBound(command);
    for (const text of [summary, bounded]) {
      assert.equal(text.includes(marker), false, `query credential ${key} must not leak`);
      assert.match(text, /\[REDACTED\]/);
      assert.match(text, /mode=safe/, 'nonsecret query remains visible');
    }
  }
  assert.match(redactAndBound('https://example.invalid/?m%6fde=safe'), /m%6fde=safe/);
  assert.match(redactAndBound('https://example.invalid/?mode+name=safe'), /mode\+name=safe/);
});

test('redacts separator-rich credential names inside nested JSON strings', () => {
  const marker = 'NOFAX_SEPARATOR_KEY_SECRET_CANARY_98765';
  const payload = JSON.stringify({
    'api.key': marker,
    'auth.header': marker,
    'private key': marker,
    'api/key': marker,
    'safe.text': 'safe detail'
  });

  for (const input of [payload, JSON.stringify(payload), JSON.stringify(JSON.stringify(payload))]) {
    const bounded = redactAndBound(input);
    const summary = buildAgentSummary({ toolInput: { command: input } });
    assert.equal(bounded.includes(marker), false, 'nested string must not leak separated secret keys');
    assert.equal(summary.includes(marker), false, 'approval summary must not leak separated secret keys');
    assert.match(bounded, /safe detail/, 'nonsecret dotted key must remain visible');
  }

  for (const input of [
    `api.key=${marker}`,
    `auth.header="${marker}"`,
    `api/key='${marker}'`
  ]) {
    assert.equal(redactAndBound(input).includes(marker), false, 'flat separated credential must be redacted');
  }

  const unicode = '{"api\\u002ekey":"' + marker + '","auth\\u002fheader":"' + marker
    + '","private\\u0020key":"' + marker + '","note":"safe detail"}';
  for (const input of [unicode, JSON.stringify(unicode), JSON.stringify(JSON.stringify(unicode))]) {
    assert.equal(redactAndBound(input).includes(marker), false, 'escaped separator keys must be redacted');
    assert.match(redactAndBound(input), /safe detail/);
  }
});

test('redacts JSON-escaped solidus in credential keys without hiding safe fields', () => {
  const marker = 'NOFAX_ESCAPED_SOLIDUS_SECRET_CANARY_98765';
  const input = '{"api\\/key":"' + marker + '","auth\\/header":"' + marker
    + '","safe\\/text":"visible detail"}';
  assert.equal(JSON.parse(input)['api/key'], marker, 'test fixture is valid escaped-solidus JSON');

  for (const text of [input, JSON.stringify(input), JSON.stringify(JSON.stringify(input))]) {
    const bounded = redactAndBound(text);
    const summary = buildAgentSummary({ toolInput: { command: text } });
    assert.equal(bounded.includes(marker), false, 'escaped JSON key must not expose credentials');
    assert.equal(summary.includes(marker), false, 'approval summary must not expose credentials');
    assert.match(bounded, /visible detail/, 'safe JSON detail remains visible');
  }
});

test('redacts space-separated credential labels in command text', () => {
  const marker = 'NOFAX_SPACED_LABEL_SECRET_CANARY_98765';
  for (const input of [
    'private key=' + marker,
    'api key="' + marker + '"',
    "auth header='" + marker + "'",
    'private key: ' + marker
  ]) {
    assert.equal(redactAndBound(input).includes(marker), false, 'redact spaced credential labels in commands');
    assert.equal(buildAgentSummary({ toolInput: { command: input } }).includes(marker), false);
  }
  assert.match(redactAndBound('safe label="visible detail"'), /visible detail/);
});

test('redacts dotted and slash-separated secret names in command flags', () => {
  const marker = 'NOFAX_FLAG_SECRET_CANARY_98765';
  for (const name of ['api.key', 'auth.header', 'private.key', 'api/key']) {
    const input = `command --${name} ${marker}`;
    assert.equal(redactAndBound(input).includes(marker), false, `redact --${name} flag value`);
    assert.equal(buildAgentSummary({ toolInput: { command: input } }).includes(marker), false);
  }
  assert.match(redactAndBound(`command --safe.field ${marker}`), /NOFAX_FLAG_SECRET_CANARY_98765/);
});

test('redacts authorization schemes with separated secret header names', () => {
  const marker = 'NOFAX_AUTH_SCHEME_SECRET_CANARY_98765';
  for (const name of ['auth.header', 'auth header', 'auth_header', 'auth/header']) {
    for (const value of [`Bearer ${marker}`, `Basic ${marker}`, `Bearer "${marker}"`]) {
      const input = `${name}: ${value}`;
      assert.equal(redactAndBound(input).includes(marker), false, `redact ${name} scheme credential`);
      assert.equal(buildAgentSummary({ toolInput: { command: input } }).includes(marker), false);
    }
  }
  assert.match(redactAndBound(`safe.label: Bearer ${marker}`), /NOFAX_AUTH_SCHEME_SECRET_CANARY_98765/);
});

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

test('repeated noncyclic references remain visible in human approval summaries', () => {
  const shared = { command: 'run verified tests', apiKey: 'synthetic-private-value' };
  const input = { first: shared, second: shared, steps: [shared, shared] };
  const result = redactAndBound(input);
  for (const copy of [result.first, result.second, ...result.steps]) {
    assert.equal(copy.command, 'run verified tests');
    assert.equal(copy.apiKey, '[REDACTED]');
  }
  const summary = buildAgentSummary({ toolInput: input });
  assert.equal(summary.includes('[CIRCULAR]'), false, 'shared references are not cycles');
  assert.equal(summary.includes('synthetic-private-value'), false, 'copies stay redacted');
});

test('bounded arrays and objects visibly mark omitted approval context', () => {
  const array = Array.from({ length: 21 }, (_, index) => `item-${index}`);
  const object = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`key${index}`, `value-${index}`]));
  const markerCollision = {
    '…[truncated]': 'user-value',
    ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`collision${index}`, `value-${index}`]))
  };

  const arrayResult = redactAndBound(array);
  const objectResult = redactAndBound(object);
  const collisionResult = redactAndBound(markerCollision);
  const summary = buildAgentSummary({ source: 'Codex', toolName: 'shell', toolInput: object });

  assert.equal(arrayResult.length, 21);
  assert.equal(arrayResult[20], '…[truncated]');
  assert.equal(Object.keys(objectResult).length, 31);
  assert.equal(objectResult['…[truncated]'], true);
  assert.equal(collisionResult['…[truncated]'], 'user-value');
  assert.equal(collisionResult['…[truncated]*'], true);
  assert.match(summary, /…\[truncated\]/);
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

test('redacts credential keys obscured by invisible Unicode format marks', () => {
  const marker = 'NOFAX_SYNTHETIC_INVISIBLE_KEY_CREDENTIAL';
  const secretKeys = ['to\u200bken', 'pass\u200dword', 'api\u2060Key', 'client\u00adSecret'];
  const input = Object.fromEntries(secretKeys.map((key) => [key, marker]));
  input.secretaryName = 'safe detail';
  const redacted = redactAndBound(input);
  for (const key of secretKeys) assert.equal(redacted[key], '[REDACTED]');
  assert.equal(redacted.secretaryName, 'safe detail');
  assert.deepEqual(redactAndBound(['to\u200bken', marker, 'mode', 'safe']),
    ['to\\u200bken', '[REDACTED]', 'mode', 'safe']);
  assert.equal(redactAndBound({ name: 'pass\u200dword', value: marker }).value, '[REDACTED]');
  assert.doesNotMatch(buildAgentSummary({ toolInput: input }), new RegExp(marker));
});

test('redacts literal invisible Unicode secret keys in command text and approval previews', () => {
  const marker = 'NOFAX_SYNTHETIC_INVISIBLE_TEXT_KEY_CANARY_67890';
  const examples = [
    [`api\u200b_key=${marker} mode=safe`, 'api\\u200b_key', 'mode=safe'],
    [`to\u200dken="${marker}" mode=safe`, 'to\\u200dken', 'mode=safe'],
    [`pass\u00adword='${marker}' mode=safe`, 'pass\\u00adword', 'mode=safe'],
    [`auth\u200bHeader: Bearer ${marker} mode=safe`, 'auth\\u200bHeader', 'mode=safe'],
    [`{"api\u2060Key":"${marker}","note":"safe detail"}`, 'api\\u2060Key', 'safe detail']
  ];
  for (const [input, visibleKey, safeDetail] of examples) {
    for (const output of [redactAndBound(input), buildAgentSummary({ toolInput: { command: input } })]) {
      assert.equal(output.includes(marker), false, 'invisible secret-key marks must not bypass text redaction');
      assert.ok(
        output.includes(visibleKey) || output.includes(visibleKey.replaceAll('\\', '\\\\')),
        'display must still expose the obfuscating mark, including JSON-string escapes'
      );
      assert.ok(output.includes(safeDetail), 'unrelated approval context must remain visible');
    }
  }
  const benign = 'secretary\u200bName=visible mode=safe Developer 👩\u200d💻';
  const output = redactAndBound(benign);
  assert.ok(output.includes('secretary\\u200bName=visible'));
  assert.ok(output.includes('mode=safe'));
  assert.ok(output.includes('Developer 👩\u200d💻'));
});

test('redacts blank-filler credential key assignments in text and approval previews', () => {
  const marker = 'NOFAX_SYNTHETIC_BLANK_FILLER_CREDENTIAL_CANARY';
  for (const codePoint of ['115f', '1160', '2800', '3164', 'ffa0']) {
    const filler = String.fromCodePoint(Number.parseInt(codePoint, 16));
    for (const [before, after] of [['api', '_key'], ['to', 'ken'], ['pass', 'word']]) {
      const key = `${before}${filler}${after}`;
      const escapedKey = `${before}\\u${codePoint}${after}`;
      assert.equal(redactAndBound({ [key]: marker })[key], '[REDACTED]');
      for (const input of [
        `${key}=${marker} mode=safe`,
        `${key}="${marker}" mode=safe`,
        `{"${key}":"${marker}","note":"safe detail"}`
      ]) {
        for (const output of [redactAndBound(input), buildAgentSummary({ toolInput: { command: input } })]) {
          assert.equal(output.includes(marker), false, `U+${codePoint} must not bypass credential redaction`);
          assert.ok(
            output.includes(escapedKey) || output.includes(escapedKey.replaceAll('\\', '\\\\')),
            `U+${codePoint} should remain visible as an escape`
          );
          assert.match(output, /safe detail|mode=safe/, 'nonsecret context should remain');
        }
      }
    }
    assert.ok(redactAndBound(`category${filler}Name=visible mode=safe`).includes('visible'));
  }
});

test('redacts invisible secret-key marks in nested escaped JSON commands', () => {
  const marker = 'NOFAX_SYNTHETIC_NESTED_INVISIBLE_KEY_CANARY_67890';
  const payload = JSON.stringify({ 'api\u200b_key': marker, note: 'safe detail' });
  for (const input of [payload, JSON.stringify(payload), JSON.stringify(JSON.stringify(payload))]) {
    const bounded = redactAndBound(input);
    const summary = buildAgentSummary({ toolInput: { command: input } });
    for (const output of [bounded, summary]) {
      assert.equal(output.includes(marker), false, 'nested serialized approval context must hide the secret');
      assert.match(output, /safe detail/, 'safe sibling JSON fields remain readable');
    }
  }
});

test('redacts blank-filler credential keys in nested escaped JSON strings', () => {
  const marker = 'NOFAX_SYNTHETIC_NESTED_BLANK_FILLER_CANARY_7359';
  for (const codePoint of ['115f', '1160', '2800', '3164', 'ffa0']) {
    const filler = String.fromCodePoint(Number.parseInt(codePoint, 16));
    const key = `api${filler}_key`;
    let serialized = JSON.stringify({ [key]: marker, note: 'safe detail' });
    for (let depth = 1; depth <= 2; depth += 1) {
      serialized = JSON.stringify(serialized);
      for (const output of [
        redactAndBound(serialized),
        buildAgentSummary({ toolInput: { command: serialized } })
      ]) {
        assert.equal(output.includes(marker), false, `nested U+${codePoint} credential value leaked at depth ${depth}`);
        assert.match(output, /safe detail/, 'unrelated context should remain visible');
      }
    }
    const safe = JSON.stringify(JSON.stringify({ [`category${filler}Name`]: 'visible detail' }));
    assert.match(redactAndBound(safe), /visible detail/, 'unrelated nested keys remain readable');
  }
});

test('redacts hosted Git personal access tokens without hiding adjacent metadata', () => {
  const marker = 'NOFAX_SYNTHETIC_PAT_CREDENTIAL';
  const input = {
    GITHUB_PAT: marker,
    ghPat: marker,
    CI_GITLAB_PAT: marker,
    githubPatEnabled: true,
    pattern: 'keep-visible'
  };
  const result = redactAndBound(input);
  const textResult = redactAndBound(`GITHUB_PAT=${marker} --gh-pat "${marker}" pattern=keep-visible`);
  const summary = buildAgentSummary({ source: 'Codex', toolName: 'shell', toolInput: input });

  assert.equal(result.GITHUB_PAT, '[REDACTED]');
  assert.equal(result.ghPat, '[REDACTED]');
  assert.equal(result.CI_GITLAB_PAT, '[REDACTED]');
  assert.equal(result.githubPatEnabled, true);
  assert.equal(result.pattern, 'keep-visible');
  assert.doesNotMatch(textResult, new RegExp(marker));
  assert.match(textResult, /pattern=keep-visible/);
  assert.doesNotMatch(summary, new RegExp(marker));
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

test('redacts entry values when any mixed metadata label names a secret', () => {
  const marker = 'NOFAX_MIXED_ENTRY_SECRET_CANARY_XYZ';
  const inputs = [
    { name: 'display', header: 'Authorization', value: marker, note: 'safe' },
    { header: 'Accept', key: 'api_key', values: [marker], note: 'safe' },
    { key: 'mode', Name: 'Cookie', Value: marker, note: 'safe' },
    { Header: 'X-Api-Key', name: 'display', Values: [marker], note: 'safe' }
  ];

  for (const input of inputs) {
    const result = redactAndBound(input);
    const field = Object.keys(input).find((key) => key.toLowerCase() === 'value' || key.toLowerCase() === 'values');
    assert.equal(result[field], '[REDACTED]');
    assert.equal(result.note, 'safe');
    assert.doesNotMatch(buildAgentSummary({ toolInput: input }), new RegExp(marker));
  }

  const benign = { name: 'display', key: 'mode', header: 'Accept', value: 'application/json', note: 'safe' };
  assert.deepEqual(redactAndBound(benign), benign);
  assert.match(buildAgentSummary({ toolInput: benign }), /application\/json/);
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

test('redacts session identifiers used as credentials in commands and approval summaries', () => {
  const marker = 'NOFAX_SESSION_CREDENTIAL_CANARY_7H8';
  const command = `curl --session-id ${marker} "https://example.test/api?session_id=${marker}&mode=safe"`;
  const input = {
    sessionId: marker,
    headers: { 'X-Session-Id': marker },
    command,
    safeSessionCount: 2
  };
  const redacted = redactAndBound(input);
  const summary = buildAgentSummary({
    source: 'Claude Code', toolName: 'Bash', toolInput: input
  });

  assert.equal(redacted.sessionId, '[REDACTED]');
  assert.equal(redacted.headers['X-Session-Id'], '[REDACTED]');
  assert.match(redacted.command, /--session-id \[REDACTED\]/);
  assert.match(redacted.command, /session_id=\[REDACTED\]/);
  assert.match(redacted.command, /mode=safe/);
  assert.equal(redacted.safeSessionCount, 2);
  assert.doesNotMatch(summary, new RegExp(marker));
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
  assert.equal(result.usernameOnly, 'https://[REDACTED]@example.test/path');
  assert.equal(result.portOnly, 'https://example.test:8443/path');
});

test('redacts token-only and repeated-at URI userinfo up to the final authority delimiter', () => {
  const marker = 'NOFAX_URI_USERINFO_TOKEN_ONLY_CANARY';
  const inputs = [
    `https://${marker}@host.example.test/repo?mode=safe#fragment`,
    `https://PART_A@${marker}@host.example.test/repo?mode=safe#fragment`,
    `https://PART_A:${marker}@PART_B@host.example.test/repo?mode=safe#fragment`,
    `git+https://PART_A@${marker}@host.example.test/repo?mode=safe#fragment`
  ];

  for (const input of inputs) {
    for (const result of [
      redactAndBound(input),
      buildAgentSummary({ toolInput: { command: `git fetch ${input}` } })
    ]) {
      assert.doesNotMatch(result, new RegExp(marker), 'URI userinfo must not remain visible');
      assert.doesNotMatch(result, /PART_A/, 'nested userinfo must not survive redaction');
      assert.match(result, /\[REDACTED\]@host\.example\.test\/repo\?mode=safe#fragment/);
    }
  }

  assert.equal(redactAndBound('https://host.example.test/repo?mode=safe#fragment'),
    'https://host.example.test/repo?mode=safe#fragment');
  assert.equal(redactAndBound('https://host.example.test/repo/@visible?mode=@safe#@fragment'),
    'https://host.example.test/repo/@visible?mode=@safe#@fragment');
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

test('omits oversized untrusted approval text before running secret-redaction patterns', () => {
  // An arbitrary-length command must not drive expensive regex scans or reveal
  // a partial credential if the input is truncated inside its value.
  const input = `${'x'.repeat(16_385)} clientSecret="NOFAX_OVERSIZE_CANARY"`;
  const expected = '[OVERSIZED_INPUT_REDACTED]';
  assert.equal(redactAndBound(input), expected);

  const nested = redactAndBound({ command: input });
  assert.equal(nested.command, expected);
  const summary = buildAgentSummary({ source: 'Codex', toolName: 'shell', toolInput: { command: input } });
  assert.ok(summary.includes(expected));
  assert.ok(!summary.includes('NOFAX_OVERSIZE_CANARY'));
  assert.ok(!summary.includes('xxx'));
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

test('keeps own __proto__ fields in approval context without altering prototypes or leaking secrets', () => {
  const marker = 'NOFAX_SYNTHETIC_PROTOTYPE_KEY_SECRET_12345';
  const input = JSON.parse(`{"__proto__":{"command":"npm test","api_key":"${marker}"},"safe":"visible"}`);
  const bounded = redactAndBound(input);

  assert.equal(Object.getPrototypeOf(bounded), Object.prototype);
  assert.equal(Object.hasOwn(bounded, '__proto__'), true);
  assert.deepEqual(bounded.__proto__, { command: 'npm test', api_key: '[REDACTED]' });
  assert.equal(bounded.safe, 'visible');

  const summary = buildAgentSummary({ source: 'Codex', toolInput: { payload: input } });
  assert.match(summary, /"__proto__":/);
  assert.match(summary, /"command": "npm test"/);
  assert.match(summary, /"safe": "visible"/);
  assert.doesNotMatch(summary, new RegExp(marker));
});


test('redacts dotted API-key and signed URL credentials from agent summaries', () => {
  const marker = 'NOFAX_SYNTHETIC_URL_SECRET_20261030';
  const url = 'https://example.invalid/object?api.key=' + marker + '&X-Amz-Signature=' + marker + '&X-Goog-Signature=' + marker + '&X-Amz-Date=20261030T010000Z&mode=read';
  const summary = buildAgentSummary({
    source: 'Codex',
    toolName: 'shell',
    message: 'Review ' + url,
    toolInput: { url }
  });
  assert.doesNotMatch(summary, new RegExp(marker));
  assert.ok(summary.includes('api.key=[REDACTED]'));
  assert.ok(summary.includes('X-Amz-Signature=[REDACTED]'));
  assert.ok(summary.includes('X-Goog-Signature=[REDACTED]'));
  assert.ok(summary.includes('X-Amz-Date=20261030T010000Z'));
  assert.ok(summary.includes('mode=read'));
});

test('redacts legacy signed URL Signature credentials without hiding nonsecret metadata', () => {
  const urls = [
    'https://storage.googleapis.com/example/object?GoogleAccessId=demo%40example.invalid&Expires=1810000000&Signature=NOFAX_SYNTHETIC_GCS_V2_SIG',
    'https://example.s3.amazonaws.com/object?AWSAccessKeyId=EXAMPLEONLY&Expires=1810000000&Signature=NOFAX_SYNTHETIC_S3_V2_SIG'
  ];
  for (const url of urls) {
    const summary = buildAgentSummary({
      source: 'Codex', toolName: 'shell', message: 'Review ' + url, toolInput: { url }
    });
    assert.doesNotMatch(summary, /NOFAX_SYNTHETIC_(?:GCS|S3)_V2_SIG/);
    assert.match(summary, /Signature=\[REDACTED\]/);
    assert.match(summary, /Expires=1810000000/);
  }
  const structured = redactAndBound({ signature: 'function(arg) => result', mode: 'read' });
  assert.equal(structured.signature, 'function(arg) => result');
  assert.equal(structured.mode, 'read');
});


test('redacts Azure Blob Storage SAS signatures in agent approval summaries', () => {
  const marker = 'NOFAX_SYNTHETIC_AZURE_SAS_SECRET_20261030';
  const url = 'https://account.blob.core.windows.net/container/blob?sv=2024-11-04&sp=r&se=2030-01-01T00%3A00%3A00Z&sig=' + marker + '&spr=https';
  const summary = buildAgentSummary({
    source: 'Codex', toolName: 'shell', message: 'Review ' + url, toolInput: { url }
  });
  assert.doesNotMatch(summary, /NOFAX_SYNTHETIC_AZURE_SAS_SECRET_20261030/);
  assert.match(summary, /sig=\[REDACTED\]/);
  assert.match(summary, /sv=2024-11-04/);
  assert.match(summary, /sp=r/);
});

test('redacts URL credential parameters with percent-encoded key names', () => {
  const marker = 'NOFAX_ENCODED_QUERY_KEY_CANARY';
  const cases = [
    ['api%5Fkey', '?', '&mode=read'],
    ['%61ccess%5Ftoken', '?', '&mode=read'],
    ['X-Amz-%53ignature', '?', '&mode=read'],
    ['id%5ftoken', '#', '&section=docs']
  ];
  for (const [name, delimiter, suffix] of cases) {
    const url = `https://example.invalid/object${delimiter}${name}=${marker}${suffix}`;
    const actual = redactAndBound(url);
    const summary = buildAgentSummary({ source: 'Codex', toolName: 'browser', toolInput: { url } });
    assert.doesNotMatch(actual, new RegExp(marker));
    assert.doesNotMatch(summary, new RegExp(marker));
    assert.ok(actual.includes(`${name}=[REDACTED]`));
    assert.ok(actual.endsWith(suffix));
  }
  const benign = 'https://example.invalid/object?m%6fde=read&section=docs';
  assert.equal(redactAndBound(benign), benign);
});
