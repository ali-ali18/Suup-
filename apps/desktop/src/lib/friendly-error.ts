import { ApiError, type ClientErrorCode, type ErrorCode } from "@suup/api";

// What a person reads when something fails (docs/DESIGN.md §0, "Amigável"; the owner, 23/11/2026:
// "A gente tá colocando muita coisa de logs pro usuário... não quero isso, a ideia é ser
// friendly"). The sentence comes from the KIND of the error the API declares (`ApiError.code`,
// compared exactly), never from its text: the text of a server or a library is a log, and goes to
// the console (the server keeps its own log). Only the Inspector shows details.

/** The generic sentence, for an error with no declared kind. */
export const SOMETHING_WRONG = "Algo deu errado. Tenta de novo?";

/** One short sentence per kind of error the API declares. */
const BY_CODE: Record<ErrorCode | ClientErrorCode, string> = {
  network: "Não consegui falar com o servidor. Confira a conexão e tenta de novo.",
  invalid_response: "O servidor respondeu de um jeito que este app não entende. Atualize o app.",
  aborted: "Cancelado.",
  unauthorized: "O acesso ao servidor não vale mais. Conecte de novo.",
  origin_not_allowed: "Este servidor não aceita este app. Confira o endereço.",
  invalid_request: "Não deu certo com esses dados. Confira e tenta de novo.",
  not_found: "Isso não existe mais. Atualize a tela.",
  method_not_allowed: SOMETHING_WRONG,
  request_timeout: "Demorou demais para responder. Tenta de novo?",
  conflict: "Isso mudou enquanto você olhava. Atualize e tenta de novo.",
  payload_too_large: "É grande demais para enviar de uma vez.",
  unsupported_media_type: SOMETHING_WRONG,
  too_many_streams: "Há janelas demais abertas neste servidor. Feche alguma e tenta de novo.",
  provider_error: "O modelo não respondeu agora. Tenta de novo daqui a pouco?",
  internal_error: SOMETHING_WRONG,
  unavailable: "O servidor está indisponível agora. Tenta de novo daqui a pouco.",
};

/** The detail of an error goes to the log, never to the screen. */
function log(error: unknown): void {
  console.warn("[suup]", error);
}

/** The friendly sentence of a failure: by the declared kind, or the generic one. */
export function friendlyError(error: unknown): string {
  log(error);
  return error instanceof ApiError ? BY_CODE[error.code] : SOMETHING_WRONG;
}

/**
 * The same, but for a form the person filled: when the server REFUSES WHAT WAS TYPED (a value out
 * of range, a name already taken: `invalid_request` and `conflict`), its sentence is about the
 * person's own input, written for them in pt-BR by the API's contract, and is shown as it came.
 * Every other kind is the friendly sentence.
 */
export function formError(error: unknown): string {
  if (
    error instanceof ApiError &&
    (error.code === "invalid_request" || error.code === "conflict")
  ) {
    log(error);
    return error.message;
  }
  return friendlyError(error);
}
