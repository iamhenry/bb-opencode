export interface ProviderEvent {
  type: string;
  properties?: unknown;
}

export interface EventPumpStats {
  enqueued: number;
  handled: number;
  coalesced: number;
  peakDepth: number;
  overloads: number;
  dropped: number;
  maxQueueAgeMs: number;
  maxHandlerMs: number;
}

interface EventPumpOptions {
  batchSize?: number;
  highWater?: number;
  onError(error: unknown): void;
  onOverload?(stats: Readonly<EventPumpStats>, dropped: readonly ProviderEvent[]): void;
  onIdle?(stats: Readonly<EventPumpStats>): void | Promise<void>;
  now?(): number;
}

function eventSessionId(event: ProviderEvent): string {
  const properties = event.properties;
  if (!properties || typeof properties !== "object") return "";
  const record = properties as Record<string, unknown>;
  if (typeof record.sessionID === "string") return record.sessionID;
  const info = record.info;
  if (info && typeof info === "object") {
    const id = (info as { sessionID?: unknown; id?: unknown }).sessionID;
    if (typeof id === "string") return id;
  }
  return "";
}

/** Events whose newest value supersedes earlier values within one batch. */
function coalesceKey(event: ProviderEvent): string | undefined {
  if (
    event.type !== "session.status" &&
    event.type !== "session.updated" &&
    event.type !== "session.diff" &&
    event.type !== "todo.updated"
  ) {
    return undefined;
  }
  return `${event.type}:${eventSessionId(event)}`;
}

/** Coalesce only adjacent state events; critical events remain ordering barriers. */
export function coalesceProviderEvents(
  events: readonly ProviderEvent[],
): ProviderEvent[] {
  const output: ProviderEvent[] = [];
  let pending: ProviderEvent[] = [];
  const positions = new Map<string, number>();
  const flush = () => {
    output.push(...pending);
    pending = [];
    positions.clear();
  };
  for (const event of events) {
    const key = coalesceKey(event);
    if (!key) {
      flush();
      output.push(event);
      continue;
    }
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, pending.length);
      pending.push(event);
    } else {
      pending[position] = event;
    }
  }
  flush();
  return output;
}

/**
 * Serial provider event pump without a promise-per-event retention chain.
 * Input is drained in bounded batches and replaceable state updates coalesce.
 */
export class OrderedEventPump {
  readonly stats: EventPumpStats = {
    enqueued: 0,
    handled: 0,
    coalesced: 0,
    peakDepth: 0,
    overloads: 0,
    dropped: 0,
    maxQueueAgeMs: 0,
    maxHandlerMs: 0,
  };

  private readonly batchSize: number;
  private readonly highWater: number;
  private queue: ProviderEvent[] = [];
  private draining = false;
  private scheduled = false;
  private closed = false;
  private overloadActive = false;
  private oldestQueuedAt: number | undefined;

  constructor(
    private readonly handle: (event: ProviderEvent) => Promise<void>,
    private readonly options: EventPumpOptions,
  ) {
    this.batchSize = Math.max(1, options.batchSize ?? 64);
    this.highWater = Math.max(this.batchSize, options.highWater ?? 2_048);
  }

  enqueue(event: ProviderEvent): void {
    if (this.closed) return;
    if (this.queue.length === 0) {
      this.oldestQueuedAt = this.options.now?.() ?? Date.now();
    }
    this.queue.push(event);
    this.stats.enqueued += 1;
    this.stats.peakDepth = Math.max(this.stats.peakDepth, this.queue.length);
    if (this.queue.length > this.highWater) {
      const compacted = coalesceProviderEvents(this.queue);
      this.stats.coalesced += this.queue.length - compacted.length;
      this.queue = compacted;
      if (this.queue.length > this.highWater) {
        const dropped = this.queue.splice(0, this.queue.length - this.highWater);
        this.stats.dropped += dropped.length;
        if (!this.overloadActive) {
          this.overloadActive = true;
          this.stats.overloads += 1;
          this.options.onOverload?.(this.stats, dropped);
        }
      }
    }
    if (this.scheduled || this.draining) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    this.oldestQueuedAt = undefined;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        if (this.oldestQueuedAt !== undefined) {
          this.stats.maxQueueAgeMs = Math.max(
            this.stats.maxQueueAgeMs,
            (this.options.now?.() ?? Date.now()) - this.oldestQueuedAt,
          );
        }
        const input = this.queue.splice(0, this.batchSize);
        const batch = coalesceProviderEvents(input);
        this.stats.coalesced += input.length - batch.length;
        for (const event of batch) {
          if (this.closed) return;
          const handlerStartedAt = this.options.now?.() ?? Date.now();
          try {
            await this.handle(event);
          } catch (error) {
            this.options.onError(error);
          } finally {
            this.stats.handled += 1;
            this.stats.maxHandlerMs = Math.max(
              this.stats.maxHandlerMs,
              (this.options.now?.() ?? Date.now()) - handlerStartedAt,
            );
          }
        }
        if (this.queue.length === 0) this.oldestQueuedAt = undefined;
      }
      if (!this.closed) {
        this.overloadActive = false;
        await this.options.onIdle?.(this.stats);
      }
    } finally {
      this.draining = false;
      if (!this.closed && this.queue.length > 0 && !this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          void this.drain();
        });
      }
    }
  }
}
