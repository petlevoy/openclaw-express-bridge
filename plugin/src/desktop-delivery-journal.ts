import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ResolvedExpressAccount } from "./accounts.js";
import type { DesktopSnapshot } from "./desktop-cdp.js";

const JOURNAL_VERSION = 2;
const JOURNAL_MAX_ENTRIES = 256;
const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DesktopDeliveryAttempt {
  id: string;
  textSha256: string;
  baselineOwnMessageIds: string[];
  dispatchedAt: number;
  messageId?: string;
}

export interface DesktopDeliveryEntry {
  queueId: string;
  chatId: string;
  attempts: DesktopDeliveryAttempt[];
  updatedAt: number;
}

export interface DesktopDeliveryJournal {
  version: 2;
  initializedAt: number;
  entries: Record<string, DesktopDeliveryEntry>;
}

interface LegacyDesktopDeliveryAttempt {
  id: string;
  text: string;
  baselineOwnMessageIds: string[];
  dispatchedAt: number;
  messageId?: string;
}

interface LegacyDesktopDeliveryJournal {
  version: 1;
  initializedAt: number;
  entries: Record<
    string,
    Omit<DesktopDeliveryEntry, "attempts"> & {
      attempts: LegacyDesktopDeliveryAttempt[];
    }
  >;
}

export type DesktopDeliveryReconciliation =
  | { status: "sent"; messageIds: string[] }
  | { status: "not_sent" }
  | { status: "unresolved"; error: string };

class JournalMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

const journalMutexes = new Map<string, JournalMutex>();

function mutexFor(path: string): JournalMutex {
  let mutex = journalMutexes.get(path);
  if (!mutex) {
    mutex = new JournalMutex();
    journalMutexes.set(path, mutex);
  }
  return mutex;
}

function resolveUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

export function desktopDeliveryJournalPath(
  account: ResolvedExpressAccount,
): string {
  const statePath = account.config.desktopStatePath;
  if (statePath) {
    return join(
      dirname(resolveUserPath(statePath)),
      `desktop-delivery-journal-${account.accountId}.json`,
    );
  }
  const openClawHome = resolveUserPath(
    process.env.OPENCLAW_HOME?.trim() || "~/.openclaw",
  );
  return join(
    openClawHome,
    "express",
    `desktop-delivery-journal-${account.accountId}.json`,
  );
}

function emptyJournal(now = Date.now()): DesktopDeliveryJournal {
  return {
    version: JOURNAL_VERSION,
    initializedAt: now,
    entries: {},
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function desktopDeliveryTextSha256(value: string): string {
  return createHash("sha256")
    .update(normalizeText(value), "utf8")
    .digest("hex");
}

function hasJournalEnvelope(value: unknown): value is {
  version: unknown;
  initializedAt: number;
  entries: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const parsed = value as Record<string, unknown>;
  return (
    typeof parsed.initializedAt === "number" &&
    Boolean(parsed.entries) &&
    typeof parsed.entries === "object" &&
    !Array.isArray(parsed.entries)
  );
}

export function parseDesktopDeliveryJournal(
  value: string,
): DesktopDeliveryJournal {
  const parsed = JSON.parse(value) as unknown;
  if (!hasJournalEnvelope(parsed)) {
    throw new Error("desktop eXpress delivery journal is invalid");
  }
  if (parsed.version === 1) {
    const legacy = parsed as LegacyDesktopDeliveryJournal;
    return {
      version: JOURNAL_VERSION,
      initializedAt: legacy.initializedAt,
      entries: Object.fromEntries(
        Object.entries(legacy.entries).map(([queueId, entry]) => [
          queueId,
          {
            ...entry,
            attempts: entry.attempts.map((attempt) => {
              const { text, ...retained } = attempt;
              return {
                ...retained,
                textSha256: desktopDeliveryTextSha256(text),
              };
            }),
          },
        ]),
      ),
    };
  }
  if (
    parsed.version !== JOURNAL_VERSION ||
    !Object.values(parsed.entries).every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const attempts = (entry as { attempts?: unknown }).attempts;
      return (
        Array.isArray(attempts) &&
        attempts.every(
          (attempt) =>
            Boolean(attempt) &&
            typeof attempt === "object" &&
            typeof (attempt as { textSha256?: unknown }).textSha256 ===
              "string",
        )
      );
    })
  ) {
    throw new Error("desktop eXpress delivery journal is invalid");
  }
  return parsed as unknown as DesktopDeliveryJournal;
}

async function readJournal(
  path: string,
): Promise<DesktopDeliveryJournal | null> {
  try {
    return parseDesktopDeliveryJournal(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function pruneJournal(journal: DesktopDeliveryJournal, now = Date.now()): void {
  const retained = Object.values(journal.entries)
    .filter((entry) => now - entry.updatedAt <= JOURNAL_MAX_AGE_MS)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, JOURNAL_MAX_ENTRIES);
  journal.entries = Object.fromEntries(
    retained.map((entry) => [entry.queueId, entry]),
  );
}

async function writeJournal(
  path: string,
  journal: DesktopDeliveryJournal,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(journal)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

async function mutateJournal<T>(
  account: ResolvedExpressAccount,
  mutate: (journal: DesktopDeliveryJournal) => T | Promise<T>,
): Promise<T> {
  const path = desktopDeliveryJournalPath(account);
  return mutexFor(path).run(async () => {
    const journal = (await readJournal(path)) ?? emptyJournal();
    const result = await mutate(journal);
    pruneJournal(journal);
    await writeJournal(path, journal);
    return result;
  });
}

export async function initializeDesktopDeliveryJournal(
  account: ResolvedExpressAccount,
): Promise<void> {
  if (account.mode !== "desktop") return;
  await mutateJournal(account, () => undefined);
}

export async function recordDesktopDeliveryDispatch(
  account: ResolvedExpressAccount,
  params: {
    queueId: string;
    chatId: string;
    attemptId: string;
    text: string;
    baselineOwnMessageIds: string[];
    dispatchedAt?: number;
  },
): Promise<void> {
  await mutateJournal(account, (journal) => {
    const now = params.dispatchedAt ?? Date.now();
    const existing = journal.entries[params.queueId];
    const entry: DesktopDeliveryEntry = existing ?? {
      queueId: params.queueId,
      chatId: params.chatId,
      attempts: [],
      updatedAt: now,
    };
    if (entry.chatId !== params.chatId) {
      throw new Error("desktop eXpress delivery journal target changed");
    }
    entry.attempts.push({
      id: params.attemptId,
      textSha256: desktopDeliveryTextSha256(params.text),
      baselineOwnMessageIds: [...params.baselineOwnMessageIds],
      dispatchedAt: now,
    });
    entry.updatedAt = now;
    journal.entries[params.queueId] = entry;
  });
}

export async function recordDesktopDeliverySuccess(
  account: ResolvedExpressAccount,
  params: { queueId: string; attemptId: string; messageId: string },
): Promise<void> {
  await mutateJournal(account, (journal) => {
    const entry = journal.entries[params.queueId];
    const attempt = entry?.attempts.find(
      (candidate) => candidate.id === params.attemptId,
    );
    if (!entry || !attempt) {
      throw new Error("desktop eXpress delivery attempt is missing");
    }
    attempt.messageId = params.messageId;
    entry.updatedAt = Date.now();
  });
}

export async function loadDesktopDeliveryJournal(
  account: ResolvedExpressAccount,
): Promise<DesktopDeliveryJournal | null> {
  return readJournal(desktopDeliveryJournalPath(account));
}

export async function resetDesktopDeliveryEntry(
  account: ResolvedExpressAccount,
  queueId: string,
): Promise<void> {
  await mutateJournal(account, (journal) => {
    delete journal.entries[queueId];
  });
}

export function desktopDeliveryEntryNeedsReconciliation(
  entry: DesktopDeliveryEntry,
): boolean {
  return entry.attempts.some((attempt) => !attempt.messageId);
}

export function reconcileDesktopDeliveryEntry(params: {
  journal: DesktopDeliveryJournal;
  queueId: string;
  enqueuedAt: number;
  chatId: string;
  expectedTexts: string[];
  snapshot?: Pick<DesktopSnapshot, "ownMessages">;
}): DesktopDeliveryReconciliation {
  const expectedTexts = params.expectedTexts.map(normalizeText).filter(Boolean);
  if (expectedTexts.length === 0) {
    return { status: "unresolved", error: "delivery has no text to reconcile" };
  }
  const entry = params.journal.entries[params.queueId];
  if (!entry) {
    return params.enqueuedAt >= params.journal.initializedAt
      ? { status: "not_sent" }
      : {
          status: "unresolved",
          error: "delivery predates the desktop reconciliation journal",
        };
  }
  if (entry.chatId !== params.chatId) {
    return { status: "unresolved", error: "delivery target does not match" };
  }

  const messageIds: string[] = [];
  for (const [index, expectedText] of expectedTexts.entries()) {
    const attempt = entry.attempts[index];
    if (
      !attempt ||
      attempt.textSha256 !== desktopDeliveryTextSha256(expectedText)
    ) {
      return messageIds.length === 0
        ? { status: "not_sent" }
        : {
            status: "unresolved",
            error: "only part of the desktop delivery was attempted",
          };
    }
    if (attempt.messageId) {
      messageIds.push(attempt.messageId);
      continue;
    }
    if (!params.snapshot) {
      return {
        status: "unresolved",
        error: "desktop snapshot is required for an unconfirmed attempt",
      };
    }
    const baselineIds = new Set(attempt.baselineOwnMessageIds);
    const delivered = params.snapshot.ownMessages.find(
      (message) =>
        !baselineIds.has(message.id) &&
        message.type === "text" &&
        normalizeText(message.text) === expectedText,
    );
    if (delivered) {
      messageIds.push(delivered.id);
      continue;
    }
    const baselineStillVisible = attempt.baselineOwnMessageIds.every((id) =>
      params.snapshot?.ownMessages.some((message) => message.id === id),
    );
    if (baselineStillVisible && messageIds.length === 0) {
      return { status: "not_sent" };
    }
    return {
      status: "unresolved",
      error: "desktop history cannot prove the send outcome",
    };
  }
  return { status: "sent", messageIds };
}
