import { describe, expect, it } from "vitest";
import {
  answersForOpenCode,
  isQuestionAskEvent,
  toUserQuestionPayload,
  unwrapQuestionAsk,
} from "../src/questions.js";

describe("questions", () => {
  it("unwraps question.v2.asked envelopes", () => {
    expect(isQuestionAskEvent("question.v2.asked")).toBe(true);
    expect(
      unwrapQuestionAsk({
        data: {
          id: "que_1",
          sessionID: "ses_1",
          tool: { messageID: "msg_1", callID: "call_1" },
          questions: [
            {
              question: "Is the plugin done?",
              header: "Done?",
              options: [
                { label: "Yes", description: "Ship it" },
                { label: "No", description: "Keep going" },
              ],
              multiple: false,
              custom: false,
            },
          ],
        },
      }),
    ).toMatchObject({
      id: "que_1",
      sessionID: "ses_1",
      tool: { messageID: "msg_1", callID: "call_1" },
    });
  });

  it("maps OpenCode questions onto the native BB card payload", () => {
    const payload = toUserQuestionPayload({
      id: "que_1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Is the plugin done?",
          header: "Done?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    });
    expect(payload).toEqual({
      kind: "user_question",
      questions: [
        {
          id: "que_1:q1",
          prompt: "Is the plugin done?",
          shortLabel: "Done?",
          multiSelect: false,
          allowFreeText: false,
          options: [
            { value: "Yes", label: "Yes", description: "Yes" },
            { value: "No", label: "No", description: "No" },
          ],
        },
      ],
    });
    expect(
      answersForOpenCode(payload!, {
        answers: { "que_1:q1": { selected: ["Yes"] } },
      }),
    ).toEqual([["Yes"]]);
  });
});
