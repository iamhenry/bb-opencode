import { definePluginApp } from "@get-bb/plugin-sdk/app";
import {
  CompactComposerAgentPicker,
  ComposerAgentPicker,
} from "./src/app/composer-agent.js";
import { OpenCodeProviderIcon } from "./src/app/provider-icon.js";
import { RevertDock } from "./src/app/revert-dock.js";
import { runMessageUndo } from "./src/app/message-revert.js";
import { mountRevertTimeline } from "./src/app/revert-timeline.js";
import { mountPermissionModeWatch } from "./src/app/permission-mode-watch.js";
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
  app.contentScripts.register({
    id: "opencode-revert-timeline",
    mount({ pluginId, signal }) {
      return mountRevertTimeline({ pluginId, signal });
    },
  });
  app.contentScripts.register({
    id: "opencode-permission-mode",
    mount({ signal }) {
      return mountPermissionModeWatch({ signal });
    },
  });
  app.slots.experimental_providerIcon({
    providerId: PROVIDER_ID,
    icon: OpenCodeProviderIcon,
  });
  app.slots.messageAction({
    id: "opencode-revert",
    title: "Revert from here",
    icon: "Undo2",
    async run({ threadId, message }) {
      await runMessageUndo({
        threadId,
        messageId: message.id,
        role: message.role,
        text: message.text,
      });
    },
  });
  app.composer.customize({
    id: "opencode-revert-dock",
    scopes: ["thread"],
    banners: [{ id: "revert-dock", chrome: "bare", component: RevertDock }],
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
    description: "Runs your threads with OpenCode. Restart it here after config changes.",
    component: SettingsSection,
  });
});
