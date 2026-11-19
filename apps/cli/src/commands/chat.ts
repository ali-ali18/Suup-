import {
  type Bot,
  createDirectConversation,
  getActiveConversationRun,
  getDefaultBot,
  listBots,
  listMessages,
  type Message,
} from "@suup/db";
import { ensureDefaultBot, reconcileRunEffects, sendMessage } from "@suup/runtime";
import { askInline, pendingCards, printCards } from "../approval-prompt.js";
import { str } from "../args.js";
import { type CommandSpec, type Ctx, warnIfLocalSandbox } from "../context.js";
import { CommandError, EXIT_FAILED, EXIT_OK, UsageError } from "../errors.js";
import { followRunCore, LineQueue } from "../follow.js";
import { findBot, readEvents } from "../lookup.js";
import type { RawEvent } from "../render.js";

const NAME = "chat";
const HISTORY_TAIL = 8;
const EXIT_WORDS = new Set(["/sair", "/exit", "/quit"]);

/**
 * The live view of a chat leaves out what the bot's message already says: the model's own text
 * (the final answer arrives as a message), the question of `escalate`, the `finish` call and the
 * conclusion.
 */
function hideOutcome(event: RawEvent): boolean {
  if (event.type === "model_response" || event.type === "escalated") return true;
  if (event.type === "tool_call")
    return event.payload.name === "escalate" || event.payload.name === "finish";
  if (event.type === "status_changed") {
    return event.payload.to === "done" || event.payload.to === "waiting_user";
  }
  return false;
}

function bubble(message: Message, botName: string): string[] {
  const who =
    message.authorKind === "user" ? "Você" : message.authorKind === "bot" ? botName : "Sistema";
  const lines = message.text.trimEnd().split("\n");
  const [first = "", ...rest] = lines;
  const pad = " ".repeat(who.length + 2);
  return [`${who}: ${first}`, ...rest.map((l) => `${pad}${l}`)];
}

function messageJson(message: Message) {
  return {
    type: "message",
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    author: message.authorKind,
    text: message.text,
    runId: message.runId,
    status: message.status,
    createdAt: message.createdAt.toISOString(),
  };
}

async function pickBot(ctx: Ctx, ref: string | undefined): Promise<Bot> {
  const runtime = ctx.runtime();
  if (ref !== undefined) return findBot(runtime.db, ref);
  const marked = await getDefaultBot(runtime.db);
  if (marked !== null) return marked;
  const bots = await listBots(runtime.db);
  if (bots.length === 0) {
    const model = runtime.config.models[0];
    if (model === undefined) throw new CommandError("Nenhum modelo configurado.");
    const { bot } = await ensureDefaultBot(runtime, { modelId: model.id });
    ctx.out.line(
      `Primeiro uso: criei o bot principal "${bot.name}" com o modelo ${model.id}. Para trocar, use suup bot create e --bot.`,
    );
    return bot;
  }
  if (bots.length === 1) return bots[0] as Bot;
  throw new UsageError(
    `Há ${bots.length} bots e nenhum é o principal: escolha um com --bot <id ou nome> (veja suup bot list).`,
    NAME,
  );
}

export const chatCommand: CommandSpec = {
  name: NAME,
  summary: "Conversa com um bot no terminal (com a memória e o histórico da conversa)",
  options: {
    bot: {
      type: "string",
      value: "bot",
      help: "O bot da conversa: id, início do id ou nome (padrão: o bot principal)",
    },
    message: {
      type: "string",
      value: "texto",
      help: "Sem terminal: envia esta mensagem, espera o bot terminar o turno, mostra a resposta e sai",
    },
  },
  positionals: { names: [] },
  notes: [
    "Cada bot tem a sua conversa, que continua de onde parou. O bot lembra do que foi dito antes (histórico),",
    "das regras e do perfil que a memória guarda (suup memory list) e pode guardar coisas novas.",
    "Num terminal: digite e tecle Enter; /sair (ou Ctrl+D) encerra. Enquanto o bot trabalha, o que você digita",
    "chega a ele no próximo ponto seguro; se ele perguntar algo, a próxima linha é a resposta.",
    "Ctrl+C uma vez pausa a execução no próximo ponto seguro (a conversa retoma na próxima vez); duas vezes aborta já.",
    'Sem terminal: suup chat --bot ajudante --message "Qual é o meu nome?"',
  ],
  async run(ctx) {
    const { io, out, json } = ctx;
    const message = str(ctx.args, "message");
    const interactive = io.stdin.isTTY === true && !json && message === undefined;
    if (!interactive && message === undefined) {
      throw new UsageError(
        "Sem terminal não há como conversar: use --message <texto> para enviar uma mensagem e ver a resposta.",
        NAME,
      );
    }
    if (message !== undefined && message.trim() === "") {
      throw new UsageError("A mensagem está vazia.", NAME);
    }

    const runtime = ctx.runtime();
    const db = runtime.db;
    const bot = await pickBot(ctx, str(ctx.args, "bot"));
    const conversation = await createDirectConversation(db, bot.id);
    warnIfLocalSandbox(ctx);
    // Runs that ended while no worker was looking (a crash) still owe the conversation their end.
    await reconcileRunEffects(db);

    // Messages already shown. Starts at the tail of the history.
    const tail = await listMessages(db, conversation.id, { limit: HISTORY_TAIL });
    let shown = tail[tail.length - 1]?.seq ?? 0;
    if (interactive) {
      out.line(
        `Conversa com ${bot.name} (modelo ${bot.modelId}). /sair encerra; Ctrl+C pausa o bot.`,
      );
      if (tail.length > 0) {
        out.line("── mensagens anteriores ──");
        for (const m of tail) out.lines(bubble(m, bot.name));
        out.line("──────────────────────────");
      }
    }

    /** Prints what the conversation got since the last print, except what the user typed. */
    const showNew = async (): Promise<Message[]> => {
      const fresh = await listMessages(db, conversation.id, { afterSeq: shown, limit: 200 });
      const last = fresh[fresh.length - 1];
      if (last !== undefined) shown = last.seq;
      const visible = fresh.filter((m) => m.authorKind !== "user");
      for (const m of visible) {
        if (json) out.ndjson(messageJson(m));
        else out.lines(bubble(m, bot.name));
      }
      return visible;
    };

    const lines = interactive ? new LineQueue(io.stdin) : undefined;
    const sendLine = async (text: string) => {
      const sent = await sendMessage(runtime, { conversationId: conversation.id, text });
      shown = Math.max(shown, sent.message.seq);
      out.line(
        sent.queuedForRun
          ? "  (mensagem enviada: o bot a lê no próximo ponto seguro)"
          : "  (nova execução criada)",
      );
    };

    /**
     * The question of a run that waits for the user is the bot's message, written by the worker
     * right after the run pauses: wait a moment for it, so the person sees it before the prompt.
     */
    const showQuestion = async () => {
      for (let i = 0; i < 40; i++) {
        if ((await showNew()).length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    /** Follows the conversation's active run, and the ones that follow it, until none is left. */
    let failed = false;
    const settle = async (): Promise<"idle" | "paused"> => {
      for (;;) {
        const run = await getActiveConversationRun(db, conversation.id);
        if (run === null) return "idle";
        const earlier = await readEvents(db, run.id);
        // A run that already worked (a pause, a wait) is picked up where it stopped.
        const from = earlier.length > 1 ? (earlier[earlier.length - 1]?.seq ?? 0) : 0;
        const result = await followRunCore(ctx, run.id, from, {
          ...(lines === undefined ? {} : { lines }),
          hide: hideOutcome,
          onLine: sendLine,
          beforePrompt: showQuestion,
        });
        await showNew();
        const status = result.run.status;
        if (status === "done" || status === "failed" || status === "cancelled") {
          if (status !== "done") failed = true;
          continue; // a message that arrived as the run ended may have opened the next one
        }
        if (status === "waiting_approval") {
          const cards = await pendingCards(db, run.id);
          if (lines === undefined || json) {
            // No terminal to ask on: the card is printed, and answered with `suup approve`.
            printCards(ctx, cards);
            return "idle";
          }
          let answered = false;
          for (const card of cards) {
            const answer = await askInline(ctx, lines, card, bot.name);
            if (answer === "later") {
              out.line(
                "Fica pendente: decida depois com suup approve / suup deny (ou abra o chat de novo).",
              );
              return "idle";
            }
            answered = true;
          }
          if (answered) continue; // the answer made the run claimable: follow it again
          return "idle";
        }
        // Without a terminal a question waits in the conversation; with one, the person left.
        if (status === "waiting_user") return "idle";
        out.line(
          "Execução pausada: nada se perdeu. Abra o chat de novo para retomá-la do ponto em que parou.",
        );
        return "paused";
      }
    };

    try {
      if (message !== undefined) {
        const sent = await sendMessage(runtime, { conversationId: conversation.id, text: message });
        if (json) out.ndjson(messageJson(sent.message));
        shown = Math.max(shown, sent.message.seq);
        await settle();
        return failed ? EXIT_FAILED : EXIT_OK;
      }
      // A run left from an earlier session (paused, or waiting for an answer) comes first.
      if ((await settle()) === "paused") return EXIT_OK;
      for (;;) {
        out.raw("Você> ");
        const line = await (lines as LineQueue).next();
        if (line === null) {
          out.line("");
          break;
        }
        const text = line.trim();
        if (text === "") continue;
        if (EXIT_WORDS.has(text)) break;
        try {
          const sent = await sendMessage(runtime, { conversationId: conversation.id, text });
          shown = Math.max(shown, sent.message.seq);
        } catch (error) {
          out.err(error instanceof Error ? error.message : String(error));
          continue;
        }
        if ((await settle()) === "paused") break;
      }
      return EXIT_OK;
    } finally {
      lines?.close();
    }
  },
};
