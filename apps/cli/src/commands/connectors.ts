import type { PinnedDefinition } from "@suup/connectors";
import { listBots } from "@suup/db";
import type { ConnectorToolState, ConnectorView } from "@suup/runtime";
import { flag, list, str } from "../args.js";
import type { CommandSpec, Ctx } from "../context.js";
import { CommandError, EXIT_FAILED, EXIT_OK, UsageError } from "../errors.js";
import { formatDateTime, oneLine } from "../format.js";
import { findBot } from "../lookup.js";
import { renderTable } from "../table.js";

const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/;
const LEVELS = ["read", "write_reversible", "external_irreversible"] as const;
const LEVEL_PT: Record<string, string> = {
  read: "leitura",
  write_reversible: "escrita reversível",
  external_irreversible: "externa/irreversível (pergunta)",
};
const BASIS_PT: Record<string, string> = {
  default: "padrão",
  user: "definido por você",
  trusted_hint: "dica do servidor (você confia)",
  tightened_by_hint: "apertado pela dica do servidor",
  outbound: "mensagem a outra pessoa (você marcou)",
};

function view(c: ConnectorView) {
  return { ...c, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() };
}

const PIN_PT: Record<string, string> = {
  approved: "aprovada",
  changed: "MUDOU: desligada até revisar",
  new: "NOVA: desligada até revisar",
  unseen: "ainda não vista",
};

/** `NOME=valor` -> [NOME, valor]; the value may hold `=`. */
function pair(text: string, option: string, command: string): [string, string] {
  const at = text.indexOf("=");
  if (at <= 0) {
    throw new UsageError(
      `--${option} espera NOME=valor (recebido: ${JSON.stringify(text)}).`,
      command,
    );
  }
  return [text.slice(0, at), text.slice(at + 1)];
}

function secretName(name: string, option: string, command: string): string {
  if (!SECRET.test(name)) {
    throw new UsageError(
      `--${option}: nome de segredo inválido: ${JSON.stringify(name)} (use letras maiúsculas, números e sublinhado).`,
      command,
    );
  }
  return name;
}

function tableOfTools(tools: readonly ConnectorToolState[]): string[] {
  return renderTable(
    [
      "FERRAMENTA (nome para o bot)",
      "RISCO",
      "ORIGEM DO RISCO",
      "MENSAGEM",
      "DEFINIÇÃO",
      "OFERECIDA",
    ],
    tools.map((t) => [
      t.name,
      LEVEL_PT[t.risk] ?? t.risk,
      BASIS_PT[t.riskBasis] ?? t.riskBasis,
      t.outbound === undefined ? "" : `a outra pessoa (${t.outbound.recipientFields.join(", ")})`,
      PIN_PT[t.pin] ?? t.pin,
      t.available ? "sim" : `não: ${oneLine(t.reason ?? "", 70)}`,
    ]),
  );
}

async function must(ctx: Ctx, name: string): Promise<ConnectorView> {
  const found = await ctx.runtime().connectors.get(name);
  if (found === null) {
    throw new CommandError(
      `Conector não encontrado: ${name}. Veja os existentes com: suup connectors list`,
    );
  }
  return found;
}

export const connectorsList: CommandSpec = {
  name: "connectors list",
  summary: "Lista os conectores MCP (servidores externos cujas ferramentas os bots podem usar)",
  options: {},
  positionals: { names: [] },
  async run(ctx) {
    const runtime = ctx.runtime();
    const all = await runtime.connectors.list();
    const bots = new Map(
      (await listBots(runtime.db, { includeArchived: true })).map((b) => [b.id, b.name]),
    );
    if (ctx.json) {
      ctx.out.data(all.map(view));
      return EXIT_OK;
    }
    if (all.length === 0) {
      ctx.out.line(
        "Nenhum conector. Para adicionar um: suup connectors add <nome> --command <programa> --arg=<argumento>",
      );
      return EXIT_OK;
    }
    ctx.out.lines(
      renderTable(
        ["NOME", "TIPO", "ESCOPO", "ESTADO", "BOTS COM ACESSO", "FERRAMENTAS", "ÚLTIMO PROBLEMA"],
        all.map((c) => [
          c.name,
          c.transport.kind === "stdio" ? "processo local" : "HTTP",
          c.scope === "read_only" ? "só leitura" : "leitura e escrita",
          c.enabled ? "ligado" : "desligado",
          c.grants.length === 0
            ? "(nenhum)"
            : c.grants
                .map(
                  (g) =>
                    `${bots.get(g.botId) ?? g.botId.slice(0, 8)} (${g.all ? "todas" : `${g.tools.length} ferramenta(s)`})`,
                )
                .join(", "),
          c.tools === null
            ? "(ainda não listadas)"
            : `${c.tools.filter((t) => t.available).length} de ${c.tools.length}`,
          oneLine(
            c.pendingReviews > 0
              ? `${c.pendingReviews} ferramenta(s) esperando revisão (suup connectors review ${c.name})`
              : (c.discovery.lastError ?? ""),
            80,
          ),
        ]),
      ),
    );
    return EXIT_OK;
  },
};

export const connectorsAdd: CommandSpec = {
  name: "connectors add",
  summary: "Adiciona um conector MCP (processo local ou HTTP)",
  options: {
    command: {
      type: "string",
      value: "programa",
      help: "Processo local: o executável (sem argumentos: eles vão em --arg)",
    },
    arg: {
      type: "string",
      value: "argumento",
      multiple: true,
      help: "Argumento do programa (repita; comece por = se tiver hífen: --arg=-y)",
    },
    env: {
      type: "string",
      value: "NOME=valor",
      multiple: true,
      help: "Variável de ambiente do processo, com um valor que NÃO é segredo",
    },
    "env-secret": {
      type: "string",
      value: "NOME=SEGREDO",
      multiple: true,
      help: "Variável de ambiente que vem de um segredo do cofre",
    },
    cwd: { type: "string", value: "pasta", help: "Pasta onde o processo roda" },
    url: {
      type: "string",
      value: "url",
      help: "HTTP: o endereço do servidor (https, ou http só para localhost)",
    },
    header: {
      type: "string",
      value: "Nome=valor",
      multiple: true,
      help: "Cabeçalho HTTP com um valor que NÃO é segredo",
    },
    "header-secret": {
      type: "string",
      value: "Nome=SEGREDO",
      multiple: true,
      help: "Cabeçalho HTTP que vem de um segredo do cofre",
    },
    bearer: {
      type: "string",
      value: "SEGREDO",
      help: "Atalho: Authorization: Bearer <segredo do cofre>",
    },
    scope: {
      type: "string",
      value: "escopo",
      help: "read_only (só ferramentas marcadas como leitura) ou read_write (padrão)",
    },
    read: {
      type: "string",
      value: "ferramenta",
      multiple: true,
      help: "Marca uma ferramenta (nome no servidor) como leitura: executa sem cartão",
    },
    "trust-annotations": {
      type: "boolean",
      help: "Confia no que o servidor diz de si (readOnlyHint): uma ferramenta que diz só ler conta como leitura",
    },
    "timeout-ms": {
      type: "string",
      value: "ms",
      help: "Tempo máximo de uma chamada (padrão 60000)",
    },
    description: { type: "string", value: "texto", help: "Para que serve" },
    bot: {
      type: "string",
      value: "bot",
      multiple: true,
      help: "Já libera o uso para este bot (repita para vários)",
    },
    disabled: { type: "boolean", help: "Cria desligado" },
  },
  positionals: { names: ["nome"] },
  notes: [
    "Exemplos:",
    "  suup connectors add arquivos --command npx --arg=-y --arg=@modelcontextprotocol/server-filesystem --arg=/dados --scope read_only --read read_file",
    "  suup connectors add erp --url https://erp.example.com/mcp --bearer ERP_TOKEN --bot ajudante",
    "",
    "Credenciais são SEMPRE referências a segredos do cofre (suup vault set ERP_TOKEN): o valor só é lido ao conectar.",
    "Um processo local roda NO COMPUTADOR DO SERVIDOR/WORKER, fora da máquina isolada dos bots, com as permissões do",
    "usuário que roda o suup. Só adicione programas em que você confia (docs/CONECTORES.md).",
    "Toda ferramenta nova PERGUNTA antes de rodar, a menos que você a marque como leitura (--read, ou suup connectors set-risk).",
  ],
  async run(ctx) {
    const [name] = ctx.args.positionals as [string];
    const command = str(ctx.args, "command");
    const url = str(ctx.args, "url");
    if ((command === undefined) === (url === undefined)) {
      throw new UsageError(
        "Informe --command <programa> (processo local) OU --url <endereço> (HTTP), um dos dois.",
        "connectors add",
      );
    }
    const refs = (option: string, plain: string[], secrets: string[]) => {
      const out: Record<string, string | { secret: string; prefix?: string }> = {};
      for (const text of plain) {
        const [key, value] = pair(text, option, "connectors add");
        out[key] = value;
      }
      for (const text of secrets) {
        const [key, value] = pair(text, `${option}-secret`, "connectors add");
        out[key] = { secret: secretName(value, `${option}-secret`, "connectors add") };
      }
      return out;
    };
    const bearer = str(ctx.args, "bearer");
    const transport =
      command !== undefined
        ? {
            kind: "stdio" as const,
            command,
            args: list(ctx.args, "arg"),
            env: refs("env", list(ctx.args, "env"), list(ctx.args, "env-secret")),
            ...(str(ctx.args, "cwd") === undefined ? {} : { cwd: str(ctx.args, "cwd") as string }),
          }
        : {
            kind: "http" as const,
            url: url as string,
            headers: {
              ...refs("header", list(ctx.args, "header"), list(ctx.args, "header-secret")),
              ...(bearer === undefined
                ? {}
                : {
                    Authorization: {
                      secret: secretName(bearer, "bearer", "connectors add"),
                      prefix: "Bearer ",
                    },
                  }),
            },
          };
    const scope = str(ctx.args, "scope");
    if (scope !== undefined && scope !== "read_only" && scope !== "read_write") {
      throw new UsageError('--scope aceita "read_only" ou "read_write".', "connectors add");
    }
    const timeout = str(ctx.args, "timeout-ms");
    if (timeout !== undefined && !/^\d+$/.test(timeout)) {
      throw new UsageError("--timeout-ms espera um número de milissegundos.", "connectors add");
    }
    const runtime = ctx.runtime();
    const bots = [];
    for (const ref of list(ctx.args, "bot")) bots.push(await findBot(runtime.db, ref));
    const read = list(ctx.args, "read");
    const created = await runtime.connectors.create({
      name,
      description: str(ctx.args, "description"),
      transport,
      scope: scope as "read_only" | "read_write" | undefined,
      tools: Object.fromEntries(read.map((t) => [t, { risk: "read" as const }])),
      trustAnnotations: flag(ctx.args, "trust-annotations") ? true : undefined,
      timeoutMs: timeout === undefined ? undefined : Number(timeout),
      enabled: flag(ctx.args, "disabled") ? false : undefined,
    });
    // `--bot` on `add` is the user granting the whole connector (every tool it offers, once approved).
    for (const bot of bots) await runtime.connectors.grant(name, bot.id, "all");
    if (ctx.json) {
      ctx.out.data(view((await runtime.connectors.get(name)) ?? created));
      return EXIT_OK;
    }
    ctx.out.line(`Conector ${name} adicionado${created.enabled ? "" : " (desligado)"}.`);
    if (command !== undefined) {
      ctx.out.warn(
        "este conector é um programa que roda no computador do servidor/worker, fora da máquina isolada dos bots, com as permissões deste usuário.",
      );
    }
    ctx.out.line(`Confira se conecta e quais ferramentas oferece: suup connectors test ${name}`);
    if (bots.length === 0)
      ctx.out.line(
        `Nenhum bot pode usá-lo ainda: suup connectors grant ${name} --bot <bot> --tools a,b | --all | --read-only`,
      );
    return EXIT_OK;
  },
};

export const connectorsRemove: CommandSpec = {
  name: "connectors rm",
  summary: "Remove um conector (e as concessões dele)",
  options: {},
  positionals: { names: ["nome"] },
  async run(ctx) {
    const [name] = ctx.args.positionals as [string];
    const gone = await ctx.runtime().connectors.remove(name);
    if (!gone)
      throw new CommandError(`Conector não encontrado: ${name}. Veja: suup connectors list`);
    if (ctx.json) ctx.out.data({ deleted: name });
    else ctx.out.line(`Conector ${name} removido.`);
    return EXIT_OK;
  },
};

async function toggle(ctx: Ctx, enabled: boolean): Promise<number> {
  const [name] = ctx.args.positionals as [string];
  await must(ctx, name);
  const updated = await ctx.runtime().connectors.update(name, { enabled });
  if (ctx.json) ctx.out.data(view(updated));
  else {
    ctx.out.line(
      enabled
        ? `Conector ${name} ligado: os bots com acesso passam a ver as ferramentas dele na próxima execução.`
        : `Conector ${name} desligado: nenhuma execução nova vê as ferramentas dele.`,
    );
  }
  return EXIT_OK;
}

export const connectorsEnable: CommandSpec = {
  name: "connectors enable",
  summary: "Liga um conector",
  options: {},
  positionals: { names: ["nome"] },
  run: (ctx) => toggle(ctx, true),
};

export const connectorsDisable: CommandSpec = {
  name: "connectors disable",
  summary: "Desliga um conector (sem apagá-lo)",
  options: {},
  positionals: { names: ["nome"] },
  run: (ctx) => toggle(ctx, false),
};

async function selection(
  ctx: Ctx,
  name: string,
  command: string,
): Promise<"all" | readonly string[]> {
  const tools = str(ctx.args, "tools");
  const all = flag(ctx.args, "all");
  const readOnly = flag(ctx.args, "read-only");
  const chosen = [tools !== undefined, all, readOnly].filter(Boolean).length;
  if (chosen !== 1) {
    throw new UsageError(
      "Diga quais ferramentas o bot pode usar, com exatamente uma destas opções: --tools a,b (nomes no servidor), --all (todas) ou --read-only (só as marcadas como leitura).",
      command,
    );
  }
  if (all) return "all";
  if (tools !== undefined) {
    const names = tools
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    if (names.length === 0) throw new UsageError("--tools está vazio.", command);
    return names;
  }
  let current = await must(ctx, name);
  if (current.tools === null) {
    const result = await ctx.runtime().connectors.test(name);
    if (!result.ok) throw new CommandError(result.error ?? "falhou");
    current = await must(ctx, name);
  }
  return (current.tools ?? [])
    .filter((t) => t.available && t.risk === "read")
    .map((t) => t.serverName);
}

async function grantOrRevoke(ctx: Ctx, grant: boolean): Promise<number> {
  const command = grant ? "connectors grant" : "connectors revoke";
  const [name] = ctx.args.positionals as [string];
  const botRef = str(ctx.args, "bot");
  if (botRef === undefined) throw new UsageError("Falta --bot <bot>.", command);
  const runtime = ctx.runtime();
  const bot = await findBot(runtime.db, botRef);
  await must(ctx, name);
  const chosen = grant ? await selection(ctx, name, command) : undefined;
  const updated =
    chosen === undefined
      ? await runtime.connectors.revoke(name, bot.id)
      : await runtime.connectors.grant(name, bot.id, chosen);
  if (ctx.json) ctx.out.data(view(updated));
  else if (chosen === undefined) {
    ctx.out.line(`${bot.name} não vê mais as ferramentas do conector ${name}.`);
  } else {
    ctx.out.line(
      chosen === "all"
        ? `${bot.name} pode usar todas as ferramentas do conector ${name} (as aprovadas, inclusive as que ele passar a oferecer).`
        : chosen.length === 0
          ? `${bot.name} tem acesso ao conector ${name}, mas a nenhuma ferramenta dele.`
          : `${bot.name} pode usar só estas ferramentas do conector ${name}: ${chosen.join(", ")}.`,
    );
    ctx.out.line(
      "Cada uma pergunta antes, a menos que você a tenha marcado como leitura ou criado uma regra. Uma ferramenta que não foi concedida não existe para o bot.",
    );
  }
  return EXIT_OK;
}

const GRANT_OPTIONS = {
  bot: { type: "string", value: "bot", help: "O bot (id, início do id ou nome)" },
  tools: {
    type: "string",
    value: "a,b",
    help: "As ferramentas que o bot pode usar (nomes NO SERVIDOR, separados por vírgula)",
  },
  all: { type: "boolean", help: "Todas as ferramentas do conector (as aprovadas)" },
  "read-only": {
    type: "boolean",
    help: "Só as ferramentas marcadas como leitura agora (a lista é fixada neste momento)",
  },
} as const;

export const connectorsGrant: CommandSpec = {
  name: "connectors grant",
  summary: "Deixa um bot usar ferramentas de um conector (--tools a,b | --all | --read-only)",
  options: { ...GRANT_OPTIONS },
  positionals: { names: ["nome"] },
  run: (ctx) => grantOrRevoke(ctx, true),
};

export const connectorsRevoke: CommandSpec = {
  name: "connectors revoke",
  summary: "Tira de um bot o acesso a um conector",
  options: { bot: GRANT_OPTIONS.bot },
  positionals: { names: ["nome"] },
  run: (ctx) => grantOrRevoke(ctx, false),
};

function definitionLines(label: string, def: PinnedDefinition | null): string[] {
  if (def === null) return [`${label}: (nunca aprovada)`];
  const out = [`${label}:`];
  out.push(`  descrição: ${def.description ?? "(nenhuma)"}`);
  const hints = def.annotations === null ? "(nenhuma)" : JSON.stringify(def.annotations);
  out.push(`  dicas: ${hints}`);
  out.push("  esquema de entrada:");
  for (const line of (JSON.stringify(def.inputSchema, null, 2) ?? "null").split("\n")) {
    out.push(`    ${line}`);
  }
  return out;
}

export const connectorsReview: CommandSpec = {
  name: "connectors review",
  summary:
    "Mostra as ferramentas cuja definição mudou (ou que são novas) e aprova uma (--approve ferramenta --fingerprint início)",
  options: {
    approve: {
      type: "string",
      value: "ferramenta",
      help: "Aprova a definição atual desta ferramenta (nome no servidor)",
    },
    fingerprint: {
      type: "string",
      value: "início",
      help: "Os primeiros 8 ou mais caracteres da impressão digital mostrada: prova que você viu esta versão",
    },
  },
  positionals: { names: ["nome"] },
  async run(ctx) {
    const [name] = ctx.args.positionals as [string];
    const runtime = ctx.runtime();
    await must(ctx, name);
    const approve = str(ctx.args, "approve");
    if (approve !== undefined) {
      const wanted = str(ctx.args, "fingerprint");
      const pending = (await runtime.connectors.review(name)).find((r) => r.tool === approve);
      if (pending === undefined) {
        throw new CommandError(
          `A ferramenta ${approve} não espera revisão (veja: suup connectors review ${name}).`,
        );
      }
      if (
        wanted === undefined ||
        wanted.length < 8 ||
        !pending.currentFingerprint.startsWith(wanted)
      ) {
        throw new UsageError(
          `Para aprovar, repita com --fingerprint ${pending.currentFingerprint.slice(0, 12)} (a impressão digital da definição que você viu em "suup connectors review ${name}").`,
          "connectors review",
        );
      }
      const updated = await runtime.connectors.approveTool(
        name,
        approve,
        pending.currentFingerprint,
      );
      if (ctx.json) ctx.out.data(view(updated));
      else ctx.out.line(`Definição aprovada: ${approve} volta a ser oferecida a quem tem acesso.`);
      return EXIT_OK;
    }
    const pending = await runtime.connectors.review(name);
    if (ctx.json) {
      ctx.out.data(pending.map((r) => ({ ...r, seenAt: r.seenAt.toISOString() })));
      return EXIT_OK;
    }
    if (pending.length === 0) {
      ctx.out.line(`Nenhuma ferramenta do conector ${name} espera revisão.`);
      return EXIT_OK;
    }
    for (const r of pending) {
      ctx.out.line(
        `${r.tool}: ${r.status === "changed" ? "a definição MUDOU depois de aprovada" : "ferramenta NOVA, nunca aprovada"} (vista em ${formatDateTime(r.seenAt)})`,
      );
      ctx.out.lines(definitionLines("antes (o que você aprovou)", r.approved));
      ctx.out.lines(definitionLines("agora (o que o servidor mostra)", r.current));
      ctx.out.line(
        `Se confia: suup connectors review ${name} --approve ${r.tool} --fingerprint ${r.currentFingerprint.slice(0, 12)}`,
      );
      ctx.out.line("");
    }
    ctx.out.line(
      "Enquanto não for aprovada, a ferramenta fica desligada para todos os bots. A descrição é texto do servidor (não confiável): leia como leria um programa que você instala.",
    );
    return EXIT_OK;
  },
};

export const connectorsTools: CommandSpec = {
  name: "connectors tools",
  summary: "Mostra as ferramentas de um conector, com o risco de cada uma",
  options: {
    refresh: {
      type: "boolean",
      help: "Conecta de novo ao servidor para listar (padrão: a última listagem guardada)",
    },
  },
  positionals: { names: ["nome"] },
  async run(ctx) {
    const [name] = ctx.args.positionals as [string];
    const runtime = ctx.runtime();
    let current = await must(ctx, name);
    if (flag(ctx.args, "refresh") || current.tools === null) {
      const result = await runtime.connectors.test(name);
      if (!result.ok) {
        throw new CommandError(
          `${result.error ?? "falhou"}${current.tools === null ? "" : "\n(mostrando a última listagem guardada)"}`,
        );
      }
      current = await must(ctx, name);
    }
    const tools = current.tools ?? [];
    if (ctx.json) {
      ctx.out.data(tools);
      return EXIT_OK;
    }
    ctx.out.line(
      `Conector ${name} (${current.scope === "read_only" ? "só leitura" : "leitura e escrita"}${current.discovery.discoveredAt === null ? "" : `; listado em ${formatDateTime(current.discovery.discoveredAt)}`}):`,
    );
    ctx.out.lines(tableOfTools(tools));
    ctx.out.line("");
    ctx.out.line(
      "Para marcar uma ferramenta como leitura: suup connectors set-risk <conector> <ferramenta-no-servidor> read",
    );
    ctx.out.line(
      "Para marcar uma ferramenta que envia mensagem a outra pessoa: suup connectors set-outbound <conector> <ferramenta-no-servidor> --to campo",
    );
    return EXIT_OK;
  },
};

export const connectorsSetRisk: CommandSpec = {
  name: "connectors set-risk",
  summary:
    "Define o que você afirma sobre uma ferramenta: read, write_reversible, external_irreversible ou default",
  options: {},
  positionals: { names: ["nome", "ferramenta", "nível"] },
  notes: [
    "A ferramenta é o nome dela NO SERVIDOR (o que `suup connectors tools` mostra em OFERECIDA/ORIGEM; ex.: search_issues).",
    "Marcar como read faz a ferramenta executar sem cartão. O que o servidor diz de si só pode APERTAR isso, nunca afrouxar.",
  ],
  async run(ctx) {
    const [name, tool, level] = ctx.args.positionals as [string, string, string];
    const risk = level === "default" || level === "padrão" ? null : level;
    if (risk !== null && !(LEVELS as readonly string[]).includes(risk)) {
      throw new UsageError(
        `Nível inválido: ${JSON.stringify(level)}. Use ${LEVELS.join(", ")} ou default.`,
        "connectors set-risk",
      );
    }
    await must(ctx, name);
    const updated = await ctx
      .runtime()
      .connectors.setToolRisk(name, tool, risk as (typeof LEVELS)[number] | null);
    if (ctx.json) ctx.out.data(view(updated));
    else {
      ctx.out.line(
        risk === null
          ? `${tool}: voltou ao padrão (pergunta antes de rodar).`
          : `${tool}: ${LEVEL_PT[risk]}.`,
      );
    }
    return EXIT_OK;
  },
};

export const connectorsSetOutbound: CommandSpec = {
  name: "connectors set-outbound",
  summary:
    'Marca (ou desmarca) uma ferramenta como "envia mensagem para outra pessoa" e diz onde está o destinatário',
  options: {
    to: {
      type: "string",
      value: "campo",
      multiple: true,
      help: "O argumento da ferramenta que guarda o destinatário (repita para vários: to, cc)",
    },
    none: {
      type: "boolean",
      help: "Desmarca: a ferramenta deixa de ser uma mensagem a outra pessoa",
    },
  },
  positionals: { names: ["nome", "ferramenta"] },
  notes: [
    "Só VOCÊ diz isto: nenhuma dica do servidor, nome ou descrição de ferramenta faz o app tratá-la como mensagem.",
    'Uma ferramenta marcada nunca é leitura e o cartão dela tem "Enviar" e o menu do destinatário ("Permitir destinatário").',
    "A ferramenta é o nome dela NO SERVIDOR. Exemplo: suup connectors set-outbound mail send_email --to to",
  ],
  async run(ctx) {
    const [name, tool] = ctx.args.positionals as [string, string];
    const fields = list(ctx.args, "to");
    const none = flag(ctx.args, "none");
    if (none === fields.length > 0) {
      throw new UsageError(
        "Diga onde está o destinatário (--to campo) ou use --none para desmarcar.",
        "connectors set-outbound",
      );
    }
    await must(ctx, name);
    const updated = await ctx
      .runtime()
      .connectors.setToolOutbound(
        name,
        tool,
        none ? null : { kind: "message", recipientFields: fields },
      )
      .catch((error: unknown) => {
        throw error instanceof Error && error.name === "ConnectorConfigError"
          ? new CommandError(error.message)
          : error;
      });
    if (ctx.json) ctx.out.data(view(updated));
    else {
      ctx.out.line(
        none
          ? `${tool}: não é mais uma mensagem a outra pessoa.`
          : `${tool}: mensagem a outra pessoa (destinatário em ${fields.join(", ")}). O cartão dela pergunta antes de enviar.`,
      );
    }
    return EXIT_OK;
  },
};

export const connectorsTest: CommandSpec = {
  name: "connectors test",
  summary:
    "Liga o servidor do conector do zero, lista as ferramentas e o desliga (diz de quem é o problema)",
  options: {},
  positionals: { names: ["nome"] },
  notes: ["Roda ONDE VOCÊ RODA O COMANDO: um programa local precisa existir neste computador."],
  async run(ctx) {
    const [name] = ctx.args.positionals as [string];
    await must(ctx, name);
    const result = await ctx.runtime().connectors.test(name);
    if (ctx.json) ctx.out.data(result);
    else if (result.ok) {
      ctx.out.line(
        `Conector ${name}: conectou a ${result.serverName} ${result.serverVersion} em ${result.durationMs} ms.`,
      );
      ctx.out.lines(tableOfTools(result.tools));
    } else {
      ctx.out.line(`FALHOU: ${result.error ?? "sem detalhe"}`);
    }
    return result.ok ? EXIT_OK : EXIT_FAILED;
  },
};
