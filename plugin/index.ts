import { setExpressRuntime } from "./src/runtime.js";
import { expressPlugin } from "./src/channel.js";

const plugin = {
  id: "openclaw-express",
  name: "eXpress",
  description: "eXpress channel plugin (BotX or official Linux desktop bridge)",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: {
    runtime: unknown;
    registerChannel: (opts: { plugin: unknown }) => void;
    logger: { info: (msg: string) => void; warn?: (msg: string) => void };
  }) {
    setExpressRuntime(api.runtime as Parameters<typeof setExpressRuntime>[0]);
    api.registerChannel({ plugin: expressPlugin });
    api.logger.info(
      "eXpress channel plugin registered (BotX + desktop bridge v2.2.3; native typing acknowledgement available)",
    );
  },
};

export default plugin;
