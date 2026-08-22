import { definePluginApp } from "@get-bb/plugin-sdk/app";
import {
  CompactComposerAgentPicker,
  ComposerAgentPicker,
} from "./src/app/composer-agent.js";
import { ComposerSlashSuggest } from "./src/app/composer-command.js";
import { runMessageFork } from "./src/app/message-fork.js";
import { runMessageRedo, runMessageUndo } from "./src/app/message-revert.js";
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
  app.slots.messageAction({
    id: "revert",
    title: "Revert from here",
    icon: "ArrowTurnBackward",
    run: ({ threadId, message }) =>
      runMessageUndo({
        threadId,
        role: message.role,
        text: message.text,
      }),
  });
  app.slots.messageAction({
    id: "redo",
    title: "Redo revert",
    icon: "RotateCcw",
    run: ({ threadId }) => runMessageRedo({ threadId }),
  });
  app.slots.messageAction({
    id: "fork",
    title: "Fork into new thread",
    icon: "Fork",
    run: ({ threadId, message }) =>
      runMessageFork({
        threadId,
        sourceSeqEnd: message.sourceSeqEnd,
      }),
  });
  app.slots.settingsSection({
    id: "opencode",
    title: "OpenCode",
    description: "Detached OpenCode server used by BB threads.",
    component: SettingsSection,
  });
});
