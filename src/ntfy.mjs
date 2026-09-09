import { createRequestId, createResponseTopic, parseResponseMessage } from './protocol.mjs';

const MAX_TITLE = 120;
const MAX_MESSAGE = 2200;
const DEFAULT_REFINE_SHORTCUT = 'Nofax Refine';

function boundText(value, max, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`NOFAX_${name}_REQUIRED`);
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 14)}…[truncated]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpAction({ label, server, responseTopic, requestId, decision }) {
  return {
    action: 'http',
    label,
    url: `${server}/${responseTopic}`,
    method: 'POST',
    body: JSON.stringify({ v: 1, requestId, decision }),
    clear: true
  };
}

export function buildRefineShortcutUrl({ shortcutName = DEFAULT_REFINE_SHORTCUT, server, responseTopic, requestId }) {
  const payload = JSON.stringify({
    v: 1,
    requestId,
    callbackUrl: `${server}/${responseTopic}`
  });
  const url = new URL('shortcuts://run-shortcut');
  url.searchParams.set('name', shortcutName);
  url.searchParams.set('input', 'text');
  url.searchParams.set('text', payload);
  return url.toString();
}

function refineAction({ shortcutName, server, responseTopic, requestId }) {
  return {
    action: 'view',
    label: 'Refine',
    url: buildRefineShortcutUrl({ shortcutName, server, responseTopic, requestId }),
    clear: true
  };
}

async function ensureOk(response, code) {
  if (!response?.ok) throw new Error(`${code}_${response?.status ?? 'NETWORK'}`);
  return response;
}

export async function sendNotification({ config, title, message, actions, priority = 4, tags = ['bell'], fetchImpl = fetch }) {
  const payload = {
    topic: config.topic,
    title: boundText(title, MAX_TITLE, 'TITLE'),
    message: boundText(message, MAX_MESSAGE, 'MESSAGE'),
    priority,
    tags
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

function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length > 3) throw new Error('NOFAX_CHOICE_LIMIT');
  const normalized = options.map((option) => {
    if (typeof option === 'string') return { value: option, label: option };
    if (!option || typeof option.value !== 'string' || typeof option.label !== 'string') throw new Error('NOFAX_CHOICE_INVALID');
    const value = option.value.trim();
    const label = option.label.trim();
    if (!value || !label || value.length > 80) throw new Error('NOFAX_CHOICE_INVALID');
    return { value, label: label.slice(0, 32) };
  });
  if (new Set(normalized.map((option) => option.value)).size !== normalized.length) throw new Error('NOFAX_CHOICE_DUPLICATE');
  return normalized;
}

export async function createRemoteRequest({
  config,
  title,
  message,
  options = [],
  includeRefine = false,
  shortcutName = config.refineShortcutName ?? DEFAULT_REFINE_SHORTCUT,
  fetchImpl = fetch
}) {
  const normalized = normalizeOptions(options);
  const totalActions = normalized.length + (includeRefine ? 1 : 0);
  if (totalActions < 1 || totalActions > 3) throw new Error('NOFAX_CHOICE_LIMIT');

  const requestId = createRequestId();
  const responseTopic = createResponseTopic();
  const actions = [];
  const allowed = [];

  if (includeRefine && normalized.length === 2) {
    const [first, second] = normalized;
    actions.push(httpAction({ label: first.label, server: config.server, responseTopic, requestId, decision: first.value }));
    allowed.push(first.value);
    actions.push(refineAction({ shortcutName, server: config.server, responseTopic, requestId }));
    allowed.push('refine');
    actions.push(httpAction({ label: second.label, server: config.server, responseTopic, requestId, decision: second.value }));
    allowed.push(second.value);
  } else {
    for (const option of normalized) {
      actions.push(httpAction({ label: option.label, server: config.server, responseTopic, requestId, decision: option.value }));
      allowed.push(option.value);
    }
    if (includeRefine) {
      actions.push(refineAction({ shortcutName, server: config.server, responseTopic, requestId }));
      allowed.push('refine');
    }
  }

  await sendNotification({ config, title, message, actions, fetchImpl });
  return { requestId, responseTopic, allowed };
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
    const response = parseResponseMessage(event.message, { requestId, allowed });
    if (response !== null) return response;
  }
  return null;
}

export async function pollRemoteResponse({ config, responseTopic, requestId, allowed, fetchImpl = fetch }) {
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

export async function sendResponseConfirmation({ config, response, title = 'Nofax', fetchImpl = fetch }) {
  let confirmationTitle = 'Response received';
  let tag = 'white_check_mark';
  if (response.decision === 'allow') confirmationTitle = 'Approved';
  else if (response.decision === 'deny') {
    confirmationTitle = 'Denied';
    tag = 'no_entry';
  } else if (response.decision === 'refine') confirmationTitle = 'Refinement received';
  else confirmationTitle = 'Choice received';

  try {
    await sendNotification({
      config,
      title: `${confirmationTitle} - ${title}`,
      message: response.decision === 'refine'
        ? 'Your refinement was sent back to the agent.'
        : `Nofax recorded: ${response.decision}`,
      priority: 2,
      tags: [tag],
      fetchImpl
    });
    return true;
  } catch {
    return false;
  }
}

export async function waitRemoteResponse({
  config,
  responseTopic,
  requestId,
  allowed,
  timeoutMs,
  pollIntervalMs = 1000,
  fetchImpl = fetch,
  nowImpl = Date.now,
  sleepImpl = sleep
}) {
  const deadline = nowImpl() + timeoutMs;
  while (nowImpl() < deadline) {
    const response = await pollRemoteResponse({ config, responseTopic, requestId, allowed, fetchImpl });
    if (response !== null) return response;
    const remaining = deadline - nowImpl();
    if (remaining <= 0) break;
    await sleepImpl(Math.min(pollIntervalMs, remaining));
  }
  return null;
}

async function requestDecision({
  config,
  title,
  message,
  options,
  includeRefine = false,
  fetchImpl = fetch,
  timeoutMs = config.timeoutSeconds * 1000,
  pollIntervalMs = 1000,
  nowImpl = Date.now,
  sleepImpl = sleep
}) {
  const remote = await createRemoteRequest({ config, title, message, options, includeRefine, fetchImpl });
  const response = await waitRemoteResponse({
    config,
    ...remote,
    timeoutMs,
    pollIntervalMs,
    fetchImpl,
    nowImpl,
    sleepImpl
  });
  if (response === null) {
    return { decision: 'timeout', requestId: remote.requestId, responseTopic: remote.responseTopic };
  }
  await sendResponseConfirmation({ config, response, title, fetchImpl });
  return { ...response, requestId: remote.requestId, responseTopic: remote.responseTopic };
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

export async function requestRefinement(options) {
  return requestDecision({ ...options, options: [], includeRefine: true });
}

export async function requestChoice({ options, ...rest }) {
  const normalized = normalizeOptions(options);
  if (normalized.length < 1 || normalized.length > 3) throw new Error('NOFAX_CHOICE_LIMIT');
  return requestDecision({ ...rest, options: normalized });
}
