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

type UpdateStatus = {
  diskVersion: string | null;
  runningVersion: string | null;
  latestVersion: string | null;
  current: boolean;
  canRestart: boolean;
  error: string | null;
};

type DefaultAgent = {
  agent: string;
  options: string[];
  error: string | null;
};

export function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [probe, setProbe] = useState<Probe | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [defaultAgent, setDefaultAgent] = useState<DefaultAgent | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("probe", null).then((result) => {
      if (!cancelled) setProbe(result);
    });
    void rpc.call("updateStatus", {}).then((result) => {
      if (!cancelled) setUpdate(result);
    });
    void rpc.call("defaultAgent", null).then((result) => {
      if (!cancelled) setDefaultAgent(result);
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
      setUpdate(await rpc.call("updateStatus", {}));
      setReloadMessage(result.ok ? "Reloaded." : (result.error ?? "Reload failed"));
    } catch (error) {
      setReloadMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setReloading(false);
    }
  }

  async function saveDefaultAgent(agent: string) {
    setSavingAgent(true);
    setAgentMessage(null);
    try {
      const saved = await rpc.call("setDefaultAgent", { agent });
      setDefaultAgent((current) =>
        current ? { ...current, agent: saved.agent } : current,
      );
      setAgentMessage("Saved.");
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingAgent(false);
    }
  }

  return (
    <section data-opencode-settings="true">
      <div className="oc-settings__group">
        <label className="oc-settings__field">
          <span>Default OpenCode agent</span>
          <select
            aria-label="Default OpenCode agent"
            value={defaultAgent?.agent ?? ""}
            disabled={!defaultAgent?.options.length || savingAgent}
            onChange={(event) => void saveDefaultAgent(event.target.value)}
          >
            {defaultAgent && !defaultAgent.options.includes(defaultAgent.agent) ? (
              <option value={defaultAgent.agent}>{defaultAgent.agent}</option>
            ) : null}
            {(defaultAgent?.options ?? []).map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
        </label>
        <div className="oc-settings__lane">
          <span>OpenCode version</span>
          <span className="oc-settings__value">
            {probe?.serverVersion ?? update?.diskVersion ?? "—"}
          </span>
        </div>
        <div className="oc-settings__actions">
          <span>OpenCode server</span>
          <button
            type="button"
            className="oc-settings__btn"
            disabled={reloading}
            onClick={() => void reload()}
          >
            {reloading ? "Reloading…" : "Reload OpenCode"}
          </button>
        </div>
        <ImportControl />
      </div>
      {defaultAgent?.error ? (
        <p className="oc-settings__msg" data-ok="false">
          {defaultAgent.error}
        </p>
      ) : null}
      {agentMessage ? (
        <p className="oc-settings__msg" data-ok={agentMessage === "Saved."}>
          {agentMessage}
        </p>
      ) : null}
      {probe?.authError ? <p>Auth: {probe.authError}</p> : null}
      {probe?.error ? <p>{probe.error}</p> : null}
      {reloadMessage ? (
        <p
          className="oc-settings__msg"
          data-ok={reloadMessage === "Reloaded."}
        >
          {reloadMessage}
        </p>
      ) : null}
    </section>
  );
}
