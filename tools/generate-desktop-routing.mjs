#!/usr/bin/env node

/**
 * Generate non-secret OpenClaw config fragments for exact eXpress desktop
 * routing. This tool only reads the explicitly supplied JSON file and writes
 * JSON to stdout; it never opens or modifies openclaw.json.
 *
 * Input: [{chatId,chatTitle,senderId,senderName?,agentId?}, ...]
 */

import { readFile } from "node:fs/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const allowedKeys = new Set([
  "chatId",
  "chatTitle",
  "senderId",
  "senderName",
  "agentId",
  "enabled",
]);

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

if (process.argv.length !== 3) {
  fail("usage: generate-desktop-routing.mjs CHATS.json");
}

let input;
try {
  input = JSON.parse(await readFile(process.argv[2], "utf8"));
} catch {
  fail("input must be a readable JSON file");
}
if (!Array.isArray(input) || input.length < 1 || input.length > 32) {
  fail("input must be an array containing 1..32 chat objects");
}

const chatIds = new Set();
const chatTitles = new Set();
const senderIds = new Set();
const desktopChats = input.map((raw, index) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`entry ${index} must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) fail(`entry ${index} has unknown key ${key}`);
  }
  const chatId = String(raw.chatId ?? "").toLowerCase();
  const senderId = String(raw.senderId ?? "").toLowerCase();
  const chatTitle = String(raw.chatTitle ?? "").trim();
  const senderName =
    raw.senderName == null ? undefined : String(raw.senderName).trim();
  const agentId = raw.agentId == null ? undefined : String(raw.agentId);
  if (!UUID.test(chatId)) fail(`entry ${index} chatId is not a UUID`);
  if (!UUID.test(senderId)) fail(`entry ${index} senderId is not a UUID`);
  if (!chatTitle) fail(`entry ${index} chatTitle is empty`);
  if (raw.senderName != null && !senderName)
    fail(`entry ${index} senderName is empty`);
  if (agentId && !AGENT_ID.test(agentId))
    fail(`entry ${index} agentId is unsafe`);
  if (chatIds.has(chatId)) fail(`duplicate chatId ${chatId}`);
  if (chatTitles.has(chatTitle)) fail(`duplicate chatTitle ${chatTitle}`);
  if (senderIds.has(senderId)) fail(`duplicate senderId ${senderId}`);
  chatIds.add(chatId);
  chatTitles.add(chatTitle);
  senderIds.add(senderId);
  return {
    chatId,
    chatTitle,
    senderId,
    ...(senderName ? { senderName } : {}),
    ...(raw.enabled === false ? { enabled: false } : {}),
    ...(agentId ? { agentId } : {}),
  };
});

const output = {
  channels: {
    express: {
      desktopChats: desktopChats.map(({ agentId: _agentId, ...chat }) => chat),
      allowFrom: desktopChats
        .filter((chat) => chat.enabled !== false)
        .flatMap((chat) => [chat.chatId, chat.senderId]),
    },
  },
  bindings: desktopChats
    .filter((chat) => chat.enabled !== false && chat.agentId)
    .map((chat) => ({
      agentId: chat.agentId,
      match: {
        channel: "express",
        peer: { kind: "direct", id: chat.senderId },
      },
    })),
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
