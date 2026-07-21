/**
 * Webhook HTTP server for BotX incoming commands and notification callbacks.
 *
 * BotX API sends:
 * - POST /command — incoming user commands
 * - POST /notification/callback — delivery status callbacks
 * - GET /status — health check
 */

import * as http from "node:http";

import type { BotXCommandPayload, BotXNotificationCallback } from "./types.js";

export type CommandHandler = (payload: BotXCommandPayload) => Promise<void>;
export type CallbackHandler = (
  payload: BotXNotificationCallback,
) => Promise<void>;

export interface WebhookServer {
  server: http.Server;
  close: () => Promise<void>;
}

export interface WebhookOptions {
  /** Handler for incoming /command payloads */
  onCommand: CommandHandler;
  /** Handler for /notification/callback payloads (optional) */
  onCallback?: CallbackHandler;
  /** Optional secret token for request verification */
  secret?: string;
}

/**
 * Start the BotX webhook HTTP server.
 */
export function startWebhookServer(
  port: number,
  opts: WebhookOptions,
): WebhookServer {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // ─── Status endpoint ─────────────────────────────────────
    if (method === "GET" && url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", commands: [] }));
      return;
    }

    // ─── Delivery callback ───────────────────────────────────
    if (method === "POST" && url === "/notification/callback") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));

        if (!opts.onCallback) return;

        const raw = Buffer.concat(chunks).toString("utf-8");
        let payload: BotXNotificationCallback;
        try {
          payload = JSON.parse(raw) as BotXNotificationCallback;
        } catch {
          return;
        }

        opts.onCallback(payload).catch(() => {});
      });
      return;
    }

    // ─── Incoming command ────────────────────────────────────
    if (method === "POST" && url === "/command") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        // Respond immediately — BotX expects fast ack
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));

        const raw = Buffer.concat(chunks).toString("utf-8");
        let payload: BotXCommandPayload;
        try {
          payload = JSON.parse(raw) as BotXCommandPayload;
        } catch {
          return; // Ignore malformed JSON
        }

        // Fire-and-forget; errors caught inside handler
        opts.onCommand(payload).catch(() => {});
      });
      return;
    }

    // ─── 404 for everything else ─────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port);

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

  return { server, close };
}
