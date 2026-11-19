import { resendBodySchema } from "@suup/api";
import { getRun } from "@suup/db";
import { inspectModelRequest, replayRecordedRun, resendRecordedRequest } from "@suup/runtime";
import { z } from "zod";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";

const seqParam = z.coerce.number().int().min(0);

/** The Inspetor (PLANO 4.13): the same operations as `suup inspect --request`, `replay` and `resend`. */
export const diagnosticsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/runs/:id/requests/:seq",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const seq = seqParam.safeParse(ctx.params.seq);
      if (!seq.success) throw new HttpError("not_found", "Evento não encontrado.");
      const view = await inspectModelRequest(ctx.runtime.db, id, seq.data);
      return { body: view };
    },
  },
  {
    method: "POST",
    pattern: "/v1/runs/:id/replay",
    timeoutMs: 180_000,
    async handler(ctx) {
      const outcome = await replayRecordedRun(ctx.runtime, ctx.uuid("id"));
      return { body: outcome.view };
    },
  },
  {
    method: "POST",
    pattern: "/v1/runs/:id/resend",
    timeoutMs: 600_000,
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(resendBodySchema);
      if ((await getRun(ctx.runtime.db, id)) === null) {
        throw new HttpError("not_found", "Execução não encontrada.");
      }
      if (body.model !== undefined) {
        try {
          ctx.runtime.resolveModel(body.model);
        } catch (error) {
          throw new HttpError("invalid_request", `model: ${(error as Error).message}`, {
            cause: error,
          });
        }
      }
      const result = await resendRecordedRequest(ctx.runtime, {
        runId: id,
        seq: body.seq,
        ...(body.times === undefined ? {} : { times: body.times }),
        ...(body.model === undefined ? {} : { model: body.model }),
        signal: ctx.signal,
      });
      return { body: result };
    },
  },
];
