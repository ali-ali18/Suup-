// Owns the shape of a connector's configuration as the rest of the system hands it over, and its
// validation. It is plain data: no secret values (only references to vault secrets by name), no
// connection, no database. The same rules run when the API or the CLI saves a connector and when a
// worker is about to use it, so a row edited by hand in the database is checked too.
import { isRiskLevel, isSecretName, type RiskLevel } from "@suup/core";
import { z } from "zod";
import { CONNECTOR_NAME_MAX, isConnectorName } from "./names.js";

export const CONNECTOR_SCOPES = ["read_only", "read_write"] as const;
export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number];

/** A value that is either literal text or a reference to a vault secret (by name). */
export type ValueRef = string | { secret: string; prefix?: string | undefined };

export type ConnectorTransport =
  | {
      kind: "stdio";
      /** The executable ONLY (no shell string): arguments go in `args`. */
      command: string;
      args: string[];
      /** Declared environment variables of the child process: the only ones it gets besides the safe defaults. */
      env: Record<string, ValueRef>;
      cwd?: string | undefined;
    }
  | {
      kind: "http";
      url: string;
      headers: Record<string, ValueRef>;
    };

export interface ToolOverride {
  /** What the user says this tool is. Hints from the server can only make it stricter. */
  risk: RiskLevel;
}

export interface ConnectorSpec {
  name: string;
  transport: ConnectorTransport;
  scope: ConnectorScope;
  /** By the tool's name on the server. */
  tools: Record<string, ToolOverride>;
  /** The user trusts this server's `readOnlyHint`: a tool that says it only reads counts as `read`. */
  trustAnnotations: boolean;
  /** How long one call may take. */
  timeoutMs: number;
  /** Changes whenever the stored connector changes: a connection opened on an older one is dropped. */
  version: string;
}

export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const MIN_CALL_TIMEOUT_MS = 1_000;
export const MAX_CALL_TIMEOUT_MS = 600_000;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish", "csh", "tcsh"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// RFC 9110 token characters.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
// Names the process would misuse if a connector could set them (code injection into any child).
const FORBIDDEN_ENV = /^(LD_.*|DYLD_.*|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|BASH_ENV|ENV|PATH)$/i;

const valueRefSchema = z.union([
  z.string().max(4096),
  z.strictObject({
    secret: z.string().refine(isSecretName, "nome de segredo inválido"),
    prefix: z.string().max(32).optional(),
  }),
]);

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";

const httpUrl = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "URL inválida" });
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      ctx.addIssue({ code: "custom", message: "use uma URL http(s)" });
      return;
    }
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({
        code: "custom",
        message: "não ponha usuário nem senha na URL: use um cabeçalho com um segredo do cofre",
      });
    }
    if (url.protocol === "http:" && !isLoopback(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        message:
          "http sem criptografia só é aceito para localhost; use https (credenciais e resultados passariam em claro)",
      });
    }
  });

const stdioSchema = z.strictObject({
  kind: z.literal("stdio"),
  command: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (v) => !/\s/.test(v),
      "command é só o executável (sem espaços): ponha os argumentos em args",
    )
    .refine((v) => !v.includes("\0"), "command inválido"),
  args: z
    .array(
      z
        .string()
        .max(4096)
        .refine((v) => !v.includes("\0"), "argumento inválido"),
    )
    .max(64)
    .default([]),
  env: z.record(z.string(), valueRefSchema).default({}),
  cwd: z.string().min(1).max(1024).optional(),
});

const httpSchema = z.strictObject({
  kind: z.literal("http"),
  url: httpUrl,
  headers: z.record(z.string(), valueRefSchema).default({}),
});

export const connectorTransportSchema = z
  .discriminatedUnion("kind", [stdioSchema, httpSchema])
  .superRefine((t, ctx) => {
    if (t.kind === "stdio") {
      const base = t.command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
      if (SHELLS.has(base) && t.args.some((a) => a === "-c" || /^-[a-z]*c[a-z]*$/.test(a))) {
        ctx.addIssue({
          code: "custom",
          path: ["command"],
          message:
            "um shell com -c executa um texto como comando (interpolação): configure o servidor MCP diretamente, com o executável e os argumentos",
        });
      }
      for (const name of Object.keys(t.env)) {
        if (!ENV_NAME.test(name)) {
          ctx.addIssue({
            code: "custom",
            path: ["env", name],
            message: "nome de variável inválido",
          });
        } else if (FORBIDDEN_ENV.test(name)) {
          ctx.addIssue({
            code: "custom",
            path: ["env", name],
            message: `a variável ${name} não pode ser definida por um conector (injeta código ou muda o PATH)`,
          });
        }
      }
    } else {
      for (const name of Object.keys(t.headers)) {
        if (!HEADER_NAME.test(name)) {
          ctx.addIssue({
            code: "custom",
            path: ["headers", name],
            message: "nome de cabeçalho inválido",
          });
        }
      }
    }
  });

export const connectorNameSchema = z
  .string()
  .max(CONNECTOR_NAME_MAX)
  .refine(
    isConnectorName,
    "use letras minúsculas e números, separados por hífen (ex.: github, meu-erp), até 24 caracteres",
  );

/** Tool names on the server are free text; this only bounds the keys of the overrides. */
const toolOverridesSchema = z
  .record(
    z.string().min(1).max(128),
    z.strictObject({ risk: z.string().refine(isRiskLevel, "nível de risco inválido") }),
  )
  .default({})
  .refine((o) => Object.keys(o).length <= 200, "overrides demais");

export const connectorSpecSchema = z.strictObject({
  name: connectorNameSchema,
  transport: connectorTransportSchema,
  scope: z.enum(CONNECTOR_SCOPES).default("read_write"),
  tools: toolOverridesSchema,
  trustAnnotations: z.boolean().default(false),
  timeoutMs: z
    .number()
    .int()
    .min(MIN_CALL_TIMEOUT_MS)
    .max(MAX_CALL_TIMEOUT_MS)
    .default(DEFAULT_CALL_TIMEOUT_MS),
  version: z.string().max(64).default("0"),
});

/** The error `parseConnectorSpec` throws: a message for the person, in Portuguese. */
export class ConnectorConfigError extends Error {
  override readonly name = "ConnectorConfigError";
}

/** Validates (and fills the defaults of) a connector. Throws `ConnectorConfigError`. */
export function parseConnectorSpec(input: unknown): ConnectorSpec {
  const parsed = connectorSpecSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.length === 0 ? "(conector)" : i.path.join(".")}: ${i.message}`);
    throw new ConnectorConfigError(`Configuração de conector inválida: ${lines.join("; ")}`);
  }
  return parsed.data as ConnectorSpec;
}

/** The names of the vault secrets a connector refers to. */
export function secretNamesOf(spec: ConnectorSpec): string[] {
  const refs =
    spec.transport.kind === "stdio"
      ? Object.values(spec.transport.env)
      : Object.values(spec.transport.headers);
  return [...new Set(refs.flatMap((r) => (typeof r === "string" ? [] : [r.secret])))].sort();
}
