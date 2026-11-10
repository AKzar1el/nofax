import { chmod, link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createPhoneTopic } from './protocol.mjs';

export const DEFAULT_SERVER = 'https://ntfy.sh';
export const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_CONFIG_BYTES = 64 * 1024;

async function readConfigJson(path) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error('NOFAX_CONFIG_TOO_LARGE');
    let json;
    try {
      // TextDecoder strips a leading UTF-8 BOM but rejects malformed byte
      // sequences instead of silently replacing them in a security config.
      json = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error('NOFAX_CONFIG_INVALID_UTF8');
    }
    return JSON.parse(json);
  } finally {
    await file.close();
  }
}

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
  // URL parsing silently strips embedded CR/LF/TAB, which could disguise the
  // actual destination for notification capabilities and approval callbacks.
  if (typeof input === 'string' && /[\x00-\x1f\x7f]/.test(input)) {
    throw new Error('NOFAX_SERVER_INVALID');
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('NOFAX_SERVER_INVALID');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('NOFAX_SERVER_PROTOCOL');
  if (url.username || url.password) throw new Error('NOFAX_SERVER_CREDENTIALS');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('NOFAX_SERVER_PATH');
  if (url.protocol === 'http:' &&
      url.hostname !== 'localhost' &&
      url.hostname !== '[::1]' &&
      !/^127\.(?:\d+\.){2}\d+$/.test(url.hostname)) {
    // Notifications and approval callback URLs contain capabilities; only
    // explicit loopback development endpoints may use cleartext transport.
    throw new Error('NOFAX_SERVER_INSECURE_HTTP');
  }
  return `${url.protocol}//${url.host}`;
}

function hasRepeatedTopicPattern(topic) {
  // Eight distinct characters can still be one short, easily guessed motif.
  for (let length = 1; length <= Math.floor(topic.length / 2); length += 1) {
    if (topic.length % length === 0 && topic === topic.slice(0, length).repeat(topic.length / length)) {
      return true;
    }
  }
  return false;
}

function hasValidTopicShape(topic) {
  return typeof topic === 'string' && topic.length >= 24 && topic.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(topic) && new Set(topic).size >= 8;
}

export function isLegacyRepeatedTopic(topic) {
  // Only persisted topics matching the former character/length rules qualify.
  return hasValidTopicShape(topic) && hasRepeatedTopicPattern(topic);
}

export function validateTopic(topic) {
  // The phone topic grants access to notification content and embedded response
  // actions. Reject obviously guessable values, as the remote Worker does.
  if (!hasValidTopicShape(topic) || hasRepeatedTopicPattern(topic)) {
    throw new Error('NOFAX_TOPIC_INVALID');
  }
  return topic;
}

function validateTimeout(value) {
  if (!Number.isInteger(value) || value < 5 || value > 3600) throw new Error('NOFAX_TIMEOUT_INVALID');
  return value;
}

function validateConfigInternal(input, allowSavedLegacyTopic) {
  if (!input || input.version !== 1) throw new Error('NOFAX_CONFIG_VERSION');
  return {
    version: 1,
    server: normalizeServer(input.server),
    topic: allowSavedLegacyTopic && isLegacyRepeatedTopic(input.topic)
      ? input.topic : validateTopic(input.topic),
    timeoutSeconds: validateTimeout(input.timeoutSeconds)
  };
}

export function validateConfig(input) {
  return validateConfigInternal(input, false);
}

export async function loadConfig({ home, env } = {}) {
  const root = resolveNofaxHome({ home, env });
  try {
    const parsed = await readConfigJson(join(root, 'config.json'));
    // Read existing repeated topics so users can inspect and rotate them;
    // newly supplied topics and notification transports remain strict.
    return validateConfigInternal(parsed, true);
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
  const temporaryPath = join(root, `.config.json.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let replaced = false;
  try {
    // Replacing a complete same-directory temp file keeps readers from seeing a
    // truncated config and avoids writing through an existing symlink/hardlink.
    const file = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await chmod(temporaryPath, 0o600);
    } catch {
      // Windows may not honor POSIX mode bits; the file still lives in the user's profile.
    }
    if (force) {
      await rename(temporaryPath, path);
      replaced = true;
    } else {
      // The first initializer owns the topic. An atomic hardlink claim avoids
      // changing it underneath another process that just read its new config.
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        return await loadConfig({ home: root });
      }
    }
  } finally {
    if (temporaryCreated && !replaced) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return config;
}
