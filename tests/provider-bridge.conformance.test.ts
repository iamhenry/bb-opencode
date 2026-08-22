import { afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
  experimental_toConformanceMessages as toConformanceMessages,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  BridgeConformanceTransport,
  CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine, resetBridgeForTests } from "../src/bridge.js";
import { createFakeOpenCode } from "./fake-opencode.js";

let output: CapturedBridgeJsonRpcOutput;

beforeEach(() => {
  const fake = createFakeOpenCode();
  resetBridgeForTests({
    acquire: () => fake.client,
    attach: async () => ({ url: fake.client.url, pid: 1, port: 9 }),
  });
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  resetBridgeForTests();
});

it("passes the canonical protocol suite", async () => {
  let drained = 0;
  const collector = createBridgeDeltaEventCollector("opencode");
  const transport: BridgeConformanceTransport = {
    send: (line) => handleLine(line),
    takeMessages: () => {
      const fresh = output.messages.slice(drained);
      drained = output.messages.length;
      return fresh.flatMap((message) =>
        toConformanceMessages(message, collector),
      );
    },
  };

  const report = await runBridgeConformance({
    transport,
    session: {
      cwd: "/tmp",
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
    },
    timeoutMs: 8_000,
  });

  output.restore();
  console.info(`opencode bridge conformance:\n${formatConformanceReport(report)}`);

  expect(report.passed).toBe(true);
}, 30_000);
