import { describe, expect, it } from "vitest";

import { DesktopDeliveryWatchdog } from "./desktop-watchdog.js";

const healthyState = {
  seen: 1,
  acknowledged: 0,
  claimed: 0,
  failures: 0,
  quarantined: 0,
};

describe("desktop delivery watchdog", () => {
  it("stays quiet for a healthy active turn and clears it on completion", () => {
    const watchdog = new DesktopDeliveryWatchdog(1_000);
    watchdog.begin("message-one", 100);
    expect(
      watchdog.audit({
        dedupe: [{ ...healthyState, claimed: 1 }],
        journalEntries: [],
        now: 500,
      }),
    ).toEqual([]);
    watchdog.end("message-one");
    expect(
      watchdog.audit({
        dedupe: [healthyState],
        journalEntries: [],
        now: 2_000,
      }),
    ).toEqual([]);
  });

  it("reports stale work, orphan claims, retries, quarantine and outbox age", () => {
    const watchdog = new DesktopDeliveryWatchdog(1_000);
    watchdog.begin("message-one", 100);
    const issues = watchdog.audit({
      dedupe: [
        {
          ...healthyState,
          claimed: 2,
          failures: 1,
          quarantined: 1,
        },
      ],
      journalEntries: [{ updatedAt: 50, unresolved: true }],
      now: 2_000,
    });
    expect(issues).toEqual([
      "1 inbound turn(s) pending for at least 1s",
      "1 durable inbound claim(s) have no live task",
      "1 inbound event(s) are awaiting retry",
      "1 inbound event(s) are quarantined",
      "1 durable outbound delivery entry/entries are stale",
    ]);
  });

  it("does not report retained confirmed delivery evidence as stale", () => {
    const watchdog = new DesktopDeliveryWatchdog(1_000);
    expect(
      watchdog.audit({
        dedupe: [healthyState],
        journalEntries: [{ updatedAt: 50, unresolved: false }],
        now: 2_000,
      }),
    ).toEqual([]);
  });
});
