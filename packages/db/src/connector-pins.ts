// Owns the pinning of connector tool definitions (tables `connector_tool_pins`,
// `connector_pin_baselines` and `connector_tool_events`, migration 0014). A pin holds the
// fingerprint of the definition the USER approved and the one the server shows now. The comparison
// is exact equality of two hashes: a tool whose definition changed, or that showed up after the
// first listing, is not approved until a person reviews it. This module computes no fingerprint
// (that is `@suup/connectors`); it only keeps the state consistent and records what happened.
import type { Db } from "./client.js";
import { withTransaction } from "./client.js";

export type PinStatus = "approved" | "changed" | "new";

export interface ToolPin {
  /** The name on the server. */
  tool: string;
  status: PinStatus;
  approvedFingerprint: string | null;
  /** The definition the user approved (bounded, cleaned), `null` for a `new` tool. */
  approvedDefinition: unknown;
  approvedAt: Date | null;
  seenFingerprint: string;
  /** The definition the server shows now (bounded, cleaned). */
  seenDefinition: unknown;
  seenAt: Date;
}

/** One tool as the server listed it just now: its fingerprint and a bounded copy to show. */
export interface PinObservation {
  tool: string;
  fingerprint: string;
  definition: unknown;
}

export const PIN_EVENT_KINDS = [
  "baseline",
  "pinned_on_grant",
  "changed",
  "new",
  "restored",
  "approved",
] as const;
export type PinEventKind = (typeof PIN_EVENT_KINDS)[number];

export interface ConnectorToolEvent {
  id: string;
  connector: string;
  tool: string | null;
  kind: PinEventKind;
  fromFingerprint: string | null;
  toFingerprint: string | null;
  detail: string | null;
  createdAt: Date;
}

export class PinNotFoundError extends Error {
  override readonly name = "PinNotFoundError";
}

/** The tool changed again between the person looking at it and approving it. */
export class PinStaleError extends Error {
  override readonly name = "PinStaleError";
}

interface PinRow {
  tool: string;
  status: PinStatus;
  approved_fingerprint: string | null;
  approved_definition: unknown;
  approved_at: Date | null;
  seen_fingerprint: string;
  seen_definition: unknown;
  seen_at: Date;
}

const mapPin = (row: PinRow): ToolPin => ({
  tool: row.tool,
  status: row.status,
  approvedFingerprint: row.approved_fingerprint,
  approvedDefinition: row.approved_definition,
  approvedAt: row.approved_at,
  seenFingerprint: row.seen_fingerprint,
  seenDefinition: row.seen_definition,
  seenAt: row.seen_at,
});

export async function listPins(db: Db, connector: string): Promise<ToolPin[]> {
  const rows = await db.sql<PinRow[]>`
    select p.tool, p.status, p.approved_fingerprint, p.approved_definition, p.approved_at,
           p.seen_fingerprint, p.seen_definition, p.seen_at
    from connector_tool_pins p join connectors c on c.id = p.connector_id
    where c.name = ${connector} order by p.tool`;
  return rows.map(mapPin);
}

export interface ReconcileResult {
  pins: ToolPin[];
  /** What changed in this call: the events written. */
  events: { tool: string | null; kind: PinEventKind }[];
}

/**
 * Compares what the server lists NOW with the pins and writes the outcome, in one transaction.
 *
 * - The first listing of a connector is its baseline: every tool is pinned as approved (the user
 *   sees and trusts the connector at the time they add and grant it; documented in CONECTORES.md).
 * - A known tool whose fingerprint equals the approved one is `approved` (a tool that went away
 *   and came back identical, or one that was changed and changed back, is approved again).
 * - A known tool with another fingerprint is `changed`: the approval stays on record but the tool
 *   is disabled until `approvePin`.
 * - A tool never seen before, on a connector that already has a baseline, is `new`.
 * - A tool that is not listed is left as it was (nothing is deleted).
 */
export async function reconcilePins(
  db: Db,
  connector: string,
  observed: readonly PinObservation[],
): Promise<ReconcileResult> {
  return withTransaction(db, async (tx) => {
    const [row] = await tx.sql<{ id: string; baselined: boolean }[]>`
      select c.id, exists (select 1 from connector_pin_baselines b where b.connector_id = c.id) as baselined
      from connectors c where c.name = ${connector} for update of c`;
    const events: ReconcileResult["events"] = [];
    if (row === undefined) return { pins: [], events };
    const known = new Map(
      (
        await tx.sql<PinRow[]>`
          select tool, status, approved_fingerprint, approved_definition, approved_at,
                 seen_fingerprint, seen_definition, seen_at
          from connector_tool_pins where connector_id = ${row.id}`
      ).map((r) => [r.tool, r]),
    );
    const note = async (
      tool: string | null,
      kind: PinEventKind,
      from: string | null,
      to: string | null,
    ) => {
      events.push({ tool, kind });
      await tx.sql`
        insert into connector_tool_events (connector_id, connector_name, tool, kind, from_fingerprint, to_fingerprint)
        values (${row.id}, ${connector}, ${tool}, ${kind}, ${from}, ${to})`;
    };
    if (!row.baselined) {
      await tx.sql`insert into connector_pin_baselines (connector_id) values (${row.id}) on conflict do nothing`;
      if (observed.length > 0) await note(null, "baseline", null, null);
    }
    for (const o of observed) {
      const was = known.get(o.tool);
      const definition = tx.sql.json(o.definition as never);
      if (was === undefined) {
        if (!row.baselined) {
          await tx.sql`
            insert into connector_tool_pins (connector_id, tool, status, approved_fingerprint, approved_definition,
                                             approved_at, seen_fingerprint, seen_definition)
            values (${row.id}, ${o.tool}, 'approved', ${o.fingerprint}, ${definition}, now(), ${o.fingerprint}, ${definition})`;
        } else {
          await tx.sql`
            insert into connector_tool_pins (connector_id, tool, status, seen_fingerprint, seen_definition)
            values (${row.id}, ${o.tool}, 'new', ${o.fingerprint}, ${definition})`;
          await note(o.tool, "new", null, o.fingerprint);
        }
        continue;
      }
      if (was.status === "new") {
        if (was.seen_fingerprint !== o.fingerprint) {
          await tx.sql`
            update connector_tool_pins set seen_fingerprint = ${o.fingerprint}, seen_definition = ${definition}, seen_at = now()
            where connector_id = ${row.id} and tool = ${o.tool}`;
          await note(o.tool, "new", was.seen_fingerprint, o.fingerprint);
        }
        continue;
      }
      const matches = was.approved_fingerprint === o.fingerprint;
      const next: PinStatus = matches ? "approved" : "changed";
      if (next === was.status && was.seen_fingerprint === o.fingerprint) continue;
      await tx.sql`
        update connector_tool_pins set status = ${next}, seen_fingerprint = ${o.fingerprint},
          seen_definition = ${definition}, seen_at = now()
        where connector_id = ${row.id} and tool = ${o.tool}`;
      if (next === "changed") {
        await note(o.tool, "changed", was.approved_fingerprint, o.fingerprint);
      } else if (was.status === "changed") {
        await note(o.tool, "restored", was.seen_fingerprint, o.fingerprint);
      }
    }
    const pins = await tx.sql<PinRow[]>`
      select tool, status, approved_fingerprint, approved_definition, approved_at,
             seen_fingerprint, seen_definition, seen_at
      from connector_tool_pins where connector_id = ${row.id} order by tool`;
    return { pins: pins.map(mapPin), events };
  });
}

/**
 * The user approves the definition the server shows now (`fingerprint` is the one they looked
 * at: if the tool changed again meanwhile, nothing is approved). Throws `PinNotFoundError` and
 * `PinStaleError`.
 */
export async function approvePin(
  db: Db,
  connector: string,
  tool: string,
  fingerprint: string,
  kind: "approved" | "pinned_on_grant" = "approved",
): Promise<ToolPin> {
  return withTransaction(db, async (tx) => {
    const [row] = await tx.sql<PinRow[]>`
      select p.tool, p.status, p.approved_fingerprint, p.approved_definition, p.approved_at,
             p.seen_fingerprint, p.seen_definition, p.seen_at
      from connector_tool_pins p join connectors c on c.id = p.connector_id
      where c.name = ${connector} and p.tool = ${tool} for update of p`;
    if (row === undefined) {
      throw new PinNotFoundError(
        `A ferramenta ${tool} do conector ${connector} ainda não foi vista: rode "suup connectors test ${connector}".`,
      );
    }
    if (row.seen_fingerprint !== fingerprint) {
      throw new PinStaleError(
        `A definição de ${tool} mudou de novo depois que você a viu: revise outra vez.`,
      );
    }
    if (row.status === "approved") return mapPin(row);
    await tx.sql`
      update connector_tool_pins set status = 'approved', approved_fingerprint = seen_fingerprint,
        approved_definition = seen_definition, approved_at = now()
      from connectors c
      where c.id = connector_tool_pins.connector_id and c.name = ${connector} and connector_tool_pins.tool = ${tool}`;
    await tx.sql`
      insert into connector_tool_events (connector_id, connector_name, tool, kind, from_fingerprint, to_fingerprint)
      select id, ${connector}, ${tool}, ${kind}, ${row.approved_fingerprint}, ${fingerprint}
      from connectors where name = ${connector}`;
    const [after] = await tx.sql<PinRow[]>`
      select p.tool, p.status, p.approved_fingerprint, p.approved_definition, p.approved_at,
             p.seen_fingerprint, p.seen_definition, p.seen_at
      from connector_tool_pins p join connectors c on c.id = p.connector_id
      where c.name = ${connector} and p.tool = ${tool}`;
    if (after === undefined) throw new PinNotFoundError(tool);
    return mapPin(after);
  });
}

export async function listConnectorEvents(
  db: Db,
  connector: string,
  limit = 100,
): Promise<ConnectorToolEvent[]> {
  const rows = await db.sql<
    {
      id: string;
      connector_name: string;
      tool: string | null;
      kind: PinEventKind;
      from_fingerprint: string | null;
      to_fingerprint: string | null;
      detail: string | null;
      created_at: Date;
    }[]
  >`
    select id::text, connector_name, tool, kind, from_fingerprint, to_fingerprint, detail, created_at
    from connector_tool_events where connector_name = ${connector}
    order by id desc limit ${Math.max(1, Math.min(limit, 500))}`;
  return rows.map((r) => ({
    id: r.id,
    connector: r.connector_name,
    tool: r.tool,
    kind: r.kind,
    fromFingerprint: r.from_fingerprint,
    toFingerprint: r.to_fingerprint,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}
