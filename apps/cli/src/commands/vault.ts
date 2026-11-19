import type { Bot } from "@suup/db";
import { listBots } from "@suup/db";
import {
  answerSecretRequest,
  generateKeyText,
  pendingSecretRequest,
  VaultError,
} from "@suup/runtime";
import { list, str } from "../args.js";
import type { CommandSpec, Ctx } from "../context.js";
import { CommandError, EXIT_FAILED, EXIT_OK, UsageError } from "../errors.js";
import { formatDateTime, oneLine } from "../format.js";
import { findBot, findRun } from "../lookup.js";
import { readSecretValue } from "../secret-input.js";
import { renderTable } from "../table.js";

/** Turns a vault failure into a message for the person (never holding a key or a value). */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof VaultError) throw new CommandError(error.message);
    throw error;
  }
}

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function checkName(name: string, command: string): void {
  if (!NAME.test(name)) {
    throw new UsageError(
      `Nome de segredo inválido: ${JSON.stringify(name)}. Use letras maiúsculas, números e sublinhado, começando por letra (ex.: GITHUB_TOKEN).`,
      command,
    );
  }
}

export const vaultKeyGenerate: CommandSpec = {
  name: "vault key generate",
  summary: "Gera uma chave nova para o cofre e a mostra uma única vez",
  options: {},
  positionals: { names: [] },
  notes: [
    "A chave não é guardada em lugar nenhum: copie-a para um gerenciador de senhas e defina a variável de ambiente",
    'que a configuração indica em "vault.keyEnv" (padrão SUUP_VAULT_KEY). Sem ela, os segredos não podem ser lidos.',
    "Perder a chave é perder os segredos (cadastre-os de novo). Para trocar a chave, veja: suup vault rotate",
  ],
  async run(ctx) {
    const key = generateKeyText();
    if (ctx.json) ctx.out.data({ key });
    else {
      ctx.out.line(key);
      ctx.io.stderr.write(
        "Esta é a única vez que a chave aparece. Guarde-a e defina a variável de ambiente do cofre com ela (veja docs/COFRE.md).\n",
      );
    }
    return EXIT_OK;
  },
};

export const vaultSet: CommandSpec = {
  name: "vault set",
  summary:
    "Guarda (ou troca) um segredo no cofre; o valor vem da entrada padrão ou de um prompt oculto",
  options: {
    description: {
      type: "string",
      value: "texto",
      help: "Para que serve (o bot lê isto, e só isto, junto do nome)",
    },
    bot: {
      type: "string",
      value: "bot",
      multiple: true,
      help: "Já libera o uso para este bot (repita para vários)",
    },
    run: {
      type: "string",
      value: "execução",
      help: "Responde ao pedido de segredo que esta execução está esperando (libera o segredo ao bot dela e a retoma)",
    },
  },
  positionals: { names: ["NOME"] },
  notes: [
    "O valor nunca vai na linha de comando (ficaria no histórico do shell e na lista de processos).",
    "  num terminal:  suup vault set GITHUB_TOKEN        (digite o valor; nada aparece na tela)",
    "  por um pipe:   pass show github | suup vault set GITHUB_TOKEN --bot ajudante",
    "O bot usa o segredo escrevendo {{secret:GITHUB_TOKEN}} onde o valor vai; só vê o nome, nunca o valor.",
  ],
  async run(ctx) {
    const [name] = ctx.args.positionals as [string];
    checkName(name, "vault set");
    const bots: Bot[] = [];
    const runtime = ctx.runtime();
    for (const ref of list(ctx.args, "bot")) bots.push(await findBot(runtime.db, ref));
    const value = await readSecretValue(ctx.io, `Valor de ${name} (não aparece): `, "vault set");
    const description = str(ctx.args, "description");
    const runRef = str(ctx.args, "run");
    if (runRef !== undefined) {
      const target = await findRun(runtime.db, runRef);
      const request = await pendingSecretRequest(runtime, target.id);
      if (request === null || request.name !== name) {
        throw new CommandError(
          `A execução ${target.id.slice(0, 8)} não está esperando o segredo ${name}${request === null ? "" : ` (ela pede ${request.name})`}.`,
        );
      }
      await guard(() =>
        answerSecretRequest(runtime, target.id, {
          value,
          ...(description === undefined ? {} : { description }),
        }),
      );
      if (ctx.json) ctx.out.data({ name, runId: target.id, provided: true });
      else {
        ctx.out.line(
          `Segredo ${name} guardado e liberado para o bot da execução ${target.id.slice(0, 8)}; ela volta à fila. O bot só soube que o segredo está disponível.`,
        );
      }
      return EXIT_OK;
    }
    const meta = await guard(async () => {
      const saved = await runtime.vault.set(name, value, {
        ...(description === undefined ? {} : { description }),
      });
      for (const bot of bots) await runtime.vault.grant(name, bot.id);
      return saved;
    });
    if (ctx.json) ctx.out.data({ name: meta.name, keyId: meta.keyId });
    else {
      ctx.out.line(`Segredo ${name} guardado (chave ${meta.keyId}).`);
      if (bots.length === 0) {
        ctx.out.line(`Nenhum bot pode usá-lo ainda: suup vault grant ${name} --bot <bot>`);
      }
    }
    return EXIT_OK;
  },
};

export const vaultList: CommandSpec = {
  name: "vault list",
  summary: "Lista os segredos (nomes e quem pode usar; nunca os valores)",
  options: {},
  positionals: { names: [] },
  notes: [],
  async run(ctx) {
    const runtime = ctx.runtime();
    const secrets = await guard(() => runtime.vault.list());
    const names = new Map(
      (await listBots(runtime.db, { includeArchived: true })).map((b) => [b.id, b.name]),
    );
    if (ctx.json) {
      ctx.out.data(
        secrets.map((s) => ({
          name: s.name,
          description: s.description,
          keyId: s.keyId,
          grantedBotIds: s.grantedBotIds,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
        })),
      );
      return EXIT_OK;
    }
    if (secrets.length === 0) {
      ctx.out.line("O cofre está vazio. Para guardar um segredo: suup vault set NOME");
      return EXIT_OK;
    }
    ctx.out.lines(
      renderTable(
        ["NOME", "BOTS COM ACESSO", "ATUALIZADO", "ÚLTIMO USO", "PARA QUÊ"],
        secrets.map((s) => [
          s.name,
          s.grantedBotIds.length === 0
            ? "(nenhum)"
            : s.grantedBotIds.map((id) => names.get(id) ?? id.slice(0, 8)).join(", "),
          formatDateTime(s.updatedAt),
          s.lastUsedAt === null ? "nunca" : formatDateTime(s.lastUsedAt),
          oneLine(s.description, 50),
        ]),
      ),
    );
    return EXIT_OK;
  },
};

export const vaultRemove: CommandSpec = {
  name: "vault rm",
  summary: "Apaga um segredo do cofre",
  options: {},
  positionals: { names: ["NOME"] },
  notes: [],
  async run(ctx) {
    const [name] = ctx.args.positionals as [string];
    checkName(name, "vault rm");
    const gone = await guard(() => ctx.runtime().vault.remove(name));
    if (!gone) throw new CommandError(`Segredo não encontrado: ${name}. Veja: suup vault list`);
    if (ctx.json) ctx.out.data({ deleted: name });
    else ctx.out.line(`Segredo ${name} apagado.`);
    return EXIT_OK;
  },
};

async function grantOrRevoke(ctx: Ctx, grant: boolean): Promise<number> {
  const command = grant ? "vault grant" : "vault revoke";
  const [name] = ctx.args.positionals as [string];
  checkName(name, command);
  const botRef = str(ctx.args, "bot");
  if (botRef === undefined) throw new UsageError("Falta --bot <bot>.", command);
  const runtime = ctx.runtime();
  const bot = await findBot(runtime.db, botRef);
  const changed = await guard(async () => {
    if (grant) {
      await runtime.vault.grant(name, bot.id);
      return true;
    }
    return runtime.vault.revoke(name, bot.id);
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "SecretNotFoundError") {
      throw new CommandError(`Segredo não encontrado: ${name}. Veja: suup vault list`);
    }
    throw error;
  });
  if (ctx.json) ctx.out.data({ name, botId: bot.id, granted: grant, changed });
  else {
    ctx.out.line(
      grant
        ? `${bot.name} pode usar ${name}. Cada uso numa ação que sai para o mundo ainda passa pela aprovação.`
        : changed
          ? `${bot.name} não pode mais usar ${name}.`
          : `${bot.name} não tinha acesso a ${name}.`,
    );
  }
  return EXIT_OK;
}

export const vaultGrant: CommandSpec = {
  name: "vault grant",
  summary: "Deixa um bot usar um segredo",
  options: { bot: { type: "string", value: "bot", help: "O bot (id, início do id ou nome)" } },
  positionals: { names: ["NOME"] },
  notes: [],
  run: (ctx) => grantOrRevoke(ctx, true),
};

export const vaultRevoke: CommandSpec = {
  name: "vault revoke",
  summary: "Tira de um bot o direito de usar um segredo",
  options: { bot: { type: "string", value: "bot", help: "O bot (id, início do id ou nome)" } },
  positionals: { names: ["NOME"] },
  notes: [],
  run: (ctx) => grantOrRevoke(ctx, false),
};

export const vaultRotate: CommandSpec = {
  name: "vault rotate",
  summary: "Recifra com a chave atual os segredos que estão numa chave antiga",
  options: {},
  positionals: { names: [] },
  notes: [
    "Para trocar a chave: gere uma nova (suup vault key generate), coloque a ANTIGA numa variável de ambiente listada em",
    '"vault.previousKeyEnvs", a nova na variável de "vault.keyEnv", e rode este comando. Depois disso a chave antiga',
    "pode ser descartada. Segredos que nenhuma chave configurada lê são listados e ficam como estão.",
  ],
  async run(ctx) {
    const result = await guard(() => ctx.runtime().vault.rotate());
    if (ctx.json) ctx.out.data(result);
    else {
      ctx.out.line(
        `Recifrados: ${result.rotated}. Já na chave atual: ${result.alreadyCurrent}. Não lidos: ${result.failed.length}.`,
      );
      if (result.failed.length > 0) {
        ctx.out.line(
          `Sem acesso (falta a chave antiga em vault.previousKeyEnvs?): ${result.failed.join(", ")}`,
        );
      }
    }
    return result.failed.length > 0 ? EXIT_FAILED : EXIT_OK;
  },
};
