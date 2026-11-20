export interface Env {
  REQUESTS: DurableObjectNamespace;
  NOFAX_REMOTE_KEY: string;
  NOFAX_MCP_HOSTNAME?: string;
  NTFY_TOPIC: string;
  NTFY_SERVER?: string;
  NOFAX_NTFY_TOKEN?: string;
}
