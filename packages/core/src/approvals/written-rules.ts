// Owns the rules the user WRITES in plain language ("Permitir sem perguntar: e-mails para minha
// equipe em acme.com") and the approval mode. The text is free prose for the model reviewer to
// read: nothing here parses it, matches it or looks inside it. A written rule is created only by
// an explicit act of the user (API, CLI, app), never by the model.
import { z } from "zod";

/**
 * What a written rule asks for: `never` the call is refused (the model tells the bot, the user is
 * not asked), `ask` the user must confirm, `allow` it may run without asking.
 */
export const WRITTEN_RULE_KINDS = ["never", "ask", "allow"] as const;
export type WrittenRuleKind = (typeof WRITTEN_RULE_KINDS)[number];
export const writtenRuleKindSchema = z.enum(WRITTEN_RULE_KINDS);

export const MAX_WRITTEN_RULE_CHARS = 500;
/** How many written rules may exist, so that the review prompt stays small. */
export const MAX_WRITTEN_RULES = 100;

/** The text of a rule as the user typed it, trimmed. Free prose: no format is checked. */
export const writtenRuleTextSchema = z
  .string()
  .transform((text) => text.trim())
  .pipe(z.string().min(1).max(MAX_WRITTEN_RULE_CHARS));

/** A rule the model reviewer reads. `botId: null` applies to every bot. */
export interface WrittenRule {
  id: string;
  kind: WrittenRuleKind;
  text: string;
  botId: string | null;
}

/** Where the written rules come from (the database, in the runtime). */
export interface WrittenRuleSource {
  /** The ENABLED rules that apply to this bot: its own and the ones for every bot. */
  writtenRulesFor(botId: string): Promise<WrittenRule[]>;
}

/**
 * `auto_review`: a model reads the user's written rules and decides each call that is not a plain
 * read. `ask_all`: every call that is not a plain read asks with a card.
 */
export const APPROVAL_MODES = ["auto_review", "ask_all"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const approvalModeSchema = z.enum(APPROVAL_MODES);
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto_review";

/** Where the mode comes from (read at every call, so a change applies at once). */
export interface ApprovalModeSource {
  approvalMode(): Promise<ApprovalMode>;
}
