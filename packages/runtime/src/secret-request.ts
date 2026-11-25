// Owns answering a bot's `request_secret`: the user's value goes straight to the vault (never
// through the model, the event log or the chat), the bot is granted the secret, and the run gets
// the only thing the model may know: that the secret is now available (or that the user declined).
// A name that is a PLUGIN's credential (a connector's token, a search engine's key) is the exception:
// it is kept by the plugin, never granted, and the model is told the plugin keeps it.
import { checkSecretHosts, getRun, listRunEvents, postInbox } from "@suup/db";
import { RuntimeError } from "./errors.js";
import type { Runtime } from "./runtime.js";

export interface PendingSecretRequest {
  runId: string;
  botId: string;
  callId: string;
  name: string;
  reason: string | null;
  /** The sites the bot SUGGESTED. Only the ones the user confirms in the form are kept. */
  hosts: string[];
}

/** The secret the run is waiting for, or `null` when it waits for something else (or nothing). */
export async function pendingSecretRequest(
  runtime: Runtime,
  runId: string,
): Promise<PendingSecretRequest | null> {
  const run = await getRun(runtime.db, runId);
  if (run === null || run.status !== "waiting_user") return null;
  const events = await listRunEvents(runtime.db, runId, {
    types: ["secret_requested", "escalated", "tool_result"],
    limit: 10_000,
  });
  let open: PendingSecretRequest | null = null;
  for (const event of events) {
    const p = event.payload as {
      callId?: string;
      name?: string;
      reason?: string;
      hosts?: string[];
    };
    if (event.type === "secret_requested" && p.callId !== undefined && p.name !== undefined) {
      open = {
        runId,
        botId: run.botId,
        callId: p.callId,
        name: p.name,
        reason: p.reason ?? null,
        hosts: p.hosts ?? [],
      };
    } else if (event.type === "escalated") {
      open = null;
    } else if (event.type === "tool_result" && open !== null && p.callId === open.callId) {
      open = null;
    }
  }
  return open;
}

export interface SecretAnswer {
  /** The value, typed by the user into the secure form. Absent when the user declines. */
  value?: string | undefined;
  declined?: boolean | undefined;
  description?: string | undefined;
  /** The sites the user confirmed in the form: the only ones the vault keeps (never the bot's suggestion). */
  hosts?: readonly string[] | undefined;
}

/**
 * Answers the pending request of a run. The value is written to the vault and granted to the
 * run's bot; the run's inbox gets a message that holds no value, which becomes the result of the
 * `request_secret` call. Throws `RuntimeError` `conflict` when the run is not waiting for a secret.
 */
export async function answerSecretRequest(
  runtime: Runtime,
  runId: string,
  answer: SecretAnswer,
): Promise<{ name: string; provided: boolean }> {
  const request = await pendingSecretRequest(runtime, runId);
  if (request === null) {
    throw new RuntimeError("conflict", "A execução não está esperando um segredo.");
  }
  if (answer.declined === true || answer.value === undefined) {
    await postInbox(runtime.db, runId, {
      kind: "user_message",
      text: `The user declined to provide the secret ${request.name}.`,
    });
    return { name: request.name, provided: false };
  }
  if (await runtime.pluginCredentials.setByName(request.name, answer.value)) {
    // Exact name of a plugin's credential: kept with the plugin, never an owner's secret, never
    // granted to the bot. Suup uses it; the bot does not.
    await postInbox(runtime.db, runId, {
      kind: "user_message",
      text: `The credential ${request.name} was stored by the plugin that uses it. It is not a secret you can use: Suup uses it for you when you call that plugin, so do not reference {{secret:${request.name}}}.`,
    });
    return { name: request.name, provided: true };
  }
  // The sites come from the USER's form, never from what the bot suggested. An owner's secret
  // without one would be blocked at once, so the form must have at least one.
  const confirmed = answer.hosts === undefined ? [] : checkSecretHosts(answer.hosts);
  if (confirmed.length === 0) {
    throw new RuntimeError(
      "invalid_input",
      "Diga para quais endereços o segredo pode ir (por exemplo api.exemplo.com): sem isso ele ficaria bloqueado.",
    );
  }
  await runtime.vault.set(request.name, answer.value, {
    ...(answer.description === undefined ? {} : { description: answer.description }),
    hosts: confirmed,
  });
  await runtime.vault.grant(request.name, request.botId);
  await postInbox(runtime.db, runId, {
    kind: "user_message",
    text: `The secret ${request.name} is now available. Use it as {{secret:${request.name}}} in a web_fetch header or address, and only for ${confirmed.join(", ")} (the sites the user confirmed): a call to any other site is refused, whatever the user approves.`,
  });
  return { name: request.name, provided: true };
}
