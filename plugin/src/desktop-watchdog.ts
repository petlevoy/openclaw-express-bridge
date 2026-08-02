import type { DesktopDedupeHealth } from "./desktop-cdp.js";

export const DEFAULT_DESKTOP_WATCHDOG_WARN_MS = 120_000;

export interface DesktopWatchdogJournalEntry {
  updatedAt: number;
  unresolved: boolean;
}

export interface DesktopWatchdogAuditInput {
  dedupe: DesktopDedupeHealth[];
  journalEntries: DesktopWatchdogJournalEntry[];
  now?: number;
}

interface PendingInbound {
  startedAt: number;
}

/**
 * Payload-free health accounting for the desktop bridge. It never calls a
 * model and deliberately reports only counts/ages, not chat or message text.
 */
export class DesktopDeliveryWatchdog {
  private readonly pending = new Map<string, PendingInbound>();

  constructor(private readonly warnAfterMs = DEFAULT_DESKTOP_WATCHDOG_WARN_MS) {
    if (!Number.isFinite(warnAfterMs) || warnAfterMs < 1) {
      throw new Error("desktop watchdog threshold is invalid");
    }
  }

  begin(messageId: string, now = Date.now()): void {
    if (!this.pending.has(messageId)) {
      this.pending.set(messageId, { startedAt: now });
    }
  }

  end(messageId: string): void {
    this.pending.delete(messageId);
  }

  audit(input: DesktopWatchdogAuditInput): string[] {
    const now = input.now ?? Date.now();
    const issues: string[] = [];
    const stalePending = [...this.pending.values()].filter(
      (entry) => now - entry.startedAt >= this.warnAfterMs,
    );
    if (stalePending.length > 0) {
      const oldestAgeMs = Math.max(
        ...stalePending.map((entry) => now - entry.startedAt),
      );
      issues.push(
        `${stalePending.length} inbound turn(s) pending for at least ${Math.floor(oldestAgeMs / 1000)}s`,
      );
    }

    const totals = input.dedupe.reduce(
      (sum, state) => ({
        claimed: sum.claimed + state.claimed,
        failures: sum.failures + state.failures,
        quarantined: sum.quarantined + state.quarantined,
      }),
      { claimed: 0, failures: 0, quarantined: 0 },
    );
    const orphanClaims = Math.max(0, totals.claimed - this.pending.size);
    if (orphanClaims > 0) {
      issues.push(`${orphanClaims} durable inbound claim(s) have no live task`);
    }
    if (totals.failures > 0) {
      issues.push(`${totals.failures} inbound event(s) are awaiting retry`);
    }
    if (totals.quarantined > 0) {
      issues.push(`${totals.quarantined} inbound event(s) are quarantined`);
    }

    const staleDeliveries = input.journalEntries.filter(
      (entry) => entry.unresolved && now - entry.updatedAt >= this.warnAfterMs,
    );
    if (staleDeliveries.length > 0) {
      issues.push(
        `${staleDeliveries.length} durable outbound delivery entry/entries are stale`,
      );
    }
    return issues;
  }
}
