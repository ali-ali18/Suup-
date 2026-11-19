import { RuntimeError } from "@suup/runtime";
import type { CommandSpec, Ctx } from "../context.js";
import { CommandError, EXIT_OK } from "../errors.js";
import { formatDateTime } from "../format.js";
import { findBot } from "../lookup.js";
import { renderTable } from "../table.js";

/** A runtime error (an invalid host, no such bot) is a message for the person, not a stack trace. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RuntimeError) throw new CommandError(error.message);
    throw error;
  }
}

const NOTES = [
  "A máquina do bot não tem rede própria: sai só por um proxy do harness, para os hosts desta lista (nome exato:",
  "api.exemplo.com não libera exemplo.com nem outro.api.exemplo.com; endereço IP e localhost nunca). Veja docs/REDE.md.",
];

async function show(ctx: Ctx, botRef: string): Promise<number> {
  const runtime = ctx.runtime();
  const bot = await findBot(runtime.db, botRef);
  const view = await guard(() => runtime.network.forBot(bot.id));
  if (ctx.json) {
    ctx.out.data({
      botId: bot.id,
      defaults: view.defaults,
      hosts: view.hosts.map((h) => ({ host: h.host, createdAt: h.createdAt.toISOString() })),
      refusals: view.refusals.map((r) => ({
        host: r.host,
        port: r.port,
        reason: r.reason,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
      })),
    });
    return EXIT_OK;
  }
  ctx.out.line(`Rede do bot ${bot.name} (${bot.id.slice(0, 8)})`);
  ctx.out.line(
    `  Liberados para todos os bots (configuração): ${view.defaults.length === 0 ? "(nenhum)" : view.defaults.join(", ")}`,
  );
  if (view.hosts.length === 0) ctx.out.line("  Liberados só para este bot: (nenhum)");
  else {
    ctx.out.line("  Liberados só para este bot:");
    ctx.out.lines(
      renderTable(
        ["HOST", "DESDE"],
        view.hosts.map((h) => [h.host, formatDateTime(h.createdAt)]),
      ).map((l) => `    ${l}`),
    );
  }
  if (view.refusals.length > 0) {
    ctx.out.line("  Recusados há pouco (para liberar: suup network allow <bot> <host>):");
    ctx.out.lines(
      renderTable(
        ["QUANDO", "HOST", "PORTA", "MOTIVO"],
        view.refusals.map((r) => [formatDateTime(r.createdAt), r.host, String(r.port), r.reason]),
      ).map((l) => `    ${l}`),
    );
  }
  return EXIT_OK;
}

export const networkList: CommandSpec = {
  name: "network list",
  summary: "Mostra os hosts que a máquina de um bot pode alcançar e o que o proxy recusou",
  options: {},
  positionals: { names: ["BOT"] },
  notes: NOTES,
  run: (ctx) => show(ctx, (ctx.args.positionals as [string])[0]),
};

export const networkAllow: CommandSpec = {
  name: "network allow",
  summary: "Libera um host (nome exato) para a máquina de um bot, até você remover",
  options: {},
  positionals: { names: ["BOT", "HOST"] },
  notes: NOTES,
  async run(ctx) {
    const [botRef, host] = ctx.args.positionals as [string, string];
    const runtime = ctx.runtime();
    const bot = await findBot(runtime.db, botRef);
    const result = await guard(() => runtime.network.allow(bot.id, host));
    if (!ctx.json) {
      ctx.out.line(
        result.added
          ? `Host ${result.host} liberado para o bot ${bot.name}.`
          : `Host ${result.host} já estava liberado para o bot ${bot.name}.`,
      );
    }
    return show(ctx, bot.id);
  },
};

export const networkRemove: CommandSpec = {
  name: "network rm",
  summary: "Tira um host da lista do bot (os liberados para todos pela configuração continuam)",
  options: {},
  positionals: { names: ["BOT", "HOST"] },
  notes: NOTES,
  async run(ctx) {
    const [botRef, host] = ctx.args.positionals as [string, string];
    const runtime = ctx.runtime();
    const bot = await findBot(runtime.db, botRef);
    const gone = await guard(() => runtime.network.remove(bot.id, host));
    if (!gone)
      throw new CommandError(`O host ${host} não está na lista própria do bot ${bot.name}.`);
    if (!ctx.json) ctx.out.line(`Host ${host} removido da lista do bot ${bot.name}.`);
    return show(ctx, bot.id);
  },
};
