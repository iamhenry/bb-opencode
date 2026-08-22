import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ComposerAgentPicker } from "./src/app/composer-agent.js";
import { HeaderRevert } from "./src/app/header-revert.js";
import { SettingsSection } from "./src/app/settings-section.js";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "opencode-agent",
    scopes: ["thread", "queued-message", "new-thread"],
    actions: [{ id: "agent", component: ComposerAgentPicker }],
  });
  app.slots.experimental_threadHeaderAction({
    id: "opencode-revert",
    title: "OpenCode revert",
    component: HeaderRevert,
  });
  app.slots.settingsSection({
    id: "opencode",
    title: "OpenCode",
    description: "Detached OpenCode server used by BB threads.",
    component: SettingsSection,
  });
});
