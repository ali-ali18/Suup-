import { z } from "zod";

/** A date on the wire: an ISO 8601 string in UTC, e.g. `2026-11-18T20:13:08.123Z`. */
export const isoDate = z.iso.datetime();
export const uuid = z.uuid();

/** Query values arrive as text: these read them. */
export const intQuery = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
export const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");
/** `a,b,c` into a list (empty items dropped). */
export const csvQuery = z.string().transform((v) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== ""),
);

export const jsonRecord = z.record(z.string(), z.unknown());

/** A page of a list. `hasMore` says whether another page exists in the direction that was asked. */
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), hasMore: z.boolean() });
/** A list with no pages. */
export const list = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });
