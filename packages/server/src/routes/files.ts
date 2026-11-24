import { getFile } from "@suup/db";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";

/**
 * The files the bots hand to the chat (`send_file`, docs/API.md "Arquivos"). Behind the token like
 * every route; always a download (`Content-Disposition: attachment`), never shown inline.
 */
export const fileRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/files/:id",
    async handler(ctx) {
      const file = await getFile(ctx.runtime.db, ctx.uuid("id"));
      if (file === null) throw new HttpError("not_found", "Arquivo não encontrado.");
      return { body: null, file: { content: file.content, mime: file.mime, name: file.name } };
    },
  },
];
