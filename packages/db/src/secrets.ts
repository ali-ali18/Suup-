// Owns the vault's rows (tables `secrets` and `secret_grants`, migration 0011). The database only
// ever holds ciphertext: encrypting and decrypting happen outside it (`@suup/runtime`, with a key
// that never touches the database), so nothing in this module can read a secret value. The API
// reads names and metadata through `listSecrets`; there is deliberately no "get value" function.
import { z } from "zod";
import type { Db } from "./client.js";

/** A secret as the API and the app see it: never the value, never the ciphertext. */
export interface SecretMeta {
  id: string;
  name: string;
  description: string;
  keyId: string;
  /** The bots that may use it. */
  grantedBotIds: string[];
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  /** The connector that keeps this secret (its OAuth login), or null for the owner's own. */
  managedBy: string | null;
}

/** A stored secret with its ciphertext, for the one module that can decrypt it. */
export interface SecretRow {
  id: string;
  name: string;
  description: string;
  nonce: Buffer;
  ciphertext: Buffer;
  keyId: string;
  updatedAt: Date;
}

interface MetaRow {
  id: string;
  name: string;
  description: string;
  key_id: string;
  granted: string[] | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  managed_by: string | null;
}

function mapMeta(row: MetaRow): SecretMeta {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    keyId: row.key_id,
    grantedBotIds: row.granted ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    managedBy: row.managed_by,
  };
}

const nameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "nome de segredo inválido");

export class SecretNotFoundError extends Error {
  override readonly name = "SecretNotFoundError";
  constructor(readonly secretName: string) {
    super(`Segredo ${secretName} não encontrado.`);
  }
}

/** The secret belongs to a connector's login: the owner's vault cannot touch it. */
export class SecretManagedError extends Error {
  override readonly name = "SecretManagedError";
  constructor(readonly secretName: string) {
    super(
      `O segredo ${secretName} é o login de um conector: o Suup cuida dele, e ele não pode ser editado nem concedido a um bot.`,
    );
  }
}

export interface PutSecretInput {
  name: string;
  /** Omitted: keeps the description of an existing secret (empty for a new one). */
  description?: string | undefined;
  nonce: Buffer;
  ciphertext: Buffer;
  keyId: string;
  /** Set only by the connector that keeps the secret (its exact name). */
  managedBy?: string | undefined;
}

const META = (db: Db) => db.sql`
  select s.id, s.name, s.description, s.key_id, s.created_at, s.updated_at, s.last_used_at, s.managed_by,
         (select coalesce(array_agg(g.bot_id::text order by g.granted_at), '{}')
            from secret_grants g where g.secret_id = s.id) as granted
  from secrets s`;

/** Creates the secret, or replaces its value (grants are kept). Returns the metadata. */
export async function putSecret(db: Db, input: PutSecretInput): Promise<SecretMeta> {
  const name = nameSchema.parse(input.name);
  const managedBy = input.managedBy ?? null;
  const rows = await db.sql`
    insert into secrets (name, description, nonce, ciphertext, key_id, managed_by)
    values (${name}, ${input.description ?? ""}, ${input.nonce}, ${input.ciphertext}, ${input.keyId}, ${managedBy})
    on conflict (name) do update set
      nonce = excluded.nonce,
      ciphertext = excluded.ciphertext,
      key_id = excluded.key_id,
      description = case when ${input.description !== undefined} then excluded.description else secrets.description end
    where secrets.managed_by is not distinct from excluded.managed_by
    returning id`;
  // A name kept by a connector is never overwritten by the owner (and the reverse).
  if (rows.length === 0) throw new SecretManagedError(name);
  const meta = await getSecretMeta(db, name);
  if (meta === null) throw new Error("secret vanished after insert");
  return meta;
}

export async function getSecretMeta(db: Db, name: string): Promise<SecretMeta | null> {
  const [row] = await db.sql<MetaRow[]>`${META(db)} where s.name = ${name}`;
  return row === undefined ? null : mapMeta(row);
}

/** The owner's secrets. The ones a connector keeps (its login) are left out unless asked for. */
export async function listSecrets(
  db: Db,
  options: { includeManaged?: boolean } = {},
): Promise<SecretMeta[]> {
  const rows = await db.sql<MetaRow[]>`${META(db)}
    where ${options.includeManaged === true} or s.managed_by is null order by s.name`;
  return rows.map(mapMeta);
}

/**
 * Deletes a secret. Without `managedBy` only the owner's own secrets go; with it, only the ones
 * that connector keeps (exact name).
 */
export async function deleteSecret(
  db: Db,
  name: string,
  managedBy: string | null = null,
): Promise<boolean> {
  const rows = await db.sql`
    delete from secrets where name = ${name} and managed_by is not distinct from ${managedBy}
    returning id`;
  return rows.length > 0;
}

interface CipherRow {
  id: string;
  name: string;
  description: string;
  nonce: Buffer;
  ciphertext: Buffer;
  key_id: string;
  updated_at: Date;
}

const toRow = (r: CipherRow): SecretRow => ({
  id: r.id,
  name: r.name,
  description: r.description,
  nonce: r.nonce,
  ciphertext: r.ciphertext,
  keyId: r.key_id,
  updatedAt: r.updated_at,
});

/** Every secret with its ciphertext (for the redactor and for key rotation). */
export async function listSecretRows(db: Db): Promise<SecretRow[]> {
  const rows = await db.sql<CipherRow[]>`
    select id, name, description, nonce, ciphertext, key_id, updated_at from secrets order by name`;
  return rows.map(toRow);
}

/** The secrets granted to a bot, with ciphertext (for resolving placeholders). */
export async function listSecretRowsForBot(db: Db, botId: string): Promise<SecretRow[]> {
  const rows = await db.sql<CipherRow[]>`
    select s.id, s.name, s.description, s.nonce, s.ciphertext, s.key_id, s.updated_at
    from secrets s join secret_grants g on g.secret_id = s.id
    where g.bot_id = ${botId} and s.managed_by is null order by s.name`;
  return rows.map(toRow);
}

/** One secret with its ciphertext, only if the bot may use it. */
export async function getSecretRowForBot(
  db: Db,
  botId: string,
  name: string,
): Promise<SecretRow | null> {
  const [row] = await db.sql<CipherRow[]>`
    select s.id, s.name, s.description, s.nonce, s.ciphertext, s.key_id, s.updated_at
    from secrets s join secret_grants g on g.secret_id = s.id
    where g.bot_id = ${botId} and s.name = ${name} and s.managed_by is null`;
  return row === undefined ? null : toRow(row);
}

/**
 * One secret with its ciphertext, whoever may use it. For the one caller that acts for the USER and
 * not for a bot: a connector the user configured with a reference to the secret.
 */
export async function getSecretRowByName(db: Db, name: string): Promise<SecretRow | null> {
  const [row] = await db.sql<CipherRow[]>`
    select id, name, description, nonce, ciphertext, key_id, updated_at from secrets where name = ${name}`;
  return row === undefined ? null : toRow(row);
}

/**
 * Replaces the ciphertext of a secret (key rotation). The row must not have changed meanwhile: a
 * write always draws a new random nonce, so the nonce read earlier says whether it did.
 */
export async function replaceSecretCipher(
  db: Db,
  row: SecretRow,
  next: { nonce: Buffer; ciphertext: Buffer; keyId: string },
): Promise<boolean> {
  const rows = await db.sql`
    update secrets set nonce = ${next.nonce}, ciphertext = ${next.ciphertext}, key_id = ${next.keyId}
    where id = ${row.id} and nonce = ${row.nonce} returning id`;
  return rows.length > 0;
}

export async function markSecretUsed(db: Db, name: string): Promise<void> {
  await db.sql`update secrets set last_used_at = now() where name = ${name}`;
}

/** Lets the bot use the secret. Idempotent. Throws `SecretNotFoundError`. */
export async function grantSecret(db: Db, name: string, botId: string): Promise<void> {
  const rows = await db.sql`
    insert into secret_grants (secret_id, bot_id)
    select id, ${z.uuid().parse(botId)} from secrets where name = ${name} and managed_by is null
    on conflict do nothing returning secret_id`;
  if (rows.length === 0) {
    const meta = await getSecretMeta(db, name);
    if (meta === null) throw new SecretNotFoundError(name);
    if (meta.managedBy !== null) throw new SecretManagedError(name);
  }
}

/** Takes the permission away. Returns whether the bot had it. */
export async function revokeSecret(db: Db, name: string, botId: string): Promise<boolean> {
  const rows = await db.sql`
    delete from secret_grants
    where bot_id = ${z.uuid().parse(botId)} and secret_id = (select id from secrets where name = ${name})
    returning secret_id`;
  return rows.length > 0;
}

/** The secrets a bot may use, as the model is told about them: names and descriptions. */
export async function listSecretInfoForBot(
  db: Db,
  botId: string,
): Promise<{ name: string; description: string }[]> {
  return db.sql<{ name: string; description: string }[]>`
    select s.name, s.description
    from secrets s join secret_grants g on g.secret_id = s.id
    where g.bot_id = ${botId} and s.managed_by is null order by s.name`;
}
