import { buildAgentSummary } from '../protocol.mjs';
import { requestApproval } from '../ntfy.mjs';

function assertClaudePermissionRequest(input) {
  if (!input || input.hook_event_name !== 'PermissionRequest') throw new Error('NOFAX_CLAUDE_EVENT');
  if (typeof input.tool_name !== 'string' || !input.tool_name) throw new Error('NOFAX_CLAUDE_TOOL');
}

export async function handleClaudePermissionRequest(input, {
  config,
  requestApprovalImpl = requestApproval,
  onError = () => {}
} = {}) {
  assertClaudePermissionRequest(input);
  try {
    const result = await requestApprovalImpl({
      config,
      title: `Claude Code needs approval: ${input.tool_name}`,
      message: buildAgentSummary({
        source: 'Claude Code',
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
