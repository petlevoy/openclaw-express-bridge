import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import { setExpressRuntime } from "./src/runtime.js";
import { expressPlugin } from "./src/channel.js";
import { registerExpressToolConcurrencyGuard } from "./src/tool-concurrency-guard.js";

const plugin = {
  id: "openclaw-express",
  name: "eXpress",
  description: "eXpress channel plugin (BotX or official Linux desktop bridge)",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: OpenClawPluginApi) {
    setExpressRuntime(api.runtime as Parameters<typeof setExpressRuntime>[0]);
    api.registerChannel({ plugin: expressPlugin });
    registerExpressToolConcurrencyGuard(api, 3);
    api.logger.info(
      "eXpress channel plugin registered (BotX + desktop bridge v2.3.4; bounded tool fan-out and durable desktop-send reconciliation active)",
    );
  },
};

export default plugin;
