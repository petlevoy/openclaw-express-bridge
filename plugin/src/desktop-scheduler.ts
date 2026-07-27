/** Bounded per-chat FIFO dispatch with a small shared concurrency limit. */

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("desktop dispatch concurrency is invalid");
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolvePromise) =>
        this.waiters.push(resolvePromise),
      );
    }
    try {
      return await work();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

export interface DesktopDispatchSchedulerOptions {
  concurrency?: number;
  maxPendingPerChat?: number;
  maxPriorityPendingPerChat?: number;
  onError?: (chatId: string, error: unknown) => void;
}

export class DesktopRoundRobin<T> {
  private cursor = 0;

  constructor(private readonly values: readonly T[]) {
    if (!values.length) throw new Error("desktop round-robin list is empty");
  }

  next(): T {
    const value = this.values[this.cursor];
    this.cursor = (this.cursor + 1) % this.values.length;
    return value;
  }
}

export class DesktopDispatchScheduler {
  private readonly semaphore: AsyncSemaphore;
  private readonly maxPendingPerChat: number;
  private readonly maxPriorityPendingPerChat: number;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly priorityTails = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();
  private readonly priorityPending = new Map<string, number>();
  private readonly active = new Set<Promise<void>>();

  constructor(private readonly options: DesktopDispatchSchedulerOptions = {}) {
    this.semaphore = new AsyncSemaphore(options.concurrency ?? 2);
    this.maxPendingPerChat = options.maxPendingPerChat ?? 32;
    this.maxPriorityPendingPerChat = options.maxPriorityPendingPerChat ?? 4;
    if (
      !Number.isInteger(this.maxPendingPerChat) ||
      this.maxPendingPerChat < 1
    ) {
      throw new Error("desktop per-chat queue limit is invalid");
    }
    if (
      !Number.isInteger(this.maxPriorityPendingPerChat) ||
      this.maxPriorityPendingPerChat < 1
    ) {
      throw new Error("desktop priority queue limit is invalid");
    }
  }

  enqueue(chatId: string, work: () => Promise<void>): boolean {
    const count = this.pending.get(chatId) ?? 0;
    if (count >= this.maxPendingPerChat) return false;
    this.pending.set(chatId, count + 1);

    const previous = this.tails.get(chatId) ?? Promise.resolve();
    const execution = previous
      .catch(() => {})
      .then(() => this.semaphore.run(work))
      .catch((error) => this.options.onError?.(chatId, error))
      .finally(() => {
        const remaining = (this.pending.get(chatId) ?? 1) - 1;
        if (remaining > 0) this.pending.set(chatId, remaining);
        else this.pending.delete(chatId);
        if (this.tails.get(chatId) === execution) {
          this.tails.delete(chatId);
        }
      });
    this.tails.set(chatId, execution);
    this.active.add(execution);
    void execution.finally(() => this.active.delete(execution));
    return true;
  }

  /**
   * Run a control-plane event outside both the per-chat FIFO tail and the
   * shared model semaphore. Used only for bounded cancellation commands that
   * must be able to interrupt the turn currently holding that chat's lane.
   */
  runPriority(chatId: string, work: () => Promise<void>): boolean {
    const count = this.priorityPending.get(chatId) ?? 0;
    if (count >= this.maxPriorityPendingPerChat) return false;
    this.priorityPending.set(chatId, count + 1);

    const previous = this.priorityTails.get(chatId) ?? Promise.resolve();
    const execution = previous
      .catch(() => {})
      .then(work)
      .catch((error) => this.options.onError?.(chatId, error))
      .finally(() => {
        const remaining = (this.priorityPending.get(chatId) ?? 1) - 1;
        if (remaining > 0) this.priorityPending.set(chatId, remaining);
        else this.priorityPending.delete(chatId);
        if (this.priorityTails.get(chatId) === execution) {
          this.priorityTails.delete(chatId);
        }
      });
    this.priorityTails.set(chatId, execution);
    this.active.add(execution);
    void execution.finally(() => this.active.delete(execution));
    return true;
  }

  pendingFor(chatId: string): number {
    return this.pending.get(chatId) ?? 0;
  }

  async onIdle(): Promise<void> {
    while (this.active.size) {
      await Promise.all([...this.active]);
    }
  }
}
