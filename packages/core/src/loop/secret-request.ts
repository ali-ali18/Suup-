// Owns `request_secret`: the bot asks the user for a credential. The run pauses like an
// `escalate`; the user answers through the secure form (which writes straight to the vault), and
// the only thing the model ever gets back is that the secret is now available.
import { SECRET_NAME_PATTERN } from "../secrets.js";
import { ROUTINE_NO_QUESTIONS } from "./control-calls.js";
import { renderArgIssues, requestSecretInputSchema } from "./control-tools.js";
import { type ControlCall, ensureToolCall, record, recordResult } from "./recording.js";
import type { LoopContext } from "./run-context.js";

export async function handleRequestSecret(
  ctx: LoopContext,
  call: ControlCall,
  alone: boolean,
): Promise<void> {
  await ensureToolCall(ctx, call);
  const parsed = requestSecretInputSchema.safeParse(call.args);
  if (!parsed.success) {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: renderArgIssues("request_secret", parsed.error),
    });
    return;
  }
  const { name, reason } = parsed.data;
  if (!SECRET_NAME_PATTERN.test(name)) {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: `"${name}" is not a valid secret name: use capital letters, digits and underscores, starting with a letter (e.g. GITHUB_TOKEN).`,
    });
    return;
  }
  if (ctx.deps.secrets === undefined) {
    await recordResult(ctx, call.id, {
      outcome: "tool_error",
      isError: true,
      content:
        "There is no vault in this run, so a secret cannot be requested. Explain that the task is blocked or offer an alternative without collecting the value.",
    });
    return;
  }
  if (ctx.run.origin === "routine") {
    await recordResult(ctx, call.id, {
      outcome: "tool_error",
      isError: true,
      content: ROUTINE_NO_QUESTIONS,
    });
    return;
  }
  if (!alone) {
    await recordResult(ctx, call.id, {
      outcome: "tool_error",
      isError: true,
      content:
        "request_secret must be the only tool call of its turn. Call it alone, after you have seen the results of the other tools.",
    });
    return;
  }
  // No result is recorded: the user's answer will be it. The loop pauses at the next safe point.
  await record(ctx, {
    type: "secret_requested",
    payload: { callId: call.id, name, ...(reason === undefined ? {} : { reason }) },
  });
}
