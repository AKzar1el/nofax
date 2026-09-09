import { loadConfig } from './config.mjs';
import {
  createRemoteRequest,
  pollRemoteResponse,
  sendNotification,
  sendResponseConfirmation
} from './ntfy.mjs';
import {
  listPendingRequests,
  loadRequest,
  resolveRequest,
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

function validateText(value, name, max = 2200) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`NOFAX_${name}_REQUIRED`);
  return value.trim().slice(0, max);
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
  return options.map((option) => {
    if (typeof option === 'string') {
      const value = option.trim();
      if (!value) throw new Error('NOFAX_CHOICE_INVALID');
      return { value: value.slice(0, 80), label: value.slice(0, 32) };
    }
    if (!option || typeof option.value !== 'string' || typeof option.label !== 'string') throw new Error('NOFAX_CHOICE_INVALID');
    const value = option.value.trim();
    const label = option.label.trim();
    if (!value || !label) throw new Error('NOFAX_CHOICE_INVALID');
    return { value: value.slice(0, 80), label: label.slice(0, 32) };
  });
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
    savePendingRequestImpl: overrides.savePendingRequestImpl ?? savePendingRequest,
    loadRequestImpl: overrides.loadRequestImpl ?? loadRequest,
    resolveRequestImpl: overrides.resolveRequestImpl ?? resolveRequest,
    listPendingRequestsImpl: overrides.listPendingRequestsImpl ?? listPendingRequests,
    nowImpl: overrides.nowImpl ?? Date.now,
    sleepImpl: overrides.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  };

  async function config() {
    return deps.loadConfigImpl({ home: deps.home, env: deps.env });
  }

  async function persistRemote({ kind, remote }) {
    const request = {
      version: 1,
      requestId: remote.requestId,
      kind,
      responseTopic: remote.responseTopic,
      allowed: remote.allowed,
      status: 'pending',
      createdAt: new Date(deps.nowImpl()).toISOString()
    };
    await deps.savePendingRequestImpl({ home: deps.home, env: deps.env, request });
    return pendingResult(remote.requestId);
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
      const remote = await deps.createRemoteRequestImpl({
        config: current,
        title: validateText(title, 'TITLE', 120),
        message: validateText(message, 'MESSAGE'),
        options: [
          { value: 'allow', label: 'Allow' },
          { value: 'deny', label: 'Deny' }
        ],
        includeRefine: allowRefine === true
      });
      return persistRemote({ kind: 'approval', remote });
    },

    async requestChoice({ title = 'Nofax choice', message, options }) {
      const current = await config();
      const normalized = validateChoiceOptions(options);
      const remote = await deps.createRemoteRequestImpl({
        config: current,
        title: validateText(title, 'TITLE', 120),
        message: validateText(message, 'MESSAGE'),
        options: normalized,
        includeRefine: false
      });
      return persistRemote({ kind: 'choice', remote });
    },

    async requestRefinement({ title = 'Nofax refinement', message }) {
      const current = await config();
      const remote = await deps.createRemoteRequestImpl({
        config: current,
        title: validateText(title, 'TITLE', 120),
        message: validateText(message, 'MESSAGE'),
        options: [],
        includeRefine: true
      });
      return persistRemote({ kind: 'refinement', remote });
    },

    async waitForResponse({ requestId, waitSeconds }) {
      const seconds = validateWaitSeconds(waitSeconds);
      let request = await deps.loadRequestImpl({ home: deps.home, env: deps.env, requestId });
      if (request.status === 'resolved') return terminalResult(request);

      const current = await config();
      const deadline = deps.nowImpl() + seconds * 1000;
      while (deps.nowImpl() < deadline) {
        const response = await deps.pollRemoteResponseImpl({
          config: current,
          responseTopic: request.responseTopic,
          requestId: request.requestId,
          allowed: request.allowed
        });
        if (response !== null) {
          request = await deps.resolveRequestImpl({
            home: deps.home,
            env: deps.env,
            requestId: request.requestId,
            response,
            resolvedAt: new Date(deps.nowImpl()).toISOString()
          });
          await deps.sendResponseConfirmationImpl({
            config: current,
            response,
            title: request.kind === 'approval' ? 'Approval' : request.kind === 'refinement' ? 'Refinement' : 'Choice'
          });
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
