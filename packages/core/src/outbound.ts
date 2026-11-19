// Owns what it means for a tool call to be an OUTBOUND MESSAGE: something that goes to another
// person (an e-mail and the like). It is a declaration, never a guess: a tool says it (`Tool.outbound`),
// or, for a connector tool, the USER says it in the connector's settings. Nothing infers it from a
// tool's name, its description or its text. The approval request records it, and only a request that
// carries it gets the message card (with its menu about the recipient).
import { z } from "zod";

export const MAX_RECIPIENT_FIELDS = 8;

/** A dotted path into the tool's arguments that holds a recipient (`to`, `cc`, `message.to`). */
export const recipientFieldSchema = z.string().min(1).max(200);

export const outboundMessageSchema = z.strictObject({
  kind: z.literal("message"),
  /** Where the recipients are in the arguments: the fields a "allow this recipient" rule is about. */
  recipientFields: z.array(recipientFieldSchema).min(1).max(MAX_RECIPIENT_FIELDS),
});
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;

/** `kind: "message"` with the given recipient fields. */
export function outboundMessage(...recipientFields: string[]): OutboundMessage {
  return outboundMessageSchema.parse({ kind: "message", recipientFields });
}
