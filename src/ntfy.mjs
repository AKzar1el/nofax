import { createRequestId, createResponseTopic, parseResponseMessage } from './protocol.mjs';

const MAX_TITLE = 120;
const MAX_MESSAGE = 2200;
const DEFAULT_REFINE_SHORTCUT = 'Nofax Refine';
const POLL_TIMEOUT = Symbol('NOFAX_POLL_TIMEOUT');
// ntfy rejects validation and rate-limit responses before accepting the publish.
const NOT_APPLIED_PUBLISH_STATUSES = new Set([400, 429]);

function safeSliceEnd(text, end) {
  const previous = text.charCodeAt(end - 1);
  return previous >= 0xD800 && previous <= 0xDBFF ? end - 1 : end;
}

function boundChoiceLabel(value) {
  return value.slice(0, safeSliceEnd(value, 32));
}

function boundText(value, max, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`NOFAX_${name}_REQUIRED`);
  const text = value.trim();
  if (text.length <= max) return text;
  const end = safeSliceEnd(text, max - 14);
  return `${text.slice(0, end)}…[truncated]`;
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

function publishError(message, deliveryState) {
  const error = new Error(message);
  error.deliveryState = deliveryState;
  return error;
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
    throw publishError(`NOFAX_NTFY_PUBLISH_NETWORK: ${error?.message ?? String(error)}`, 'ambiguous');
  }
  if (!response?.ok) {
    const status = response?.status ?? 'NETWORK';
    const deliveryState = NOT_APPLIED_PUBLISH_STATUSES.has(status) ? 'not_applied' : 'ambiguous';
    throw publishError(`NOFAX_NTFY_PUBLISH_${status}`, deliveryState);
  }
}

function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length > 3) throw new Error('NOFAX_CHOICE_LIMIT');
  const normalized = options.map((option) => {
    if (typeof option === 'string') {
      const value = option.trim();
      if (!value || value.length > 80) throw new Error('NOFAX_CHOICE_INVALID');
      return { value, label: boundChoiceLabel(value) };
    }
    if (!option || typeof option.value !== 'string' || typeof option.label !== 'string') throw new Error('NOFAX_CHOICE_INVALID');
    const value = option.value.trim();
    const label = option.label.trim();
    if (!value || !label || value.length > 80) throw new Error('NOFAX_CHOICE_INVALID');
    return { value, label: boundChoiceLabel(label) };
  });
  if (new Set(normalized.map((option) => option.value)).size !== normalized.length) throw new Error('NOFAX_CHOICE_DUPLICATE');
  if (new Set(normalized.map((option) => option.label)).size !== normalized.length) throw new Error('NOFAX_CHOICE_DUPLICATE');
  return normalized;
}

export async function createRemoteRequest({
  config,
  title,
  message,
  options = [],
  includeRefine = false,
  shortcutName = config.refineShortcutName ?? DEFAULT_REFINE_SHORTCUT,
  beforePublish = async () => {},
  fetchImpl = fetch
}) {
  const normalized = normalizeOptions(options);
  if (includeRefine && normalized.some((option) => option.value === 'refine')) throw new Error('NOFAX_CHOICE_DUPLICATE');
  if (includeRefine && normalized.some((option) => option.label === 'Refine')) throw new Error('NOFAX_CHOICE_DUPLICATE');
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

  const remote = { requestId, responseTopic, allowed };
  await beforePublish(remote);
  await sendNotification({ config, title, message, actions, fetchImpl });
  return remote;
}

function parseNtfyPoll(text, requestId, allowed, kind) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.event !== 'message') continue;
    const response = parseResponseMessage(event.message, { requestId, allowed, kind });
    if (response !== null) return response;
  }
  return null;
}

export async function pollRemoteResponse({ config, responseTopic, requestId, allowed, kind, timeoutMs, fetchImpl = fetch }) {
  let timeoutId;
  const controller = timeoutMs === undefined ? null : new AbortController();
  const timeout = controller === null
    ? null
    : new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          resolve(POLL_TIMEOUT);
        }, timeoutMs);
      });
  try {
    let response;
    try {
      const request = fetchImpl(`${config.server}/${responseTopic}/json?poll=1&since=all`, {
        method: 'GET',
        headers: { accept: 'application/x-ndjson' },
        ...(controller === null ? {} : { signal: controller.signal })
      });
      response = timeout === null ? await request : await Promise.race([request, timeout]);
    } catch (error) {
      if (controller?.signal.aborted) return null;
      throw new Error(`NOFAX_NTFY_POLL_NETWORK: ${error?.message ?? String(error)}`);
    }
    if (response === POLL_TIMEOUT) return null;
    await ensureOk(response, 'NOFAX_NTFY_POLL');

    let text;
    try {
      const body = response.text();
      text = timeout === null ? await body : await Promise.race([body, timeout]);
    } catch (error) {
      if (controller?.signal.aborted) return null;
      throw error;
    }
    if (text === POLL_TIMEOUT) return null;
    return parseNtfyPoll(text, requestId, allowed, kind);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function sendResponseConfirmation({ config, response, kind, title = 'Nofax', fetchImpl = fetch }) {
  let confirmationTitle = 'Response received';
  let tag = 'white_check_mark';
  if (kind === 'choice') confirmationTitle = 'Choice received';
  else if (kind === 'refinement') confirmationTitle = 'Refinement received';
  else if (response.decision === 'allow') confirmationTitle = 'Approved';
  else if (response.decision === 'deny') {
    confirmationTitle = 'Denied';
    tag = 'no_entry';
  } else if (response.decision === 'refine') confirmationTitle = 'Refinement received';
  else confirmationTitle = 'Choice received';

  try {
    await sendNotification({
      config,
      title: `${confirmationTitle} - ${title}`,
      message: kind !== 'choice' && response.decision === 'refine'
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
  kind,
  timeoutMs,
  pollIntervalMs = 1000,
  fetchImpl = fetch,
  nowImpl = Date.now,
  sleepImpl = sleep
}) {
  const deadline = nowImpl() + timeoutMs;
  while (true) {
    const remainingBeforePoll = deadline - nowImpl();
    if (remainingBeforePoll <= 0) break;
    const response = await pollRemoteResponse({
      config,
      responseTopic,
      requestId,
      allowed,
      kind,
      timeoutMs: remainingBeforePoll,
      fetchImpl
    });
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
  kind,
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
    kind,
    timeoutMs,
    pollIntervalMs,
    fetchImpl,
    nowImpl,
    sleepImpl
  });
  if (response === null) {
    return { decision: 'timeout', requestId: remote.requestId, responseTopic: remote.responseTopic };
  }
  await sendResponseConfirmation({ config, response, kind, title, fetchImpl });
  return { ...response, requestId: remote.requestId, responseTopic: remote.responseTopic };
}

export async function requestApproval(options) {
  return requestDecision({
    ...options,
    kind: 'approval',
    options: [
      { value: 'allow', label: 'Allow' },
      { value: 'deny', label: 'Deny' }
    ]
  });
}

export async function requestRefinement(options) {
  return requestDecision({ ...options, kind: 'refinement', options: [], includeRefine: true });
}

export async function requestChoice({ options, ...rest }) {
  const normalized = normalizeOptions(options);
  if (normalized.length < 1 || normalized.length > 3) throw new Error('NOFAX_CHOICE_LIMIT');
  return requestDecision({ ...rest, kind: 'choice', options: normalized });
}
