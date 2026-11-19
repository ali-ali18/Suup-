import {
  CONNECTOR_NAME,
  type ConnectorTool,
  type CreateConnectorBody,
  type ValueRef,
} from "@suup/api";

// The "Adicionar conector" form as data, and the checks that turn it into the body the API takes.
// The server checks again (and its refusals are shown next to the form); these checks only catch the
// obvious mistakes before the round trip, in words a person can act on. A credential is never typed
// here: an environment variable or a header is plain text, or a reference to a vault secret by NAME.

export type RefMode = "text" | "secret";

/** One environment variable or header: a name, and a text or a secret of the vault. */
export interface RefRow {
  /** Only for React keys. */
  id: string;
  key: string;
  mode: RefMode;
  text: string;
  secret: string;
  /** Put before the secret's value (the `Bearer ` of an Authorization header). */
  prefix: string;
}

export interface ConnectorForm {
  kind: "stdio" | "http";
  name: string;
  description: string;
  /** stdio: the executable only. */
  command: string;
  /** stdio: one argument per line. */
  argsText: string;
  env: RefRow[];
  /** http. */
  url: string;
  headers: RefRow[];
  scope: "read_only" | "read_write";
  /** In seconds; empty: the server's default. */
  timeoutSec: string;
  grantBotIds: string[];
}

let rowId = 0;
export const emptyRow = (over: Partial<RefRow> = {}): RefRow => ({
  id: `row-${++rowId}`,
  key: "",
  mode: "text",
  text: "",
  secret: "",
  prefix: "",
  ...over,
});

export const emptyForm = (kind: ConnectorForm["kind"] = "stdio"): ConnectorForm => ({
  kind,
  name: "",
  description: "",
  command: "",
  argsText: "",
  env: [],
  url: "",
  headers: [],
  scope: "read_only",
  timeoutSec: "",
  grantBotIds: [],
});

/** `Authorization: Bearer <secret>`: the usual header of an HTTP connector. */
export const bearerRow = (secret: string): RefRow =>
  emptyRow({ key: "Authorization", mode: "secret", secret, prefix: "Bearer " });

export type FormErrors = Partial<
  Record<"name" | "command" | "args" | "env" | "url" | "headers" | "timeout", string>
>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** The arguments as the list the server takes: one per non-empty line. */
export const argsOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");

function refsOf(
  rows: readonly RefRow[],
  namePattern: RegExp,
  noun: string,
  secrets: readonly string[],
): { ok: true; refs: Record<string, ValueRef> } | { ok: false; error: string } {
  const refs: Record<string, ValueRef> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") return { ok: false, error: `Dê um nome a cada ${noun}.` };
    if (!namePattern.test(key))
      return { ok: false, error: `“${key}” não é um nome válido de ${noun}.` };
    if (key in refs) return { ok: false, error: `“${key}” aparece duas vezes.` };
    if (row.mode === "secret") {
      if (row.secret === "") return { ok: false, error: `Escolha o segredo de “${key}”.` };
      if (!secrets.includes(row.secret)) {
        return { ok: false, error: `O segredo ${row.secret} não existe no cofre.` };
      }
      refs[key] =
        row.prefix === "" ? { secret: row.secret } : { secret: row.secret, prefix: row.prefix };
    } else {
      if (row.text === "") return { ok: false, error: `Escreva o valor de “${key}”.` };
      refs[key] = row.text;
    }
  }
  return { ok: true, refs };
}

export type BuildResult =
  | { ok: true; body: CreateConnectorBody }
  | { ok: false; errors: FormErrors };

/** The body of `POST /v1/connectors` from the form, or what is wrong, field by field. */
export function buildCreateBody(form: ConnectorForm, secrets: readonly string[]): BuildResult {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (name === "") errors.name = "Dê um nome ao conector.";
  else if (name.length > 24 || !CONNECTOR_NAME.test(name)) {
    errors.name =
      "Use letras minúsculas e números, separados por hífen, até 24 caracteres (ex.: github).";
  }
  let transport: CreateConnectorBody["transport"] | undefined;
  if (form.kind === "stdio") {
    const command = form.command.trim();
    if (command === "") errors.command = "Diga qual programa rodar.";
    else if (/\s/.test(command)) {
      errors.command =
        "Só o programa, sem espaços nem argumentos: os argumentos vão na lista logo abaixo, um por linha.";
    }
    const args = argsOf(form.argsText);
    if (args.length > 64) errors.args = "No máximo 64 argumentos.";
    const env = refsOf(form.env, ENV_NAME, "variável", secrets);
    if (!env.ok) errors.env = env.error;
    if (errors.command === undefined && errors.args === undefined && env.ok) {
      transport = {
        kind: "stdio",
        command,
        ...(args.length === 0 ? {} : { args }),
        ...(Object.keys(env.refs).length === 0 ? {} : { env: env.refs }),
      };
    }
  } else {
    const url = form.url.trim();
    if (url === "") errors.url = "Informe o endereço do servidor.";
    else if (!/^https?:\/\/\S+$/i.test(url))
      errors.url = "O endereço começa com https:// (ou http://localhost).";
    const headers = refsOf(form.headers, HEADER_NAME, "cabeçalho", secrets);
    if (!headers.ok) errors.headers = headers.error;
    if (errors.url === undefined && headers.ok) {
      transport = {
        kind: "http",
        url,
        ...(Object.keys(headers.refs).length === 0 ? {} : { headers: headers.refs }),
      };
    }
  }
  let timeoutMs: number | undefined;
  if (form.timeoutSec.trim() !== "") {
    const seconds = Number(form.timeoutSec);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
      errors.timeout = "O tempo limite é um número inteiro de segundos, de 1 a 600.";
    } else timeoutMs = seconds * 1000;
  }
  if (Object.keys(errors).length > 0 || transport === undefined) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name,
      transport,
      scope: form.scope,
      ...(form.description.trim() === "" ? {} : { description: form.description.trim() }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(form.grantBotIds.length === 0 ? {} : { grantBotIds: form.grantBotIds }),
    },
  };
}

// ------------------------------------------------------------- tool risk

/** Where a tool's risk level came from, in plain words. */
export const RISK_BASIS_TEXT: Record<ConnectorTool["riskBasis"], string> = {
  default: "Padrão: pergunta antes de rodar.",
  user: "Definido por você.",
  trusted_hint: "Dica do servidor, em que você confia.",
  tightened_by_hint: "Apertado pelo servidor: ele diz que esta ferramenta escreve.",
  outbound: "Mensagem para outra pessoa, como você marcou: nunca roda sem perguntar.",
};

/** The recipient fields as typed ("to, cc") into the list the API takes; only commas separate them. */
export function parseRecipientFields(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    ),
  ];
}

export const TIGHTENED_HELP =
  "O servidor declara que a ferramenta escreve ou destrói, então ela não pode ser marcada como leitura. Para deixá-la rodar sem cartão, crie uma regra em Configurações > Aprovações (a regra é um ato seu, nunca do cartão).";

export const READ_WARNING =
  "Uma ferramenta marcada como leitura roda sem cartão de aprovação. Marque só o que você conhece.";

export const STDIO_WARNING =
  "Um conector de programa local roda no computador do servidor (onde o Suup trabalha), fora da máquina isolada dos bots, com as permissões do usuário que roda o Suup. Ele pode ler os seus arquivos e falar com a rede. Só instale servidores em que você confia.";

export const HTTP_WARNING =
  "Um conector HTTP recebe tudo o que o bot enviar a ele, e o servidor Suup fará as requisições a partir da rede dele. Só cadastre endereços em que você confia.";
