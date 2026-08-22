import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ComposerAgentPicker } from "./src/app/composer-agent.js";
import { ComposerSlashSuggest } from "./src/app/composer-command.js";
import { runMessageRedo, runMessageUndo } from "./src/app/message-revert.js";
import { SettingsSection } from "./src/app/settings-section.js";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "opencode-agent",
    scopes: ["thread", "queued-message", "new-thread"],
    actions: [{ id: "agent", component: ComposerAgentPicker }],
    banners: [
      { id: "slash", chrome: "bare", component: ComposerSlashSuggest },
    ],
  });
  app.slots.messageAction({
    id: "undo",
    title: "Undo",
    icon: "Undo2",
    run: ({ threadId, message }) =>
      runMessageUndo({
        threadId,
        role: message.role,
        text: message.text,
      }),
  });
  app.slots.messageAction({
    id: "redo",
    title: "Redo",
    icon: "Redo2",
    run: ({ threadId }) => runMessageRedo({ threadId }),
  });
  app.slots.settingsSection({
    id: "opencode",
    title: "OpenCode",
    description: "Detached OpenCode server used by BB threads.",
    component: SettingsSection,
  });
});
