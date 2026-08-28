import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract.js";
import { ImportControl } from "./import-control.js";
import "./settings.css";

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
  serveCwd: string | null;
  configSummary: string | null;
  serveLog: string[];
};

export function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [probe, setProbe] = useState<Probe | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("probe", null).then((result) => {
      if (!cancelled) setProbe(result);
    });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  async function reload() {
    setReloading(true);
    setReloadMessage(null);
    try {
      const result = await rpc.call("reload", {});
      setProbe(await rpc.call("probe", null));
      setReloadMessage(result.ok ? "Reloaded." : (result.error ?? "Reload failed"));
    } catch (error) {
      setReloadMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setReloading(false);
    }
  }

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
          <dt>Serve cwd</dt>
          <dd>{probe.serveCwd ?? "-"}</dd>
          {probe.configSummary ? (
            <>
              <dt>Config</dt>
              <dd>{probe.configSummary}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p>Probing OpenCode…</p>
      )}
      {probe?.authError ? <p>Auth: {probe.authError}</p> : null}
      {probe?.error ? <p>{probe.error}</p> : null}
      <div className="oc-settings__actions">
        <button
          type="button"
          className="oc-settings__btn"
          disabled={reloading}
          onClick={() => void reload()}
        >
          {reloading ? "Reloading…" : "Reload OpenCode"}
        </button>
      </div>
      {reloadMessage ? (
        <p className="oc-settings__msg" data-ok={reloadMessage === "Reloaded."}>
          {reloadMessage}
        </p>
      ) : null}
      <ImportControl />
    </section>
  );
}
