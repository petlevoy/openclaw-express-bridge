/**
 * Tests for webhook server
 */

import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { BotXCommandPayload } from "./types.js";
import { startWebhookServer, type WebhookServer } from "./webhook.js";

describe("Webhook Server", () => {
  let server: WebhookServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("should start and respond to /status", async () => {
    server = startWebhookServer(0, {
      onCommand: async () => {},
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => {
      server!.server.once("listening", resolve);
    });

    const addr = server.server.address() as AddressInfo;

    const response = await fetch(`http://localhost:${addr.port}/status`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  it("should accept POST /command and call handler", async () => {
    let receivedPayload: BotXCommandPayload | null = null;

    server = startWebhookServer(0, {
      onCommand: async (payload) => {
        receivedPayload = payload;
      },
    });

    await new Promise<void>((resolve) => {
      server!.server.once("listening", resolve);
    });

    const addr = server.server.address() as AddressInfo;
    const testPayload: BotXCommandPayload = {
      sync_id: "sync-1",
      bot_id: "bot-1",
      command: {
        body: { body: "Hello bot" },
        command_type: "user",
        data: {},
        metadata: {},
      },
      from: {
        huid: "user-uuid",
        chat_id: "chat-uuid",
        username: "testuser",
      },
    };

    const response = await fetch(`http://localhost:${addr.port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testPayload),
    });

    expect(response.status).toBe(200);

    // Wait for async handler
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload!.sync_id).toBe("sync-1");
    expect(receivedPayload!.command.body.body).toBe("Hello bot");
  });

  it("should accept POST /notification/callback", async () => {
    let callbackCalled = false;

    server = startWebhookServer(0, {
      onCommand: async () => {},
      onCallback: async () => {
        callbackCalled = true;
      },
    });

    await new Promise<void>((resolve) => {
      server!.server.once("listening", resolve);
    });

    const addr = server.server.address() as AddressInfo;

    const response = await fetch(
      `http://localhost:${addr.port}/notification/callback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notification_id: "n-1",
          source: "test",
          group_chat_id: "chat-1",
          status: "ok",
        }),
      },
    );

    expect(response.status).toBe(200);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(callbackCalled).toBe(true);
  });

  it("should return 404 for unknown paths", async () => {
    server = startWebhookServer(0, {
      onCommand: async () => {},
    });

    await new Promise<void>((resolve) => {
      server!.server.once("listening", resolve);
    });

    const addr = server.server.address() as AddressInfo;

    const response = await fetch(`http://localhost:${addr.port}/unknown`);
    expect(response.status).toBe(404);
  });
});
