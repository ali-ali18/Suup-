// Owns the user's own settings (table `user_settings`, migration 0026): today, the user's IANA time
// zone and where it came from. Routines and "now" are in the USER's zone, never the server's: the
// server may run on a VPS in UTC or in another country. The app sends the zone of the user's
// computer when it connects (`device`); the user can choose another in Settings (`user`), and a
// zone the user chose is never replaced by the one a device sends.
import { isKnownTimeZone } from "@suup/core";
import type { Db } from "./client.js";

export type TimeZoneSource = "device" | "user";

export interface UserSettings {
  /** The user's IANA zone; `null` until the app (or the user) said it. */
  timeZone: string | null;
  timeZoneSource: TimeZoneSource | null;
  /** The name the user chose to be called by; `null` until they said it. Free text, kept as typed. */
  ownerName: string | null;
  updatedAt: Date;
}

interface Row {
  time_zone: string | null;
  time_zone_source: TimeZoneSource | null;
  owner_name: string | null;
  updated_at: Date;
}

const map = (row: Row): UserSettings => ({
  timeZone: row.time_zone,
  timeZoneSource: row.time_zone_source,
  ownerName: row.owner_name,
  updatedAt: row.updated_at,
});

export class UserSettingsError extends Error {
  override name = "UserSettingsError";
  constructor(
    readonly code: "invalid_time_zone" | "invalid_owner_name",
    message: string,
  ) {
    super(message);
  }
}

export async function getUserSettings(db: Db): Promise<UserSettings> {
  const [row] = await db.sql<Row[]>`
    select time_zone, time_zone_source, owner_name, updated_at from user_settings where singleton`;
  if (row === undefined)
    return { timeZone: null, timeZoneSource: null, ownerName: null, updatedAt: new Date(0) };
  return map(row);
}

/**
 * Sets the user's time zone. `source: "user"` always wins (the user chose it). `source: "device"`
 * (what the app reads from the computer) is written only while the user has not chosen one: the
 * device fills the blank and follows the computer, never overrides a choice.
 */
export async function setUserTimeZone(
  db: Db,
  input: { timeZone: string; source: TimeZoneSource },
): Promise<UserSettings> {
  const zone = input.timeZone.trim();
  if (!isKnownTimeZone(zone)) {
    throw new UserSettingsError(
      "invalid_time_zone",
      `"${input.timeZone}" não é um fuso horário IANA conhecido (por exemplo America/Sao_Paulo).`,
    );
  }
  const [row] = await db.sql<Row[]>`
    insert into user_settings (singleton, time_zone, time_zone_source)
    values (true, ${zone}, ${input.source})
    on conflict (singleton) do update set
      time_zone = excluded.time_zone,
      time_zone_source = excluded.time_zone_source
    where ${input.source} = 'user'
      or user_settings.time_zone_source is distinct from 'user'
    returning time_zone, time_zone_source, owner_name, updated_at`;
  return row === undefined ? getUserSettings(db) : map(row);
}

/** The longest name kept (the database enforces the same). */
export const OWNER_NAME_MAX = 60;

/**
 * Sets the name of the user. The name is free text: it is trimmed and its size checked, nothing
 * else (no format, no case change). With `onlyIfEmpty` an existing name is kept, so a device that
 * connects never overwrites the name a server already has. Returns the final settings.
 */
export async function setOwnerName(
  db: Db,
  input: { name: string; onlyIfEmpty?: boolean },
): Promise<UserSettings> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > OWNER_NAME_MAX) {
    throw new UserSettingsError(
      "invalid_owner_name",
      `O nome precisa ter de 1 a ${OWNER_NAME_MAX} caracteres.`,
    );
  }
  await db.sql`
    insert into user_settings (singleton, owner_name)
    values (true, ${name})
    on conflict (singleton) do update set owner_name = excluded.owner_name
    where not ${input.onlyIfEmpty === true}::boolean or user_settings.owner_name is null`;
  return getUserSettings(db);
}
