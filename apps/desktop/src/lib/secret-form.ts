import {
  type AnswerSecretRequestResult,
  ApiError,
  SECRET_NAME,
  type Secret,
  type SuupClient,
} from "@suup/api";

// The secure form's side of the network. A credential the person types goes from the field to the
// server and nowhere else: this file never stores it, never logs it, and never lets it into a
// message the screen shows (a refusal of the server is cleaned of it first). The result carries
// only names and metadata. The callers keep no copy: the field is read once, cleared, and forgotten.

type Vault = Pick<SuupClient["vault"], "answerRequest" | "set">;

export const MIN_SECRET = 8;
export const MAX_SECRET = 16_384;

/** The text with every occurrence of the value (and of its trimmed form) taken out. */
export function scrubSecret(text: string, value: string): string {
  let clean = text;
  for (const needle of new Set([value, value.trim()])) {
    if (needle.length > 0) clean = clean.split(needle).join("[valor omitido]");
  }
  return clean;
}

/** What is wrong with the value as typed, without ever repeating it. */
export function valueProblem(value: string): string | undefined {
  if (value.length < MIN_SECRET) return `O valor precisa ter pelo menos ${MIN_SECRET} caracteres.`;
  if (value.length > MAX_SECRET) return `O valor passa de ${MAX_SECRET} caracteres.`;
  return undefined;
}

export type SecretOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; message: string; conflict: boolean };

function failure(error: unknown, value: string): { ok: false; message: string; conflict: boolean } {
  if (error instanceof ApiError) {
    if (error.code === "conflict") {
      return {
        ok: false,
        conflict: true,
        message: "A execução não está mais esperando este segredo.",
      };
    }
    return { ok: false, conflict: false, message: scrubSecret(error.message, value) };
  }
  return {
    ok: false,
    conflict: false,
    message: "Não foi possível enviar o segredo. Tente de novo.",
  };
}

/**
 * Answers the bot's request: the value goes straight to the vault through the answer endpoint, the
 * run goes on, and the bot is told only that the secret is available. Never throws.
 */
export async function answerSecretRequest(
  vault: Pick<Vault, "answerRequest">,
  runId: string,
  input: { value: string } | { declined: true },
): Promise<SecretOutcome<AnswerSecretRequestResult>> {
  const value = "value" in input ? input.value : "";
  if ("value" in input) {
    const problem = valueProblem(input.value);
    if (problem !== undefined) return { ok: false, conflict: false, message: problem };
  }
  try {
    const result = await vault.answerRequest(runId, input);
    return { ok: true, result };
  } catch (error) {
    return failure(error, value);
  }
}

export function nameProblem(name: string): string | undefined {
  if (name === "") return "Dê um nome ao segredo.";
  if (!SECRET_NAME.test(name)) {
    return "Use letras maiúsculas, números e sublinhado, começando por letra (ex.: GITHUB_TOKEN).";
  }
  return undefined;
}

/** Creates or replaces a secret from the Vault screen. The answer is the metadata, never the value. */
export async function writeSecret(
  vault: Pick<Vault, "set">,
  name: string,
  input: { value: string; description?: string; grantBotIds?: string[] },
): Promise<SecretOutcome<Secret>> {
  const problem = nameProblem(name) ?? valueProblem(input.value);
  if (problem !== undefined) return { ok: false, conflict: false, message: problem };
  try {
    const result = await vault.set(name, {
      value: input.value,
      ...(input.description === undefined || input.description === ""
        ? {}
        : { description: input.description }),
      ...(input.grantBotIds === undefined || input.grantBotIds.length === 0
        ? {}
        : { grantBotIds: input.grantBotIds }),
    });
    return { ok: true, result };
  } catch (error) {
    return failure(error, input.value);
  }
}
