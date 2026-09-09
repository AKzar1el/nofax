import { buildAgentSummary } from '../protocol.mjs';
import { sendNotification } from '../ntfy.mjs';

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
