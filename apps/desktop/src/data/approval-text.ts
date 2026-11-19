import type { ApprovalRule, ArgMatcher, RiskLevel } from "@suup/api";
import { exactFields } from "../lib/format-args.js";
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

export const OP_LABEL: Record<ArgMatcher["op"], string> = {
  equals: "é exatamente",
  starts_with: "começa com",
  contains: "contém",
  glob: "casa com o padrão",
};

const quote = (value: string): string => `“${value}”`;

/** `o campo command começa com “git ”`. */
export function matcherText(matcher: ArgMatcher): string {
  return `o campo ${matcher.field} ${OP_LABEL[matcher.op]} ${quote(matcher.value)}`;
}

/** All of them have to hold: `o campo a é exatamente “x” e o campo b contém “y”`. */
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
 * `Libera Terminal para todos os bots quando o campo command começa com “git ”.`
 */
export function ruleSentence(
  rule: Pick<ApprovalRule, "effect" | "tool" | "botId" | "matchers">,
  context: RuleContext = {},
): string {
  const verb = rule.effect === "allow" ? "Libera" : "Proíbe";
  const tool = toolTitle(rule.tool, context.connectors ?? []);
  const when =
    rule.matchers.length === 0 ? "em qualquer uso" : `quando ${matchersText(rule.matchers)}`;
  return `${verb} ${tool} para ${whoText(rule.botId, context.botName)} ${when}.`;
}

/** The line under the effect in the list of rules: what wins over what. */
export const RULE_PRECEDENCE =
  "Quem proíbe vale mais do que quem libera. Entre regras do mesmo efeito, a de um bot vem antes da que vale para todos.";

export const EFFECT_LABEL: Record<"allow" | "deny", string> = { allow: "Libera", deny: "Proíbe" };

// ---------------------------------------------------------- always allow

export type AlwaysScope = "bot" | "global";
export type AlwaysMatch = "exact" | "any";

/**
 * What "Aprovar e sempre permitir" will create, in plain words, before the person confirms. The
 * server builds the same rule: with `exact`, every top-level text argument must be equal to the ones
 * on the card (numbers and nested values stay free); with `any`, no condition at all.
 */
export function alwaysSentence(input: {
  scope: AlwaysScope;
  match: AlwaysMatch;
  botName: string;
  tool: string;
  args: unknown;
  connectors?: RuleContext["connectors"];
}): string {
  const who = input.scope === "bot" ? `o bot ${input.botName}` : "todos os bots";
  const tool = toolTitle(input.tool, input.connectors ?? []);
  const pinned = input.match === "exact" ? exactFields(input.args) : [];
  if (pinned.length === 0) {
    return `Passa a valer para ${who}: qualquer uso de ${tool} roda sem perguntar, com quaisquer argumentos. Você pode apagar a regra em Configurações > Aprovações.`;
  }
  const fields = pinned.map((f) => `${f.field} = ${quote(f.value)}`).join(" e ");
  return `Passa a valer para ${who}: ${tool} roda sem perguntar só quando ${fields}. Qualquer outro conteúdo continua pedindo sua aprovação. Você pode apagar a regra em Configurações > Aprovações.`;
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
  | "generic";

export interface ToolCategory {
  /** The short word of the card's header: "Arquivo", "Terminal", "Web", the connector's name... */
  label: string;
  icon: CategoryIcon;
}

const MAIL = /mail|smtp|imap|gmail|outlook/i;

/**
 * The ONE vocabulary of tools in the chat: the same label and icon whether the tool shows as a
 * decision card, a decided approval or a row of what the bot did. Unknown tools are "Ferramenta".
 */
export function toolCategory(
  tool: string,
  connectors: readonly {
    name: string;
    tools?: readonly { name: string; tool: string }[] | null;
  }[] = [],
): ToolCategory {
  const ref = parseConnectorTool(tool, connectors);
  if (ref !== null) {
    return MAIL.test(ref.tool)
      ? { label: "E-mail", icon: "mail" }
      : { label: ref.connector, icon: "connector" };
  }
  if (MAIL.test(tool)) return { label: "E-mail", icon: "mail" };
  switch (tool) {
    case "shell":
      return { label: "Terminal", icon: "terminal" };
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_files":
    case "search_files":
      return { label: "Arquivo", icon: "file" };
    case "web_fetch":
      return { label: "Web", icon: "web" };
    case "remember":
    case "recall":
    case "forget":
    case "search_conversations":
      return { label: "Memória", icon: "memory" };
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
    case "forget":
      return "esquecer uma memória";
    case "remember":
      return "salvar na memória";
    default:
      return `usar ${toolLabel(tool).toLowerCase()}`;
  }
}

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
