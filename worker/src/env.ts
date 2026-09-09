export interface Env {
  REQUESTS: DurableObjectNamespace;
  NTFY_TOPIC?: string;
  NTFY_SERVER?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_USER_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  NOFAX_REMOTE_KEY: string;
}
