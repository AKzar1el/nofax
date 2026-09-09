import { createRequestId, createResponseTopic, parseDecisionMessage } from './protocol.mjs';

const MAX_TITLE = 120;
const MAX_MESSAGE = 2200;

function boundText(value, max, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`NOFAX_${name}_REQUIRED`);
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 14)}…[truncated]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function actionFor({ label, server, responseTopic, requestId, decision }) {
  return {
    action: 'http',
    label,
    url: `${server}/${responseTopic}`,
    method: 'POST',
    body: JSON.stringify({ v: 1, requestId, decision }),
    clear: true
  };
}

async function ensureOk(response, code) {
  if (!response?.ok) throw new Error(`${code}_${response?.status ?? 'NETWORK'}`);
  return response;
}

export async function sendNotification({ config, title, message, actions, fetchImpl = fetch }) {
  const payload = {
    topic: config.topic,
    title: boundText(title, MAX_TITLE, 'TITLE'),
    message: boundText(message, MAX_MESSAGE, 'MESSAGE'),
    priority: 4,
    tags: ['bell']
  };
  if (actions?.length) payload.actions = actions;

  let response;
  try {
    response = await fetchImpl(`${config.server}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw new Error(`NOFAX_NTFY_PUBLISH_NETWORK: ${error?.message ?? String(error)}`);
  }
  await ensureOk(response, 'NOFAX_NTFY_PUBLISH');
}

function parseNtfyPoll(text, requestId, allowed) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.event !== 'message') continue;
    const decision = parseDecisionMessage(event.message, { requestId, allowed });
    if (decision !== null) return decision;
  }
  return null;
}

async function pollDecision({ config, responseTopic, requestId, allowed, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`${config.server}/${responseTopic}/json?poll=1&since=10m`, {
      method: 'GET',
      headers: { accept: 'application/x-ndjson' }
    });
  } catch (error) {
    throw new Error(`NOFAX_NTFY_POLL_NETWORK: ${error?.message ?? String(error)}`);
  }
  await ensureOk(response, 'NOFAX_NTFY_POLL');
  return parseNtfyPoll(await response.text(), requestId, allowed);
}

async function requestDecision({
  config,
  title,
  message,
  options,
  fetchImpl = fetch,
  timeoutMs = config.timeoutSeconds * 1000,
  pollIntervalMs = 1000,
  nowImpl = Date.now,
  sleepImpl = sleep
}) {
  const requestId = createRequestId();
  const responseTopic = createResponseTopic();
  const actions = options.map(({ value, label }) => actionFor({
    label,
    server: config.server,
    responseTopic,
    requestId,
    decision: value
  }));

  await sendNotification({ config, title, message, actions, fetchImpl });
  const deadline = nowImpl() + timeoutMs;
  const allowed = options.map((option) => option.value);

  while (nowImpl() < deadline) {
    const decision = await pollDecision({ config, responseTopic, requestId, allowed, fetchImpl });
    if (decision !== null) return { decision, requestId, responseTopic };
    const remaining = deadline - nowImpl();
    if (remaining <= 0) break;
    await sleepImpl(Math.min(pollIntervalMs, remaining));
  }

  return { decision: 'timeout', requestId, responseTopic };
}

export async function requestApproval(options) {
  return requestDecision({
    ...options,
    options: [
      { value: 'allow', label: 'Allow' },
      { value: 'deny', label: 'Deny' }
    ]
  });
}

export async function requestChoice({ options, ...rest }) {
  if (!Array.isArray(options) || options.length < 1 || options.length > 3) throw new Error('NOFAX_CHOICE_LIMIT');
  const normalized = options.map((option) => {
    if (typeof option === 'string') return { value: option, label: option };
    if (!option || typeof option.value !== 'string' || typeof option.label !== 'string') throw new Error('NOFAX_CHOICE_INVALID');
    if (!option.value || !option.label) throw new Error('NOFAX_CHOICE_INVALID');
    return { value: option.value, label: option.label.slice(0, 32) };
  });
  if (new Set(normalized.map((option) => option.value)).size !== normalized.length) throw new Error('NOFAX_CHOICE_DUPLICATE');
  return requestDecision({ ...rest, options: normalized });
}
