import { z } from "zod";

/** Any JSON-serializable value. */
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

/** A JSON object (used for JSON Schema documents and structured payloads). */
export const jsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof jsonObjectSchema>;

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/** A request from the model to run a tool. `id` is unique within the conversation. */
export const toolCallBlockSchema = z.object({
  type: z.literal("tool_call"),
  id: z.string().min(1),
  name: z.string(),
  /** Already-parsed arguments. Not yet validated against the tool's input schema. */
  args: jsonValueSchema,
});

/** The answer to a `tool_call`. Lives in a `user` message. */
export const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  /** The `id` of the `tool_call` this answers. */
  callId: z.string().min(1),
  content: z.string(),
  isError: z.exactOptional(z.boolean()),
  /**
   * Tools this result loads into the model's context (client-side tool search): names of tools
   * sent with `deferLoading`. Adapters of providers without that feature ignore it.
   */
  toolReferences: z.exactOptional(z.array(z.string())),
});

/**
 * Opaque content produced by one provider (e.g. reasoning blocks) that must be echoed back
 * unchanged to that same provider on later turns. Adapters for other providers drop it.
 */
export const providerDataBlockSchema = z.object({
  type: z.literal("provider_data"),
  provider: z.string().min(1),
  data: jsonValueSchema,
});

export const blockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  toolCallBlockSchema,
  toolResultBlockSchema,
  providerDataBlockSchema,
]);

export type TextBlock = z.infer<typeof textBlockSchema>;
export type ToolCallBlock = z.infer<typeof toolCallBlockSchema>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;
export type ProviderDataBlock = z.infer<typeof providerDataBlockSchema>;
export type Block = z.infer<typeof blockSchema>;

export const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  blocks: z.array(blockSchema),
});

/**
 * One turn of the conversation. Convention: `tool_result` blocks live in a `user` message,
 * `tool_call` blocks in an `assistant` message.
 */
export type Message = z.infer<typeof messageSchema>;

/**
 * Checks the tool-call pairing invariant that every provider API relies on:
 *
 * - every `tool_call` in an assistant message is answered by exactly one `tool_result` with the
 *   same id, in the immediately following user message;
 * - there are no orphan results (a result whose call is not in the immediately preceding
 *   assistant message);
 * - `tool_call` blocks only appear in assistant messages, `tool_result` blocks only in user
 *   messages, and call ids are not repeated within a message.
 *
 * Returns a list of human-readable problems. An empty list means the conversation is valid.
 * A trailing assistant message with unanswered calls is reported as a problem: validate
 * after the results have been appended.
 */
export function validateConversation(messages: readonly Message[]): string[] {
  const problems: string[] = [];

  messages.forEach((message, index) => {
    const where = `messages[${index}] (${message.role})`;
    const calls = message.blocks.filter((b) => b.type === "tool_call");
    const results = message.blocks.filter((b) => b.type === "tool_result");

    if (message.role === "user" && calls.length > 0) {
      problems.push(`${where}: tool_call blocks are only allowed in assistant messages`);
    }
    if (message.role === "assistant" && results.length > 0) {
      problems.push(`${where}: tool_result blocks are only allowed in user messages`);
    }

    if (message.role === "assistant") {
      const callIds = new Set<string>();
      for (const call of calls) {
        if (callIds.has(call.id)) problems.push(`${where}: duplicate tool_call id "${call.id}"`);
        callIds.add(call.id);
      }
      if (callIds.size === 0) return;

      const next = messages[index + 1];
      if (next === undefined || next.role !== "user") {
        const reason =
          next === undefined ? "no message follows" : "next message is not a user message";
        for (const id of callIds) {
          problems.push(`${where}: tool_call "${id}" has no tool_result (${reason})`);
        }
        return;
      }
      const answered = new Set(
        next.blocks.filter((b) => b.type === "tool_result").map((b) => b.callId),
      );
      for (const id of callIds) {
        if (!answered.has(id)) {
          problems.push(`${where}: tool_call "${id}" has no tool_result in messages[${index + 1}]`);
        }
      }
    } else {
      const previous = messages[index - 1];
      const expected = new Set(
        previous?.role === "assistant"
          ? previous.blocks.filter((b) => b.type === "tool_call").map((b) => b.id)
          : [],
      );
      const seen = new Set<string>();
      for (const result of results) {
        if (!expected.has(result.callId)) {
          problems.push(
            `${where}: orphan tool_result "${result.callId}" (no matching tool_call in the preceding assistant message)`,
          );
        } else if (seen.has(result.callId)) {
          problems.push(`${where}: duplicate tool_result for "${result.callId}"`);
        }
        seen.add(result.callId);
      }
    }
  });

  return problems;
}
