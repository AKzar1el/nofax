/// <reference types="@cloudflare/workers-types" />

import type { Env as NofaxEnv } from "../src/env";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends NofaxEnv {}
}
