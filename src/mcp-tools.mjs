import { loadConfig } from './config.mjs';
import {
  createRemoteRequest,
  pollRemoteResponse,
  sendNotification,
  sendResponseConfirmation
} from './ntfy.mjs';
import {
  discardPendingRequest,
  listPendingRequests,
  loadRequest,
  resolveRequestWithClaim,
  savePendingRequest
} from './requests.mjs';

const MAX_WAIT_SECONDS = 240;
const DEFAULT_WAIT_SECONDS = 240;

export const WAIT_REQUIRED = (requestId) =>
  `WAIT REQUIRED: human response for ${requestId} is still pending. Do not continue, infer approval, or complete the guarded action. Call nofax_wait_for_response with requestId "${requestId}" and repeat whenever it returns pending until a terminal response is returned.`;

function pendingResult(requestId) {
  return {
    status: 'pending',
    requestId,
    mustWait: true,
    instruction: WAIT_REQUIRED(requestId)
  };
}

function terminalResult(request) {
  if (request.kind === 'choice') {
    return {
      status: 'resolved',
      requestId: request.requestId,
      decision: request.decision,
      instruction: 'Human choice received. Apply only that explicit choice within the caller\'s existing authority.'
    };
  }
  if (request.kind === 'refinement') {
    return {
      status: 'resolved',
      requestId: request.requestId,
      decision: request.decision,
      ...(request.text === undefined ? {} : { text: request.text }),
      instruction: 'Apply the human refinement. If the resulting action still requires approval, create a new approval request and wait for that new terminal response before acting.'
    };
  }
  if (request.decision === 'allow') {
    return {
      status: 'resolved',
      requestId: request.requestId,
      decision: 'allow',
      instruction: 'Human approved this request. The caller may continue only within its existing authority.'
    };
  }
  if (request.decision === 'deny') {
    return {
      status: 'resolved',
      requestId: request.requestId,
      decision: 'deny',
      instruction: 'Human denied this request. Do not perform the guarded action.'
    };
  }
  if (request.decision === 'refine') {
    return {
      status: 'resolved',
      requestId: request.requestId,
      decision: 'refine',
      text: request.text,
      instruction: 'Apply the human refinement. If the resulting action still requires approval, create a new approval request and wait for that new terminal response before acting.'
    };
  }
  return {
    status: 'resolved',
    requestId: request.requestId,
    decision: request.decision,
    instruction: 'Human choice received. Apply only that explicit choice within the caller\'s existing authority.'
  };
}

function publicRequest(request) {
  const result = {
    requestId: request.requestId,
    kind: request.kind,
    status: request.status,
    createdAt: request.createdAt
  };
  if (request.status === 'resolved') {
    result.resolvedAt = request.resolvedAt;
    result.decision = request.decision;
    if (request.text !== undefined) result.text = request.text;
  }
  return result;
}

function safeSliceEnd(text, end) {
  const previous = text.charCodeAt(end - 1);
  return previous >= 0xD800 && previous <= 0xDBFF ? end - 1 : end;
}

function validateText(value, name, max = 2200) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`NOFAX_${name}_REQUIRED`);
  const text = value.trim();
  if (text.length <= max) return text;
  const end = safeSliceEnd(text, max - 14);
  return `${text.slice(0, end)}…[truncated]`;
}

function validateWaitSeconds(value) {
  const seconds = value ?? DEFAULT_WAIT_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) {
    throw new Error('NOFAX_MCP_WAIT_SECONDS_INVALID');
  }
  return seconds;
}

function validateChoiceOptions(options) {
  if (!Array.isArray(options) || options.length < 1 || options.length > 3) throw new Error('NOFAX_CHOICE_LIMIT');
  const normalized = options.map((option) => {
    if (typeof option === 'string') {
      const value = option.trim();
      if (!value || value.length > 80) throw new Error('NOFAX_CHOICE_INVALID');
      return { value, label: value.slice(0, 32) };
    }
    if (!option || typeof option.value !== 'string' || typeof option.label !== 'string') throw new Error('NOFAX_CHOICE_INVALID');
    const value = option.value.trim();
    const label = option.label.trim();
    if (!value || !label || value.length > 80) throw new Error('NOFAX_CHOICE_INVALID');
    return { value, label: label.slice(0, 32) };
  });
  if (new Set(normalized.map((option) => option.value)).size !== normalized.length) {
    throw new Error('NOFAX_CHOICE_DUPLICATE');
  }
  if (new Set(normalized.map((option) => option.label)).size !== normalized.length) {
    throw new Error('NOFAX_CHOICE_DUPLICATE');
  }
  return normalized;
}

export function createMcpToolHandlers(overrides = {}) {
  const deps = {
    home: overrides.home,
    env: overrides.env ?? process.env,
    loadConfigImpl: overrides.loadConfigImpl ?? loadConfig,
    sendNotificationImpl: overrides.sendNotificationImpl ?? sendNotification,
    createRemoteRequestImpl: overrides.createRemoteRequestImpl ?? createRemoteRequest,
    pollRemoteResponseImpl: overrides.pollRemoteResponseImpl ?? pollRemoteResponse,
    sendResponseConfirmationImpl: overrides.sendResponseConfirmationImpl ?? sendResponseConfirmation,
    discardPendingRequestImpl: overrides.discardPendingRequestImpl ?? discardPendingRequest,
    savePendingRequestImpl: overrides.savePendingRequestImpl ?? savePendingRequest,
    loadRequestImpl: overrides.loadRequestImpl ?? loadRequest,
    resolveRequestWithClaimImpl: overrides.resolveRequestWithClaimImpl ?? resolveRequestWithClaim,
    listPendingRequestsImpl: overrides.listPendingRequestsImpl ?? listPendingRequests,
    nowImpl: overrides.nowImpl ?? Date.now,
    sleepImpl: overrides.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  };

  async function config() {
    return deps.loadConfigImpl({ home: deps.home, env: deps.env });
  }

  async function persistRemote({ kind, remote, requestConfig }) {
    const request = {
      version: 1,
      requestId: remote.requestId,
      kind,
      responseTopic: remote.responseTopic,
      allowed: remote.allowed,
      server: requestConfig.server,
      topic: requestConfig.topic,
      status: 'pending',
      createdAt: new Date(deps.nowImpl()).toISOString()
    };
    await deps.savePendingRequestImpl({ home: deps.home, env: deps.env, request });
    return pendingResult(remote.requestId);
  }

  async function createDurableRemote(kind, input) {
    let persisted;
    try {
      const remote = await deps.createRemoteRequestImpl({
        ...input,
        beforePublish: async (prepared) => {
          persisted = await persistRemote({ kind, remote: prepared, requestConfig: input.config });
        }
      });
      return persisted ?? persistRemote({ kind, remote, requestConfig: input.config });
    } catch (error) {
      if (persisted && error?.deliveryState === 'not_applied') {
        try {
          await deps.discardPendingRequestImpl({ home: deps.home, env: deps.env, requestId: persisted.requestId });
        } catch (cleanupError) {
          error.cleanupError = cleanupError;
        }
      }
      throw error;
    }
  }

  return {
    async notify({ title = 'Nofax', message }) {
      const current = await config();
      await deps.sendNotificationImpl({
        config: current,
        title: validateText(title, 'TITLE', 120),
        message: validateText(message, 'MESSAGE')
      });
      return { status: 'sent' };
    },

    async requestApproval({ title = 'Nofax approval', message, allowRefine = false }) {
      const current = await config();
      return createDurableRemote('approval', {
        config: current,
        title: validateText(title, 'TITLE', 120),
        message: validateText(message, 'MESSAGE'),
        options: [
          { value: 'allow', label: 'Allow' },
          { value: 'deny', label: 'Deny' }
        ],
        includeRefine: allowRefine === true
      });
    },

    async requestChoice({ title = 'Nofax choice', message, options }) {
      const current = await config();
      const normalized = validateChoiceOptions(options);
      return createDurableRemote('choice', {
        config: current,
        title: validateText(title, 'TITLE', 120),
        message: validateText(message, 'MESSAGE'),
        options: normalized,
        includeRefine: false
      });
    },

    async requestRefinement({ title = 'Nofax refinement', message }) {
      const current = await config();
      return createDurableRemote('refinement', {
        config: current,
        title: validateText(title, 'TITLE', 120),
        message: validateText(message, 'MESSAGE'),
        options: [],
        includeRefine: true
      });
    },

    async waitForResponse({ requestId, waitSeconds }) {
      const seconds = validateWaitSeconds(waitSeconds);
      let request = await deps.loadRequestImpl({ home: deps.home, env: deps.env, requestId });
      if (request.status === 'resolved') return terminalResult(request);

      const current = request.server && request.topic
        ? { server: request.server, topic: request.topic }
        : await config();
      const deadline = deps.nowImpl() + seconds * 1000;
      while (deps.nowImpl() < deadline) {
        const response = await deps.pollRemoteResponseImpl({
          config: current,
          responseTopic: request.responseTopic,
          requestId: request.requestId,
          allowed: request.allowed,
          kind: request.kind
        });
        if (response !== null) {
          const resolution = await deps.resolveRequestWithClaimImpl({
            home: deps.home,
            env: deps.env,
            requestId: request.requestId,
            response,
            resolvedAt: new Date(deps.nowImpl()).toISOString()
          });
          request = resolution.request;
          const acceptedResponse = resolution.claimed
            && request.decision === response.decision
            && (request.text ?? undefined) === (response.text ?? undefined);
          if (acceptedResponse) {
            await deps.sendResponseConfirmationImpl({
              config: current,
              response,
              kind: request.kind,
              title: request.kind === 'approval' ? 'Approval' : request.kind === 'refinement' ? 'Refinement' : 'Choice'
            });
          }
          return terminalResult(request);
        }
        const remaining = deadline - deps.nowImpl();
        if (remaining <= 0) break;
        await deps.sleepImpl(Math.min(1000, remaining));
      }
      return pendingResult(request.requestId);
    },

    async getRequest({ requestId }) {
      const request = await deps.loadRequestImpl({ home: deps.home, env: deps.env, requestId });
      return { status: 'ok', request: publicRequest(request) };
    },

    async listPending({ limit = 20 } = {}) {
      const requests = await deps.listPendingRequestsImpl({ home: deps.home, env: deps.env, limit });
      return { status: 'ok', requests: requests.map(publicRequest) };
    }
  };
}
