// Owns the lines the worker and the reader container exchange: one JSON object per line, over the
// stdin and stdout of a long-lived `docker exec -i <container> node serve.js`. No port is opened
// anywhere: the container has no listener at all, and the worker reaches it with the Docker socket
// it already has (the same way it runs the bots' commands).
import type { WebReadOutcome } from "@suup/core";
import { z } from "zod";

export const readRequestLine = z.object({
  id: z.number().int().nonnegative(),
  op: z.literal("read"),
  url: z.string().min(1).max(4000),
  render: z.boolean().optional(),
});
export type ReadRequestLine = z.infer<typeof readRequestLine>;

export interface ReadyLine {
  op: "ready";
  version: string;
  renderAvailable: boolean;
}

export interface ReadResponseLine {
  id: number;
  op: "read";
  outcome: WebReadOutcome;
}
