import { definePluginApp } from "@get-bb/plugin-sdk/app";
import {
  CompactComposerAgentPicker,
  ComposerAgentPicker,
} from "./src/app/composer-agent.js";
import { ComposerSlashSuggest } from "./src/app/composer-command.js";
import { TaskChildrenHeaderAction } from "./src/app/header-actions.js";
import { OpenCodeProviderIcon } from "./src/app/provider-icon.js";
import { SettingsSection } from "./src/app/settings-section.js";
import { PROVIDER_ID } from "./src/identity.js";
import "./src/app/composer-agent.css";

export default definePluginApp((app) => {
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
      { id: "slash", chrome: "bare", component: ComposerSlashSuggest },
    ],
  });
  app.slots.experimental_threadHeaderAction({
    id: "opencode-open-task",
    title: "OpenCode Task children",
    component: TaskChildrenHeaderAction,
  });
  app.slots.settingsSection({
    id: "opencode",
    title: "OpenCode",
    description: "Detached OpenCode server used by BB threads.",
    component: SettingsSection,
  });
});
