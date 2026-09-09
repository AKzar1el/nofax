import { buildAgentSummary } from '../protocol.mjs';
import { requestApproval } from '../ntfy.mjs';

function assertCodexPermissionRequest(input) {
  if (!input || input.hook_event_name !== 'PermissionRequest') throw new Error('NOFAX_CODEX_EVENT');
  if (typeof input.tool_name !== 'string' || !input.tool_name) throw new Error('NOFAX_CODEX_TOOL');
}

export async function handleCodexPermissionRequest(input, {
  config,
  requestApprovalImpl = requestApproval,
  onError = () => {}
} = {}) {
  assertCodexPermissionRequest(input);
  try {
    const result = await requestApprovalImpl({
      config,
      title: `Codex needs approval: ${input.tool_name}`,
      message: buildAgentSummary({
        source: 'Codex',
        toolName: input.tool_name,
        cwd: input.cwd,
        toolInput: input.tool_input
      })
    });
    if (result.decision === 'allow') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' }
        }
      };
    }
    if (result.decision === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'Denied remotely via Nofax.' }
        }
      };
    }
    return null;
  } catch (error) {
    onError(error);
    return null;
  }
}
