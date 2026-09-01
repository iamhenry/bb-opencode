import { describe, expect, it, vi } from "vitest";
import {
  coalesceProviderEvents,
  OrderedEventPump,
  type ProviderEvent,
} from "../src/event-pump.js";

const status = (sessionID: string, value: string): ProviderEvent => ({
  type: "session.status",
  properties: { sessionID, status: { type: value } },
});

describe("provider event pump", () => {
  it("coalesces adjacent replaceable state while preserving barriers", () => {
    const part = {
      type: "message.part.delta",
      properties: { sessionID: "ses_1", delta: "x" },
    };
    expect(
      coalesceProviderEvents([
        status("ses_1", "busy"),
        status("ses_1", "retry"),
        part,
        status("ses_1", "idle"),
      ]),
    ).toEqual([status("ses_1", "retry"), part, status("ses_1", "idle")]);
  });

  it("serializes bounded batches without a promise chain per event", async () => {
    let active = 0;
    let peak = 0;
    const handled: string[] = [];
    const pump = new OrderedEventPump(
      async (event) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        handled.push(event.type);
        active -= 1;
      },
      { batchSize: 2, highWater: 4, onError: vi.fn() },
    );
    pump.enqueue({ type: "a" });
    pump.enqueue({ type: "b" });
    pump.enqueue({ type: "c" });
    await vi.waitFor(() => expect(handled).toEqual(["a", "b", "c"]));
    expect(peak).toBe(1);
    expect(pump.stats.handled).toBe(3);
  });

  it("caps an overloaded queue and reconciles after draining", async () => {
    let release: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handled: string[] = [];
    const overload = vi.fn();
    const idle = vi.fn();
    const pump = new OrderedEventPump(
      async (event) => {
        handled.push(event.type);
        if (event.type === "first") await first;
      },
      {
        batchSize: 1,
        highWater: 4,
        onError: vi.fn(),
        onOverload: overload,
        onIdle: idle,
      },
    );
    pump.enqueue({ type: "first" });
    await vi.waitFor(() => expect(handled).toEqual(["first"]));
    for (let index = 0; index < 10; index += 1) {
      pump.enqueue({ type: `critical-${index}` });
    }
    expect(pump.stats.dropped).toBe(6);
    expect(overload).toHaveBeenCalled();

    release?.();
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
    expect(handled).toEqual([
      "first",
      "critical-6",
      "critical-7",
      "critical-8",
      "critical-9",
    ]);
  });

  it("drops queued payloads on close", async () => {
    let release: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handled: string[] = [];
    const pump = new OrderedEventPump(
      async (event) => {
        handled.push(event.type);
        if (event.type === "first") await first;
      },
      { batchSize: 1, onError: vi.fn() },
    );
    pump.enqueue({ type: "first" });
    pump.enqueue({ type: "retained", properties: { output: "large" } });
    await vi.waitFor(() => expect(handled).toEqual(["first"]));
    pump.close();
    release?.();
    await Promise.resolve();
    expect(handled).toEqual(["first"]);
  });
});
