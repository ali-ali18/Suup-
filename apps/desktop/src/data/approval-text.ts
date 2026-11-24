import type { ApprovalRule, ArgMatcher, RiskLevel } from "@suup/api";
import { toolLabel } from "./derive.js";

// What the approval screens SAY, in plain Portuguese: the risk levels, why a card was asked, the tool
// in human words, and what a rule matches. Pure functions, table-tested. Nothing here decides
// anything: the server decides; this only describes what it decided.

export const LEVEL_LABEL: Record<RiskLevel, string> = {
  read: "Leitura",
  write_reversible: "Escrita reversível",
  external_irreversible: "Externa ou irreversível",
};

export const LEVEL_HINT: Record<RiskLevel, string> = {
  read: "Só observa; executa sem perguntar.",
  write_reversible: "Muda algo, mas dá para desfazer.",
  external_irreversible: "Sai para o mundo ou não tem volta: espera você.",
};

/** The three levels, in the order the selects list them. */
export const LEVELS: readonly RiskLevel[] = ["read", "write_reversible", "external_irreversible"];

/** Why the card was asked (`Approval.source`). */
export const SOURCE_REASON: Record<"rule" | "reviewer" | "default", string> = {
  default: "o nível desta ação pede sua permissão",
  reviewer: "a revisão automática achou a ação sensível",
  rule: "uma regra sua manda perguntar",
};

/** `Aprovado`, `Recusado`... for a decided card. */
export const STATUS_LABEL: Record<string, string> = {
  pending: "Aguardando você",
  approved: "Aprovado",
  denied: "Recusado",
  cancelled: "Cancelado",
  expired: "Expirou",
};

export const STATUS_DETAIL: Record<string, string> = {
  approved: "Você aprovou e a ação rodou exatamente com este conteúdo.",
  denied: "Você recusou: o bot foi avisado e seguiu sem executar a ação.",
  cancelled: "A execução foi cancelada, então o pedido foi cancelado junto.",
  expired: "Ninguém decidiu a tempo: o pedido expirou e o bot foi avisado.",
};

const CONNECTOR_PREFIX = "conn_";
const SEPARATOR = "__";

/** The tool with which a bot asks to reach one more host from its machine (`docs/REDE.md`). */
export const NETWORK_TOOL = "request_network_access";

/** The name a connector's tools carry: dashes become underscores (`conn_meu_erp__`). */
const prefixOf = (connector: string): string =>
  `${CONNECTOR_PREFIX}${connector.replaceAll("-", "_")}${SEPARATOR}`;

export const isConnectorTool = (tool: string): boolean => tool.startsWith(CONNECTOR_PREFIX);

export interface ConnectorToolRef {
  connector: string;
  /** The tool as the server calls it, when the connector's list says; else the registered suffix. */
  tool: string;
}

/**
 * `conn_<connector>__<tool>` as the connector and the tool. Known connectors (with the tool lists
 * they last returned) give the exact names; otherwise the name is read from the shape.
 */
export function parseConnectorTool(
  name: string,
  connectors: readonly { name: string; tools?: readonly { name: string; tool: string }[] | null }[],
): ConnectorToolRef | null {
  if (!isConnectorTool(name)) return null;
  const known = [...connectors]
    .sort((a, b) => b.name.length - a.name.length)
    .find((c) => name.startsWith(prefixOf(c.name)));
  if (known !== undefined) {
    const tool = known.tools?.find((t) => t.name === name)?.tool;
    return { connector: known.name, tool: tool ?? name.slice(prefixOf(known.name).length) };
  }
  const rest = name.slice(CONNECTOR_PREFIX.length);
  const cut = rest.indexOf(SEPARATOR);
  if (cut <= 0) return { connector: rest, tool: "" };
  return { connector: rest.slice(0, cut), tool: rest.slice(cut + SEPARATOR.length) };
}

/** A tool in human words: "Terminal", "Escrever arquivo", "Conector erp → criar_pedido". */
export function toolTitle(
  tool: string,
  connectors: readonly {
    name: string;
    tools?: readonly { name: string; tool: string }[] | null;
  }[] = [],
): string {
  if (tool === "*") return "qualquer ferramenta";
  const ref = parseConnectorTool(tool, connectors);
  if (ref !== null)
    return ref.tool === ""
      ? `Conector ${ref.connector}`
      : `Conector ${ref.connector} → ${ref.tool}`;
  return toolLabel(tool);
}

// ------------------------------------------------------------------- rules

const quote = (value: string): string => `“${value}”`;

/** `o campo command é exatamente “git status”`: the only comparison a rule has. */
export function matcherText(matcher: ArgMatcher): string {
  return `o campo ${matcher.field} é exatamente ${quote(matcher.value)}`;
}

/** All of them have to hold: `o campo a é exatamente “x” e o campo b é exatamente “y”`. */
export function matchersText(matchers: readonly ArgMatcher[]): string {
  return matchers.map(matcherText).join(" e ");
}

export interface RuleContext {
  /** The name of the bot, or `undefined` when it is not known (a bot that no longer exists). */
  botName?: string | undefined;
  connectors?: readonly {
    name: string;
    tools?: readonly { name: string; tool: string }[] | null;
  }[];
}

const whoText = (botId: string | null, botName: string | undefined): string =>
  botId === null ? "todos os bots" : `o bot ${botName ?? "(removido)"}`;

/**
 * The whole rule as one sentence, for the list and for the form's preview:
 * `Libera Terminal para todos os bots quando o campo command é exatamente “git status”.`
 * A rule with no condition says plainly that it covers ANY use of the tool.
 */
export function ruleSentence(
  rule: Pick<ApprovalRule, "effect" | "tool" | "botId" | "matchers">,
  context: RuleContext = {},
): string {
  const verb = rule.effect === "allow" ? "Libera" : "Proíbe";
  const tool = toolTitle(rule.tool, context.connectors ?? []);
  const when =
    rule.matchers.length === 0
      ? "em QUALQUER uso da ferramenta, com quaisquer argumentos"
      : `quando ${matchersText(rule.matchers)}`;
  return `${verb} ${tool} para ${whoText(rule.botId, context.botName)} ${when}.`;
}

/** The line under the effect in the list of rules: what wins over what. */
export const RULE_PRECEDENCE =
  "Quem proíbe vale mais do que quem libera. Entre regras do mesmo efeito, a de um bot vem antes da que vale para todos.";

export const EFFECT_LABEL: Record<"allow" | "deny", string> = { allow: "Libera", deny: "Proíbe" };

// -------------------------------------------------------- message (outbound)

/**
 * What "Permitir destinatário" will create, in plain words, before the person confirms: the rule
 * pins exactly the recipient(s) of THIS call, for this bot (never "any use", never every bot).
 */
export function allowRecipientSentence(input: {
  botName: string;
  tool: string;
  recipients: readonly { field: string; value: string }[];
  connectors?: RuleContext["connectors"];
}): string {
  const tool = toolTitle(input.tool, input.connectors ?? []);
  const who = input.recipients.map((r) => `${r.field} = ${quote(r.value)}`).join(" e ");
  return `Passa a valer para o bot ${input.botName}: ${tool} envia sem perguntar só quando ${who}. Qualquer outro destinatário continua pedindo sua aprovação. Você pode apagar a regra em Configurações > Permissões.`;
}

/**
 * The one muted paragraph under the title: what the bot wants and why it is asking. A connector
 * also says that the content leaves this computer.
 */
export function instructionLine(
  botName: string,
  tool: string,
  connectorName: string | null,
): string {
  if (connectorName !== null) {
    return `${botName} quer usar o conector ${connectorName}. O conteúdo abaixo sai deste computador para um servidor externo.`;
  }
  return `${botName} quer ${toolVerb(tool)}.`;
}

export type CategoryIcon =
  | "terminal"
  | "file"
  | "web"
  | "memory"
  | "mail"
  | "connector"
  | "network"
  | "team"
  | "routine"
  | "generic";

export interface ToolCategory {
  /** The short word of the card's header: "Arquivo", "Terminal", "Web", the connector's name... */
  label: string;
  icon: CategoryIcon;
}

/**
 * The ONE vocabulary of tools in the chat: the same label and icon whether the tool shows as a
 * decision card, a decided approval or a row of what the bot did. Unknown tools are "Ferramenta".
 * `outbound` is the DECLARATION that the call is a message to another person (the approval's
 * `outbound`); the name or the text of a tool never says it.
 */
export function toolCategory(
  tool: string,
  connectors: readonly {
    name: string;
    tools?: readonly { name: string; tool: string }[] | null;
  }[] = [],
  outbound = false,
): ToolCategory {
  if (outbound) return { label: "Mensagem", icon: "mail" };
  const ref = parseConnectorTool(tool, connectors);
  if (ref !== null) return { label: ref.connector, icon: "connector" };
  switch (tool) {
    case NETWORK_TOOL:
      return { label: "Rede", icon: "network" };
    case "shell":
      return { label: "Terminal", icon: "terminal" };
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_files":
    case "search_files":
      return { label: "Arquivo", icon: "file" };
    case "web_fetch":
    case "web_search":
    case "web_read":
      return { label: "Web", icon: "web" };
    case "remember":
    case "recall":
    case "forget":
    case "search_conversations":
      return { label: "Memória", icon: "memory" };
    case "delegate":
    case "team_recall":
      return { label: "Equipe", icon: "team" };
    case "create_routine":
    case "update_routine":
    case "delete_routine":
    case "list_routines":
    case "update_routine_state":
      return { label: "Rotina", icon: "routine" };
    case "create_reminder":
      return { label: "Lembrete", icon: "routine" };
    default:
      return { label: "Ferramenta", icon: "generic" };
  }
}

const text = (args: unknown, key: string): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const oneLine = (value: string, max = 80): string => {
  const first = value.trim().split("\n")[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

/**
 * The bold title: what will happen, as a short sentence in Portuguese. The server's summary (which
 * may be in English) is the fallback for a tool this file does not know.
 */
export function approvalTitle(
  tool: string,
  args: unknown,
  summary: string,
  connectors: readonly {
    name: string;
    tools?: readonly { name: string; tool: string }[] | null;
  }[] = [],
): string {
  const ref = parseConnectorTool(tool, connectors);
  if (ref !== null) {
    return ref.tool === ""
      ? `Usar o conector ${ref.connector}`
      : `Usar ${ref.tool} no conector ${ref.connector}`;
  }
  const path = text(args, "path");
  switch (tool) {
    case NETWORK_TOOL: {
      const host = text(args, "host");
      return host === undefined ? "Acessar um host" : `Acessar ${oneLine(host)}`;
    }
    case "shell": {
      const command = text(args, "command");
      return command === undefined ? "Rodar um comando" : `Rodar ${oneLine(command)}`;
    }
    case "write_file":
      return path === undefined ? "Escrever um arquivo" : `Escrever ${path}`;
    case "edit_file":
      return path === undefined ? "Editar um arquivo" : `Editar ${path}`;
    case "read_file":
      return path === undefined ? "Ler um arquivo" : `Ler ${path}`;
    case "web_fetch": {
      const url = text(args, "url");
      return url === undefined ? "Acessar uma página" : `Acessar ${oneLine(url)}`;
    }
    case "web_read": {
      // A read that asks is always of an address that had not appeared in the run (docs/BUSCA.md):
      // the card says so and shows the WHOLE address, query string included, never cut.
      const url = text(args, "url");
      return url === undefined ? "Ler uma página nova" : `Ler uma página nova: ${url}`;
    }
    case "web_search": {
      const query = text(args, "query");
      return query === undefined ? "Buscar na web" : `Buscar “${oneLine(query)}” na web`;
    }
    case "remember":
      return "Salvar na memória";
    case "forget":
      return "Esquecer uma memória";
    default:
      return summary;
  }
}

function toolVerb(tool: string): string {
  switch (tool) {
    case "shell":
      return "rodar um comando";
    case "write_file":
      return "escrever um arquivo";
    case "edit_file":
      return "editar um arquivo";
    case "web_fetch":
      return "acessar uma página";
    case "web_read":
      return "ler uma página";
    case "web_search":
      return "buscar na web";
    case "forget":
      return "esquecer uma memória";
    case "remember":
      return "salvar na memória";
    default:
      return `usar ${toolLabel(tool).toLowerCase()}`;
  }
}

/** The host and the reason of a `request_network_access` call, from its arguments. */
export function networkRequestOf(
  tool: string,
  args: unknown,
): { host: string | undefined; reason: string | undefined } | null {
  if (tool !== NETWORK_TOOL) return null;
  return { host: text(args, "host"), reason: text(args, "reason") };
}

/** The one muted paragraph of the network card: the bot's own words, said to be the bot's. */
export function networkLede(botName: string, reason: string | undefined): string {
  return reason === undefined
    ? `${botName} pede acesso a este host e não disse o motivo.`
    : `Motivo dado pelo bot: “${reason}”`;
}

/** The muted note of the network card: how far an approval reaches. */
export const NETWORK_SCOPE_NOTE = "Aprovar vale só para esta execução.";

/** "Expira em 12 min", "Expira em 40 s", "Expirou": the time left on a card that expires. */
export function expiryText(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left)) return "";
  if (left <= 0) return "O prazo acabou";
  const seconds = Math.ceil(left / 1000);
  if (seconds < 60) return `Expira em ${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `Expira em ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `Expira em ${hours} h${rest === 0 ? "" : ` ${rest} min`}`;
}
