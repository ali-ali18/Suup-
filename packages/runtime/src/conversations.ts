// The conversation engine: the one entry point the server will call (and the CLI calls today).
// Plain async functions over the runtime object; no HTTP here.
import { generateAndCollect, type ToolChoice, type ToolSpec } from "@suup/core";
import {
  type Bot,
  ConversationNotFoundError,
  ConversationSendError,
  type ConversationView,
  createBot,
  createDirectConversation,
  getBot,
  getConversation,
  getRoutine,
  listBots,
  type Message,
  type Run,
  sendConversationMessage,
  setDefaultBot,
} from "@suup/db";
import { z } from "zod";
import { RuntimeError } from "./errors.js";
import type { Runtime } from "./runtime.js";

export interface SendMessageInput {
  /** The conversation to write in. Give this or `botId`. */
  conversationId?: string;
  /** The bot to talk to: its direct conversation is found or created. */
  botId?: string;
  text: string;
  /**
   * The routine the message is about (the app's "Editar"): stored on the message as data, never in
   * its text, and told to the model so the bot changes the right one. It must be a routine of the
   * conversation's bot.
   */
  routineRef?: string;
}

export interface SendMessageResult {
  /** The user message as stored. */
  message: Message;
  /** The run that holds it: the one it opened, or the one that was already active. */
  run: Run;
  /** Set when the message went to a run that was already active (`message.status` is `sent`). */
  queuedForRun?: true;
}

/**
 * Sends the user's message to a conversation (see `sendConversationMessage` in `@suup/db` for the
 * rules, which are enforced atomically in the database):
 *
 * - no active run: the message opens a run (`origin: "user"`, objective = the text, no criteria),
 *   queued for a worker;
 * - a run `queued`/`running`: the message is posted to its inbox, `sent` until the loop reads it
 *   at a safe point (then `delivered`);
 * - a run `waiting_user`: the message is the answer, and the run is requeued;
 * - a run `waiting_approval`: the message is stored and posted, but approves nothing.
 *
 * Throws `RuntimeError` (Portuguese message) for an empty text, an unknown conversation or bot, an
 * archived bot, a group conversation (not supported yet), or a bot whose model the configuration
 * lacks.
 */
export async function sendMessage(
  runtime: Runtime,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const text = input.text.trim();
  if (text === "") throw new RuntimeError("empty_message", "A mensagem está vazia.");
  if ((input.conversationId === undefined) === (input.botId === undefined)) {
    throw new TypeError("sendMessage: give exactly one of conversationId and botId");
  }
  const db = runtime.db;

  let conversation: ConversationView;
  let bot: Bot | null;
  if (input.botId !== undefined) {
    bot = await getBot(db, input.botId);
    if (bot === null) throw new RuntimeError("bot_not_found", `Bot ${input.botId} não encontrado.`);
    assertUsable(bot);
    runtime.botConfig(bot); // refuses a bot whose model or provider the configuration lacks
    conversation = await createDirectConversation(db, bot.id);
  } else {
    const found = await getConversation(db, input.conversationId as string);
    if (found === null) {
      throw new RuntimeError(
        "conversation_not_found",
        `Conversa ${input.conversationId} não encontrada.`,
      );
    }
    conversation = found;
    const member = conversation.members[0];
    if (conversation.kind !== "direct" || member === undefined) {
      throw new RuntimeError(
        "conversation_unsupported",
        "Por enquanto só conversas diretas com um bot recebem mensagens; salas de grupo chegam numa fase futura.",
      );
    }
    bot = await getBot(db, member.botId);
    if (bot === null)
      throw new RuntimeError("bot_not_found", `Bot ${member.botId} não encontrado.`);
    assertUsable(bot);
    runtime.botConfig(bot);
  }

  if (input.routineRef !== undefined) {
    const routine = await getRoutine(db, input.routineRef);
    if (routine === null || routine.botId !== bot.id) {
      throw new RuntimeError(
        "invalid_input",
        "routineRef: essa rotina não existe ou não é do bot desta conversa.",
      );
    }
  }

  try {
    const sent = await sendConversationMessage(db, {
      conversationId: conversation.id,
      text,
      ...(input.routineRef === undefined ? {} : { routineRef: input.routineRef }),
    });
    return {
      message: sent.message,
      run: sent.run,
      ...(sent.queuedForRun ? { queuedForRun: true as const } : {}),
    };
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      throw new RuntimeError(
        "conversation_not_found",
        `Conversa ${conversation.id} não encontrada.`,
      );
    }
    if (error instanceof ConversationSendError) {
      throw new RuntimeError(
        "conversation_unsupported",
        /archived/i.test(error.message)
          ? "Esta conversa (ou o bot dela) está arquivada e não recebe mensagens."
          : "Esta conversa não pode receber mensagens agora.",
        { cause: error },
      );
    }
    throw error;
  }
}

function assertUsable(bot: Bot): void {
  if (bot.archivedAt !== null) {
    throw new RuntimeError(
      "bot_archived",
      `O bot "${bot.name}" (${bot.id}) está arquivado: não recebe mensagens.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The first bot

/** Name, description and personality of the bot created at first start (shown to the user). */
export const DEFAULT_BOT_NAME = "Principal";
export const DEFAULT_BOT_DESCRIPTION =
  "O bot principal: resolve o que você pedir ou diz o que falta para resolver.";
export const DEFAULT_BOT_PERSONALITY = [
  "Você é o assistente principal do usuário, um assistente pessoal de uso geral.",
  "Fale em português do Brasil, de forma clara, direta e cordial, sem enrolar.",
  "Resolva o que for pedido usando suas ferramentas. Se a tarefa tiver vários passos, faça um plano e termine de verdade, conferindo o resultado.",
  "Se faltar algo que só o usuário sabe, pergunte uma coisa de cada vez.",
  "Quando o usuário disser uma regra que vale daqui para frente ou um fato duradouro sobre ele, guarde na memória com a ferramenta remember, sem avisar.",
].join("\n");

export interface EnsureDefaultBotOptions {
  /** The model of the bot created when none exists (an id from `models` in the configuration). */
  modelId: string;
  /** Overrides, for tests and for a first-start screen that asks. */
  name?: string;
  personality?: string;
}

/**
 * Makes sure there is a main bot (a convenience of the terminal chat only: the server does not call
 * it, its main bot is whatever the user turns on with `POST /v1/bots/:id/default`). Returns the default bot when one is marked; if none is marked
 * but there are active bots, the oldest one becomes the default (nothing is created); if there are
 * no active bots, creates "Principal" with every registered tool and marks it default. Idempotent.
 */
export async function ensureDefaultBot(
  runtime: Runtime,
  options: EnsureDefaultBotOptions,
): Promise<{ bot: Bot; created: boolean }> {
  const db = runtime.db;
  const bots = await listBots(db);
  const marked = bots.find((b) => b.isDefault === true);
  if (marked !== undefined) return { bot: marked, created: false };
  const oldest = bots[bots.length - 1]; // listBots is newest first
  if (oldest !== undefined) {
    return { bot: (await setDefaultBot(db, oldest.id)) ?? oldest, created: false };
  }
  const { model, provider } = runtime.resolveModel(options.modelId);
  const bot = await createBot(
    db,
    {
      name: options.name ?? DEFAULT_BOT_NAME,
      description: DEFAULT_BOT_DESCRIPTION,
      personality: options.personality ?? DEFAULT_BOT_PERSONALITY,
      modelProvider: provider.id,
      modelId: model.id,
      allowedTools: runtime.tools.list().map((t) => t.name),
    },
    { makeDefault: true },
  );
  return { bot, created: true };
}

// ---------------------------------------------------------------------------------------------
// Drafting a bot from a description

export const botDraftSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(400),
  personality: z.string().trim().min(20).max(6000),
});
export type BotDraft = z.infer<typeof botDraftSchema>;

/** The tool the draft feature forces the model to call (`draftBot`). */
export const DRAFT_TOOL = "propose_bot";
const DRAFT_MAX_OUTPUT_TOKENS = 2048;

const DRAFT_SYSTEM = `You design assistants ("bots") for a personal-assistant app. The user describes, in Portuguese, the bot they want. You propose its identity by calling the \`${DRAFT_TOOL}\` tool exactly once.

- name: short and easy to say (one or two words, no "Bot" suffix), in the language of the description.
- description: one sentence for a list screen saying what the bot is for.
- personality: instructions written TO the bot, in the second person ("Você é..."), in Brazilian Portuguese: its role, tone, how it should work, what it should ask the user before acting and what it must never do. Concrete and specific to the description, 60 to 200 words. Do not mention tools, memory or technical details: the app adds those.

Base everything on the description; do not invent facts about the user. Always answer with the tool call, nothing else.`;

function draftToolSpec(): ToolSpec {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(
    botDraftSchema.extend({
      name: botDraftSchema.shape.name.describe("Short name of the bot."),
      description: botDraftSchema.shape.description.describe("One sentence: what the bot is for."),
      personality: botDraftSchema.shape.personality.describe(
        "Instructions to the bot, second person, Brazilian Portuguese.",
      ),
    }),
  ) as Record<string, unknown>;
  return {
    name: DRAFT_TOOL,
    description: "Proposes the name, description and personality of the bot.",
    inputSchema: inputSchema as ToolSpec["inputSchema"],
  };
}

/**
 * Proposes `{ name, description, personality }` for a bot from a free-text description (Portuguese)
 * with one model call, through a single tool whose choice is forced when the model allows it
 * (`supportsForcedToolChoice`) and asked for by instruction otherwise; a model that rejects the
 * forced choice with an invalid-request error is asked again without it, like the reviewer. The
 * answer is validated; a malformed one is retried once, with what was wrong. Nothing is created:
 * the caller confirms and calls `createBot`.
 *
 * Throws `RuntimeError("draft_failed")` (Portuguese message) when the model cannot be reached or
 * answers badly twice.
 */
export async function draftBot(
  runtime: Runtime,
  input: { description: string; modelId: string },
): Promise<BotDraft> {
  const description = input.description.trim();
  if (description === "") {
    throw new RuntimeError("draft_failed", "A descrição do bot está vazia.");
  }
  const { model } = runtime.resolveModel(input.modelId);
  const provider = runtime.getProvider(model.provider);
  const tool = draftToolSpec();
  let forced = model.supportsForcedToolChoice !== false;
  const messages: Parameters<typeof generateAndCollect>[1]["messages"] = [
    {
      role: "user",
      blocks: [{ type: "text", text: `Descrição do bot que o usuário quer:\n\n${description}` }],
    },
  ];

  let problem = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const toolChoice: ToolChoice = { name: DRAFT_TOOL };
    const request = (withChoice: boolean) => ({
      model: model.id,
      system: DRAFT_SYSTEM,
      messages,
      tools: [tool],
      ...(withChoice ? { toolChoice } : {}),
      maxOutputTokens: Math.min(model.maxOutputTokens, DRAFT_MAX_OUTPUT_TOKENS),
    });
    let result: Awaited<ReturnType<typeof generateAndCollect>>;
    try {
      try {
        result = await generateAndCollect(provider, request(forced));
      } catch (error) {
        if (forced && (error as { kind?: string }).kind === "invalid_request") {
          forced = false; // the model does not take a forced choice after all
          result = await generateAndCollect(provider, request(false));
        } else {
          throw error;
        }
      }
    } catch (error) {
      throw new RuntimeError(
        "draft_failed",
        `Não foi possível pedir a proposta ao modelo ${model.id}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const call = result.blocks.find((b) => b.type === "tool_call" && b.name === DRAFT_TOOL);
    if (call === undefined || call.type !== "tool_call") {
      problem = "the answer did not call the tool";
    } else {
      const parsed = botDraftSchema.safeParse(call.args);
      if (parsed.success) return parsed.data;
      problem = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    }
    // One more try, saying what was wrong. The malformed answer goes back as the assistant's turn.
    messages.push({
      role: "assistant",
      blocks: result.blocks.filter((b) => b.type === "text" || b.type === "tool_call"),
    });
    const calls = result.blocks.flatMap((b) => (b.type === "tool_call" ? [b] : []));
    messages.push({
      role: "user",
      blocks: [
        ...calls.map((c) => ({
          type: "tool_result" as const,
          callId: c.id,
          content: `Invalid: ${problem}`,
          isError: true,
        })),
        { type: "text", text: `Try again: call ${DRAFT_TOOL} with a valid answer (${problem}).` },
      ],
    });
  }
  throw new RuntimeError(
    "draft_failed",
    `O modelo ${model.id} não devolveu uma proposta válida de bot (${problem}). Tente de novo ou descreva o bot com mais detalhes.`,
  );
}
