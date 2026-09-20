import { buildAgentSummary } from '../protocol.mjs';
import { requestApproval, sendNotification } from '../ntfy.mjs';

export async function handleGeminiNotification(input, {
  config,
  sendNotificationImpl = sendNotification
} = {}) {
  if (!input || input.hook_event_name !== 'Notification') throw new Error('NOFAX_GEMINI_EVENT');
  const type = typeof input.notification_type === 'string' && input.notification_type
    ? input.notification_type
    : 'Notification';
  await sendNotificationImpl({
    config,
    title: `Gemini CLI: ${type}`,
    message: buildAgentSummary({
      source: 'Gemini CLI',
      message: typeof input.message === 'string' ? input.message : 'Gemini CLI needs attention.',
      toolInput: input.details
    })
  });
  return {};
}

export async function handleGeminiHook(input, {
  config,
  requestApprovalImpl = requestApproval,
  sendNotificationImpl = sendNotification,
  onError = () => {}
} = {}) {
  if (!input || typeof input.hook_event_name !== 'string') throw new Error('NOFAX_GEMINI_EVENT');
  if (input.hook_event_name === 'Notification') {
    return handleGeminiNotification(input, { config, sendNotificationImpl });
  }
  if (input.hook_event_name !== 'BeforeTool') throw new Error('NOFAX_GEMINI_EVENT');
  if (typeof input.tool_name !== 'string' || !input.tool_name) throw new Error('NOFAX_GEMINI_TOOL');

  try {
    const result = await requestApprovalImpl({
      config,
      title: `Gemini CLI needs approval: ${input.tool_name}`,
      message: buildAgentSummary({
        source: 'Gemini CLI',
        toolName: input.tool_name,
        cwd: input.cwd,
        toolInput: input.tool_input
      })
    });
    if (result.decision === 'allow') return { decision: 'allow' };
    if (result.decision === 'deny') {
      return { decision: 'deny', reason: 'Denied remotely via Nofax.' };
    }
    return {};
  } catch (error) {
    onError(error);
    return {};
  }
}
