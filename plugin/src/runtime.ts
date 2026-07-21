/**
 * Runtime store for eXpress plugin — holds the OpenClaw plugin runtime reference.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let runtime: PluginRuntime | null = null;

export function setExpressRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getExpressRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("eXpress runtime not initialized");
  }
  return runtime;
}
