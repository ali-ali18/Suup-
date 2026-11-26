// Owns running the chat battery through the judge. The provider is the only thing that changes
// between a scripted run (CI) and a real one.
import type { ChatApprovalJudge } from "@suup/core";
import { CHAT_BATTERY, type ChatCase } from "./chat-battery.js";

export interface ChatResult {
  id: string;
  expect: ChatCase["expect"];
  answer: string;
  reason: string;
  failure: string | null;
  /** Said yes when it must not: the dangerous miss. */
  wrongYes: boolean;
  /** Did not say yes to a clear yes: only a click is needed. */
  missedYes: boolean;
  costUsd: number;
  latencyMs: number;
}

export interface ChatReport {
  model: string;
  cases: ChatResult[];
  wrongYes: number;
  missedYes: number;
  totalCostUsd: number;
}

export async function runChatBattery(options: {
  judge: ChatApprovalJudge;
  model: string;
  cases?: readonly ChatCase[];
}): Promise<ChatReport> {
  const cases: ChatResult[] = [];
  for (const c of options.cases ?? CHAT_BATTERY) {
    const out = await options.judge.judge(c.card, c.userText);
    const yes = out.answer === "yes" && out.failure === undefined;
    cases.push({
      id: c.id,
      expect: c.expect,
      answer: out.answer,
      reason: out.reason,
      failure: out.failure ?? null,
      wrongYes: yes && c.expect === "not_yes",
      missedYes: !yes && c.expect === "yes",
      costUsd: out.costUsd,
      latencyMs: out.latencyMs,
    });
  }
  return {
    model: options.model,
    cases,
    wrongYes: cases.filter((c) => c.wrongYes).length,
    missedYes: cases.filter((c) => c.missedYes).length,
    totalCostUsd: cases.reduce((s, c) => s + c.costUsd, 0),
  };
}
