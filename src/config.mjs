import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createPhoneTopic } from './protocol.mjs';

export const DEFAULT_SERVER = 'https://ntfy.sh';
export const DEFAULT_TIMEOUT_SECONDS = 300;

export function resolveNofaxHome({ home, env = process.env } = {}) {
  const configured = home ?? env.NOFAX_HOME;
  if (configured !== undefined) {
    const trimmed = String(configured).trim();
    if (!trimmed) throw new Error('NOFAX_HOME_EMPTY');
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(process.cwd(), trimmed);
  }
  return join(homedir(), '.nofax');
}

export function normalizeServer(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('NOFAX_SERVER_INVALID');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('NOFAX_SERVER_PROTOCOL');
  if (url.username || url.password) throw new Error('NOFAX_SERVER_CREDENTIALS');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('NOFAX_SERVER_PATH');
  return `${url.protocol}//${url.host}`;
}

function validateTopic(topic) {
  if (typeof topic !== 'string' || topic.length < 24 || topic.length > 128 || !/^[A-Za-z0-9_-]+$/.test(topic)) {
    throw new Error('NOFAX_TOPIC_INVALID');
  }
  return topic;
}

function validateTimeout(value) {
  if (!Number.isInteger(value) || value < 5 || value > 3600) throw new Error('NOFAX_TIMEOUT_INVALID');
  return value;
}

export function validateConfig(input) {
  if (!input || input.version !== 1) throw new Error('NOFAX_CONFIG_VERSION');
  return {
    version: 1,
    server: normalizeServer(input.server),
    topic: validateTopic(input.topic),
    timeoutSeconds: validateTimeout(input.timeoutSeconds)
  };
}

export async function loadConfig({ home, env } = {}) {
  const root = resolveNofaxHome({ home, env });
  try {
    const parsed = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
    return validateConfig(parsed);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('NOFAX_NOT_INITIALIZED');
    if (error instanceof SyntaxError) throw new Error('NOFAX_CONFIG_INVALID_JSON');
    throw error;
  }
}

export async function initConfig({ home, env, server = DEFAULT_SERVER, topic, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, force = false } = {}) {
  const root = resolveNofaxHome({ home, env });
  if (!force) {
    try {
      return await loadConfig({ home: root });
    } catch (error) {
      if (error.message !== 'NOFAX_NOT_INITIALIZED') throw error;
    }
  }

  const config = validateConfig({
    version: 1,
    server,
    topic: topic ?? createPhoneTopic(),
    timeoutSeconds
  });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'config.json');
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows may not honor POSIX mode bits; the file still lives in the user's profile.
  }
  return config;
}
