import { unwrapPermissionAsk } from "./permissions/map.js";

export const USER_QUESTION_MAX_QUESTIONS = 4;
export const USER_QUESTION_MAX_OPTIONS = 4;

export interface OpenCodeQuestionOption {
  label: string;
  description?: string;
}

export interface OpenCodeQuestionInfo {
  question: string;
  header?: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface OpenCodeQuestionAsk {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestionInfo[];
  tool?: { messageID?: string; callID?: string };
}

export interface BbUserQuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface BbUserQuestion {
  id: string;
  prompt: string;
  shortLabel?: string;
  multiSelect: boolean;
  allowFreeText: boolean;
  options?: BbUserQuestionOption[];
}

export interface BbUserQuestionPayload {
  kind: "user_question";
  questions: BbUserQuestion[];
}

export function isQuestionAskEvent(type: string): boolean {
  return type === "question.asked" || type === "question.v2.asked";
}

export function isQuestionToolName(name: string | undefined): boolean {
  return name === "question" || name === "Question";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseOption(raw: unknown): OpenCodeQuestionOption | undefined {
  const record = asRecord(raw);
  if (!record || typeof record.label !== "string" || !record.label.trim()) {
    return undefined;
  }
  return {
    label: record.label,
    description:
      typeof record.description === "string" ? record.description : undefined,
  };
}

function parseQuestion(raw: unknown): OpenCodeQuestionInfo | undefined {
  const record = asRecord(raw);
  if (!record || typeof record.question !== "string" || !record.question.trim()) {
    return undefined;
  }
  const options = Array.isArray(record.options)
    ? record.options.flatMap((option) => {
        const parsed = parseOption(option);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    question: record.question,
    header: typeof record.header === "string" ? record.header : undefined,
    options,
    multiple: record.multiple === true,
    custom: record.custom === true,
  };
}

export function unwrapQuestionAsk(raw: unknown): OpenCodeQuestionAsk | undefined {
  const unwrapped = unwrapPermissionAsk(raw);
  const record = asRecord(unwrapped);
  if (!record) return undefined;
  const id = typeof record.id === "string" ? record.id : undefined;
  const sessionID =
    typeof record.sessionID === "string" ? record.sessionID : undefined;
  if (!id || !sessionID || !Array.isArray(record.questions)) return undefined;
  const questions = record.questions.flatMap((question) => {
    const parsed = parseQuestion(question);
    return parsed ? [parsed] : [];
  });
  if (questions.length === 0) return undefined;
  const rawTool = asRecord(record.tool);
  const tool = rawTool
    ? {
        messageID:
          typeof rawTool.messageID === "string" ? rawTool.messageID : undefined,
        callID: typeof rawTool.callID === "string" ? rawTool.callID : undefined,
      }
    : undefined;
  return { id, sessionID, questions, ...(tool ? { tool } : {}) };
}

export function toUserQuestionPayload(
  ask: OpenCodeQuestionAsk,
): BbUserQuestionPayload | undefined {
  const sliced = ask.questions.slice(0, USER_QUESTION_MAX_QUESTIONS);
  if (sliced.length === 0) return undefined;
  return {
    kind: "user_question",
    questions: sliced.map((question, index) => {
      const options = question.options
        .slice(0, USER_QUESTION_MAX_OPTIONS)
        .map((option) => ({
          value: option.label,
          label: option.label,
          description: option.description || option.label,
        }));
      return {
        id: `${ask.id}:q${index + 1}`,
        prompt: question.question,
        ...(question.header ? { shortLabel: question.header } : {}),
        multiSelect: question.multiple === true,
        allowFreeText: question.custom === true || options.length === 0,
        ...(options.length > 0 ? { options } : {}),
      };
    }),
  };
}

export function answersForOpenCode(
  payload: BbUserQuestionPayload,
  resolution: {
    answers?: Record<string, { selected?: string[]; freeText?: string }>;
  },
): string[][] {
  const answers = resolution.answers ?? {};
  return payload.questions.map((question) => {
    const answer = answers[question.id];
    if (!answer) return [];
    const selected = Array.isArray(answer.selected) ? [...answer.selected] : [];
    if (typeof answer.freeText === "string" && answer.freeText.trim()) {
      selected.push(answer.freeText.trim());
    }
    return selected;
  });
}
