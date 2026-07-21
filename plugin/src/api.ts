/**
 * BotX HTTP client — token acquisition, message sending, and file operations.
 * https://express.ms/botx-api-docs
 */

import type {
  BotXFileMetadata,
  BotXNotificationResponse,
  BotXTokenResponse,
} from "./types.js";

// ─── Errors ───────────────────────────────────────────────────

export class BotXApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "BotXApiError";
  }
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  attempt = 0,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (response.status === 429 && attempt < 3) {
      const retryAfter = parseInt(
        response.headers.get("retry-after") ?? "5",
        10,
      );
      await sleep(Math.min(retryAfter * 1000, 15_000));
      return fetchWithRetry(url, options, attempt + 1);
    }

    if (response.status >= 500 && attempt < 3) {
      await sleep(Math.pow(2, attempt) * 1000);
      return fetchWithRetry(url, options, attempt + 1);
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Token management ─────────────────────────────────────────

export interface TokenState {
  token: string;
  expiresAt: number; // Unix ms
}

/**
 * Fetch a new JWT token from BotX.
 */
export async function getToken(
  ctsUrl: string,
  botId: string,
  secretKey: string,
): Promise<string> {
  const url = `${ctsUrl}/api/v3/botx/bots/${botId}/token`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret_key: secretKey }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new BotXApiError(
      `BotX getToken failed [${response.status}]: ${text}`,
      response.status,
    );
  }

  const data = (await response.json()) as BotXTokenResponse;
  if (data.status !== "ok" || !data.result) {
    throw new BotXApiError(
      `BotX getToken error: ${JSON.stringify(data.errors ?? data)}`,
      response.status,
    );
  }

  return data.result;
}

/**
 * Token cache per account — tokens are valid for ~24h but we refresh every 20h.
 */
const tokenCache = new Map<string, TokenState>();
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours

export async function getCachedToken(
  ctsUrl: string,
  botId: string,
  secretKey: string,
  accountId: string,
): Promise<string> {
  const cached = tokenCache.get(accountId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }
  const token = await getToken(ctsUrl, botId, secretKey);
  tokenCache.set(accountId, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function invalidateToken(accountId: string): void {
  tokenCache.delete(accountId);
}

// ─── Send message ─────────────────────────────────────────────

/**
 * Send a direct notification message via BotX.
 */
export async function sendMessage(
  ctsUrl: string,
  token: string,
  groupChatId: string,
  text: string,
): Promise<string> {
  const url = `${ctsUrl}/api/v3/botx/notifications/direct`;
  const body = {
    group_chat_id: groupChatId,
    notification: {
      body: { body: text },
    },
  };

  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    throw new UnauthorizedError("BotX 401 Unauthorized");
  }

  if (!response.ok) {
    const text2 = await response.text().catch(() => "");
    throw new BotXApiError(
      `BotX sendMessage failed [${response.status}]: ${text2}`,
      response.status,
    );
  }

  const data = (await response.json()) as BotXNotificationResponse;
  return data.result?.sync_id ?? "";
}

/**
 * Send message with automatic token refresh on 401.
 */
export async function sendMessageWithRefresh(
  ctsUrl: string,
  botId: string,
  secretKey: string,
  accountId: string,
  groupChatId: string,
  text: string,
): Promise<string> {
  let token = await getCachedToken(ctsUrl, botId, secretKey, accountId);
  try {
    return await sendMessage(ctsUrl, token, groupChatId, text);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // Refresh token and retry once
      invalidateToken(accountId);
      token = await getToken(ctsUrl, botId, secretKey);
      tokenCache.set(accountId, {
        token,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      });
      return await sendMessage(ctsUrl, token, groupChatId, text);
    }
    throw err;
  }
}

// ─── File operations ──────────────────────────────────────────

/**
 * Download a file from BotX by file metadata.
 */
export async function downloadFile(
  ctsUrl: string,
  token: string,
  fileUrl: string,
): Promise<Buffer> {
  const url = fileUrl.startsWith("http") ? fileUrl : `${ctsUrl}${fileUrl}`;
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new BotXApiError(
      `BotX downloadFile failed [${response.status}]: ${text}`,
      response.status,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── Re-exports ───────────────────────────────────────────────

export type { BotXFileMetadata };
