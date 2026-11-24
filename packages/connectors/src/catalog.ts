// Owns the GALLERY of connectors: a short list of services the owner approved, each declared as
// plain data (how to reach the server, how to log in, which hosts it talks to, which of its tools
// are only reads, what the person must know before connecting). Nothing here is guessed from a
// name or a text: an entry is what it declares, and the list changes only by changing this file
// (docs/CONECTORES.md, "Galeria"; research: docs/pesquisas/fase-4-conectores-galeria-oauth-composio.md).
//
// An entry never runs an arbitrary command: the transport is fixed here. The bot can only PROPOSE
// an entry by its exact id (`propose_connector`), and a person approves it on a card.
import type { ConnectorTransport } from "./spec.js";

/**
 * How a person connects:
 * - `oauth`: the OAuth of the MCP protocol (discovery, PKCE S256, `resource`), in the browser. One
 *   click when the server accepts a client it does not know yet (registration).
 * - `token`: a token the person creates on the service and types in the secure form; it goes to
 *   the vault and is sent as an HTTP header.
 * - `oauth_owner_client`: the service needs an OAuth app of the owner's own (a step-by-step guide).
 */
export type CatalogAuth =
  | { kind: "oauth"; scopes?: readonly string[] | undefined }
  | {
      kind: "token";
      /** The vault secret the token is kept in (one per entry). */
      secret: string;
      /** The HTTP header it is sent in, and the text before it (`Bearer `). */
      header: string;
      prefix?: string | undefined;
      /** Where the person creates the token, step by step (pt-BR). */
      steps: readonly string[];
    }
  | { kind: "oauth_owner_client"; steps: readonly string[] };

export type CatalogAuthKind = CatalogAuth["kind"];

export interface CatalogEntry {
  /** Also the name of the connector it creates. */
  id: string;
  /** The service's name, as people know it. */
  name: string;
  /** One line, pt-BR: what the bot can do with it. */
  description: string;
  /** The official page of the server (documentation or repository). */
  source: string;
  /** The licence of the server's code, or what is known of it. */
  license: string;
  /** A Simple Icons slug (CC0) the app may draw to identify the service; `null`: a generic icon. */
  icon: string | null;
  /**
   * `ready`: it can be installed. `unverified`: shown with its notes so the owner sees it is
   * planned, but it cannot be installed until a primary source confirms how to reach it.
   */
  availability: "ready" | "unverified";
  /** Why it cannot be installed yet (only when `unverified`). */
  unverifiedReason?: string | undefined;
  /** How to reach the server. `null` when that is what is not verified yet. */
  transport: ConnectorTransport | null;
  auth: CatalogAuth;
  /** The exact host names it talks to (for the network allowlist and docs/REDE.md). */
  egressHosts: readonly string[];
  /** Tools that only read, by their EXACT name on the server: they run without a card. */
  readTools: readonly string[];
  /** Tools that change something, by exact name: they always ask (the default, said out loud). */
  writeTools: readonly string[];
  /**
   * What the person should know, in plain pt-BR, one short friendly sentence each (the owner,
   * 23/11/2026: "a ideia é ser friendly"): a limit of the plan, what the bot can do. The technical
   * facts behind them (which server, what was not verified, where it came from) are comments here
   * and in docs/CONECTORES.md, never on the screen.
   */
  notes: readonly string[];
  /**
   * A third party keeps your logins and sees your data: shown before connecting, in ONE friendly
   * sentence (pt-BR).
   */
  disclosure?: string | undefined;
  /** When this entry was last checked against its sources. */
  checkedAt: string;
}

const CHECKED = "2026-11-23";
const RESEARCH = "docs/pesquisas/fase-4-conectores-galeria-oauth-composio.md";

/**
 * The gallery. Higgsfield is NOT here: its endpoint, authentication, licence and price could not
 * be read in any primary source, and its tools spend credits (research, "Higgsfield").
 */
export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Ler repositórios, arquivos, issues, pull requests e versões (somente leitura).",
    source: "https://github.com/github/github-mcp-server",
    license: "MIT",
    icon: "github",
    availability: "ready",
    // The official remote server, read-only by its own URL (`/readonly`): a first layer before the
    // grants of the Suup. The one-click OAuth of GitHub needs an OAuth app of each host (remote) or
    // a callback port published into the container (local image): see docs/CONECTORES.md.
    transport: {
      kind: "http",
      url: "https://api.githubcopilot.com/mcp/readonly",
      headers: { Authorization: { secret: "GITHUB_TOKEN", prefix: "Bearer " } },
    },
    auth: {
      kind: "token",
      secret: "GITHUB_TOKEN",
      header: "Authorization",
      prefix: "Bearer ",
      steps: [
        "No GitHub, abra Settings > Developer settings > Personal access tokens > Fine-grained tokens.",
        "Crie um token só com os repositórios que o bot pode ler e permissão de leitura (Contents, Issues, Pull requests, Metadata).",
        "Copie o token e cole aqui. Ele vai para o cofre; o bot nunca vê o valor.",
      ],
    },
    egressHosts: ["api.githubcopilot.com"],
    // Names of the official server's read tools as it lists them (observed 23/11/2026; the
    // research did not list them). A name the server does not have is harmless: nothing matches.
    readTools: [
      "get_me",
      "get_file_contents",
      "list_branches",
      "list_commits",
      "get_commit",
      "list_tags",
      "get_tag",
      "list_releases",
      "get_latest_release",
      "get_release_by_tag",
      "list_issues",
      "issue_read",
      "list_pull_requests",
      "pull_request_read",
      "get_label",
    ],
    writeTools: [],
    // The official remote server in read-only mode (/readonly): write tools do not even appear.
    // A personal token (PAT): the remote server only takes the OAuth of apps each client registered.
    notes: ["Seus bots só leem no GitHub: nada é mudado por lá."],
    checkedAt: CHECKED,
  },
  {
    id: "notion",
    name: "Notion",
    description: "Buscar, ler e editar páginas e bancos do seu Notion, com as suas permissões.",
    source: "https://github.com/makenotion/notion-mcp-server",
    license: "MIT (o servidor local; o remoto é um serviço do Notion)",
    icon: "notion",
    availability: "ready",
    transport: { kind: "http", url: "https://mcp.notion.com/mcp", headers: {} },
    auth: { kind: "oauth" },
    egressHosts: ["mcp.notion.com"],
    readTools: [],
    writeTools: [],
    // The official remote server (the local one is no longer maintained). Not verified: whether
    // Notion accepts the dynamic registration of a new client. The tools were not checked by name:
    // all of them ask until the person marks the ones that only read.
    notes: ["Antes de mudar algo no seu Notion, o bot pede a sua aprovação."],
    checkedAt: CHECKED,
  },
  {
    id: "linear",
    name: "Linear",
    description: "Ler e atualizar issues, projetos e ciclos do Linear.",
    source: "https://mcp.linear.app/mcp",
    license: "Serviço do Linear (não verificado)",
    icon: "linear",
    availability: "ready",
    transport: { kind: "http", url: "https://mcp.linear.app/mcp", headers: {} },
    auth: { kind: "oauth" },
    egressHosts: ["mcp.linear.app"],
    readTools: [],
    writeTools: [],
    // Not verified: the address and the OAuth come from another project's observation (Hermes), not
    // from a page of Linear. Every tool asks until the person marks the ones that only read.
    notes: ["Antes de mudar algo no seu Linear, o bot pede a sua aprovação."],
    checkedAt: CHECKED,
  },
  {
    id: "figma",
    name: "Figma",
    description:
      "Ler arquivos, componentes e variáveis do Figma para transformar desenho em código.",
    source: "https://github.com/figma/mcp-server-guide",
    license: "Termos de desenvolvedor do Figma (licença do servidor não verificada)",
    icon: "figma",
    availability: "ready",
    transport: { kind: "http", url: "https://mcp.figma.com/mcp", headers: {} },
    auth: { kind: "oauth" },
    egressHosts: ["mcp.figma.com"],
    readTools: [],
    writeTools: [],
    // The limit is for the Starter plan, or a View or Collab seat. The login may be refused: per
    // another project, Figma only accepts the registration of some clients by name; Suup always
    // introduces itself by its own name, never another's.
    notes: ["No plano grátis do Figma são 6 usos por mês."],
    checkedAt: CHECKED,
  },
  {
    id: "stackoverflow",
    name: "Stack Overflow",
    description: "Buscar perguntas e respostas do Stack Overflow com a sua conta.",
    source: "https://github.com/StackExchange/stack-mcp",
    license: "Não informada no repositório",
    icon: "stackoverflow",
    availability: "unverified",
    unverifiedReason:
      // The address of the server and the login are in documentation that could not be read.
      "Ainda estamos conferindo como entrar. Enquanto isso, a busca do Suup já encontra respostas do Stack Overflow.",
    transport: null,
    auth: { kind: "oauth" },
    egressHosts: [],
    readTools: [],
    writeTools: [],
    notes: ["Em teste no Stack Overflow: até 100 usos por dia."],
    checkedAt: CHECKED,
  },
  {
    id: "google-workspace",
    name: "Google Workspace",
    description: "Gmail, Agenda, Drive, Documentos e Planilhas com um app OAuth seu.",
    source: "https://github.com/gemini-cli-extensions/workspace",
    license: "Apache-2.0",
    icon: "google",
    availability: "unverified",
    unverifiedReason:
      // The open Google Workspace server runs as an extension of the Gemini CLI (cloning the
      // repository) and keeps the login in the system keychain: no checked way to run it in Suup's
      // container yet.
      "Ainda estamos preparando um jeito seguro de ligar o Google aos seus bots.",
    transport: null,
    auth: {
      kind: "oauth_owner_client",
      steps: [
        "No Google Cloud Console, crie um projeto só para o Suup.",
        "Ative as APIs que vai usar (Gmail, Calendar, Drive, Docs, Sheets).",
        "Em Tela de consentimento OAuth, escolha o tipo Externo, deixe em modo de teste e adicione a sua conta em Usuários de teste.",
        "Em Credenciais, crie um ID do cliente OAuth do tipo App para computador.",
        "Guarde o ID e a chave secreta do cliente: quando o conector estiver pronto, eles vão para o cofre pelo formulário seguro.",
      ],
    },
    egressHosts: [],
    readTools: [],
    writeTools: [],
    // An app in test mode serves only you and the test users, with a limit of about 25 scopes.
    // The server can read, change and delete data of the account: every tool asks before running.
    notes: ["Antes de mudar algo na sua conta Google, o bot pede a sua aprovação."],
    checkedAt: CHECKED,
  },
  {
    id: "composio",
    name: "Composio",
    description: "Mais de mil apps por um só conector hospedado (opcional, de terceiros).",
    source: "https://github.com/ComposioHQ/composio",
    license: "SDK MIT (ISC no npm); a plataforma é um serviço hospedado",
    icon: null,
    availability: "ready",
    transport: {
      kind: "http",
      url: "https://connect.composio.dev/mcp",
      headers: { "x-consumer-api-key": { secret: "COMPOSIO_API_KEY" } },
    },
    auth: {
      kind: "token",
      secret: "COMPOSIO_API_KEY",
      header: "x-consumer-api-key",
      steps: [
        "Crie uma conta na Composio e gere uma chave de API no painel dela.",
        "Cole a chave aqui. Ela vai para o cofre; o bot nunca vê o valor.",
      ],
    },
    egressHosts: ["connect.composio.dev"],
    // Its tools are generic meta-tools (discover, authorize, run any app): none is a plain read.
    readTools: [],
    writeTools: [],
    // The tools are generic (discover, authorize and run any app): all of them ask. Price, free plan
    // and data policy of Composio were not verified. A third party: the logins of the apps and the
    // data through them live in Composio's cloud, and the OAuth apps are Composio's (its name is on
    // the consent screen, not Suup's); Suup keeps only the Composio key, in the vault.
    notes: ["Antes de usar qualquer app pelo Composio, o bot pede a sua aprovação."],
    disclosure: "Pelo Composio, seus logins ficam guardados na nuvem deles.",
    checkedAt: CHECKED,
  },
];

/** The entry with exactly this id, or `undefined`. */
export function catalogEntry(id: string): CatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((e) => e.id === id);
}

/** Where the facts of the gallery come from. */
export const CATALOG_RESEARCH = RESEARCH;

/**
 * The tool overrides an installed entry starts with: its read tools marked `read` (they run
 * without a card) and its write tools marked `external_irreversible` (they always ask), by exact
 * name. Every other tool keeps the default of a connector tool: it asks.
 */
export function catalogToolOverrides(
  entry: CatalogEntry,
): Record<string, { risk: "read" | "external_irreversible" }> {
  const out: Record<string, { risk: "read" | "external_irreversible" }> = {};
  for (const name of entry.readTools) out[name] = { risk: "read" };
  for (const name of entry.writeTools) out[name] = { risk: "external_irreversible" };
  return out;
}
