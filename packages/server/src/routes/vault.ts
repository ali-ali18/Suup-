import { answerSecretRequestBodySchema, secretNameSchema, setSecretBodySchema } from "@suup/api";
import { type Db, getBot, getRun, getSecretMeta, type SecretMeta } from "@suup/db";
import { answerSecretRequest, pendingSecretRequest } from "@suup/runtime";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import { toSecretDto } from "../mappers.js";

function nameOf(raw: string): string {
  const parsed = secretNameSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError("not_found", "Segredo não encontrado.");
  return parsed.data;
}

/** The secret as the owner manages it: one a connector keeps (its login) is as good as absent. */
async function ownedMeta(db: Db, name: string): Promise<SecretMeta> {
  const meta = await getSecretMeta(db, name);
  if (meta === null || meta.managedBy !== null) {
    throw new HttpError("not_found", "Segredo não encontrado.");
  }
  return meta;
}

export const vaultRoutes: Route[] = [
  {
    // Can the server write secrets? (the section is configured and the key is present and valid)
    method: "GET",
    pattern: "/v1/vault",
    async handler(ctx) {
      const { configured, ok, keyEnv, reason } = ctx.runtime.vault.status();
      return { body: { configured, ok, keyEnv, reason } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/secrets",
    async handler(ctx) {
      const secrets = await ctx.runtime.vault.list();
      return { body: { items: secrets.map(toSecretDto) } };
    },
  },
  {
    // Write-only: the value goes in, and nothing in the API ever brings it back.
    method: "PUT",
    pattern: "/v1/secrets/:name",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const body = ctx.body(setSecretBodySchema);
      const { vault, db } = ctx.runtime;
      for (const botId of body.grantBotIds ?? []) {
        if ((await getBot(db, botId)) === null) {
          throw new HttpError("invalid_request", `grantBotIds: bot ${botId} não encontrado.`);
        }
      }
      await vault.set(name, body.value, {
        ...(body.description === undefined ? {} : { description: body.description }),
      });
      for (const botId of body.grantBotIds ?? []) await vault.grant(name, botId);
      return { body: toSecretDto(await ownedMeta(db, name)) };
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/secrets/:name",
    async handler(ctx) {
      const gone = await ctx.runtime.vault.remove(nameOf(ctx.params.name ?? ""));
      if (!gone) throw new HttpError("not_found", "Segredo não encontrado.");
      return { body: { deleted: true } };
    },
  },
  {
    method: "PUT",
    pattern: "/v1/secrets/:name/grants/:botId",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const botId = ctx.uuid("botId");
      const { vault, db } = ctx.runtime;
      if ((await getBot(db, botId)) === null)
        throw new HttpError("not_found", "Bot não encontrado.");
      await vault.grant(name, botId);
      return { body: toSecretDto(await ownedMeta(db, name)) };
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/secrets/:name/grants/:botId",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const { vault, db } = ctx.runtime;
      await ownedMeta(db, name);
      await vault.revoke(name, ctx.uuid("botId"));
      return { body: toSecretDto(await ownedMeta(db, name)) };
    },
  },
  {
    method: "GET",
    pattern: "/v1/runs/:id/secret-request",
    async handler(ctx) {
      const id = ctx.uuid("id");
      if ((await getRun(ctx.runtime.db, id)) === null) {
        throw new HttpError("not_found", "Execução não encontrada.");
      }
      return { body: { request: await pendingSecretRequest(ctx.runtime, id) } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/runs/:id/secret-request/answer",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(answerSecretRequestBodySchema);
      if ((await getRun(ctx.runtime.db, id)) === null) {
        throw new HttpError("not_found", "Execução não encontrada.");
      }
      if (body.value === undefined && body.declined !== true) {
        throw new HttpError("invalid_request", "Informe value ou declined: true.");
      }
      return { body: await answerSecretRequest(ctx.runtime, id, body) };
    },
  },
];
