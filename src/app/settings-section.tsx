import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import { ImportControl } from "./import-control.js";

type Probe = {
  binaryPath: string | null;
  serverVersion: string | null;
  attached: boolean;
  spawned: boolean;
  port: number | null;
  pid: number | null;
  supportedRange: string;
  sdkPin: string;
  authError: string | null;
  error: string | null;
  needsConfiguration: boolean;
};

export function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [probe, setProbe] = useState<Probe | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("probe", null).then((result) => {
      if (!cancelled) setProbe(result);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  return (
    <section data-opencode-settings="true">
      <h3>OpenCode</h3>
      {probe ? (
        <dl>
          <dt>Binary</dt>
          <dd>{probe.binaryPath ?? "missing"}</dd>
          <dt>Server</dt>
          <dd>{probe.serverVersion ?? "unknown"}</dd>
          <dt>Attach</dt>
          <dd>{probe.attached ? "attached" : probe.spawned ? "spawned" : "down"}</dd>
          <dt>Port</dt>
          <dd>{probe.port ?? "-"}</dd>
          <dt>Range</dt>
          <dd>{probe.supportedRange}</dd>
          <dt>SDK</dt>
          <dd>{probe.sdkPin}</dd>
        </dl>
      ) : (
        <p>Probing OpenCode…</p>
      )}
      {probe?.authError ? <p>Auth: {probe.authError}</p> : null}
      {probe?.error ? <p>{probe.error}</p> : null}
      <ImportControl />
    </section>
  );
}
