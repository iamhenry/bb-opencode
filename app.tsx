import { definePluginApp } from "@get-bb/plugin-sdk/app";
import {
  CompactComposerAgentPicker,
  ComposerAgentPicker,
} from "./src/app/composer-agent.js";
import { OpenCodeProviderIcon } from "./src/app/provider-icon.js";
import { mountRunChips } from "./src/app/run-chip.js";
import { SettingsSection } from "./src/app/settings-section.js";
import { PROVIDER_ID } from "./src/identity.js";
import "./src/app/composer-agent.css";
import "./src/app/run-chip.css";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "opencode-run-chip",
    mount({ pluginId, signal }) {
      return mountRunChips({ pluginId, signal });
    },
  });
  app.slots.experimental_providerIcon({
    providerId: PROVIDER_ID,
    icon: OpenCodeProviderIcon,
  });
  app.composer.customize({
    id: "opencode-agent",
    scopes: ["thread", "queued-message", "new-thread"],
    actions: [{ id: "agent", component: ComposerAgentPicker }],
    banners: [
      {
        id: "agent-compact",
        chrome: "bare",
        component: CompactComposerAgentPicker,
      },
    ],
  });
  app.slots.settingsSection({
    id: "opencode",
    title: "OpenCode",
    description: "Detached OpenCode server used by BB threads.",
    component: SettingsSection,
  });
});
