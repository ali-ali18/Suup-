// Owns the files a bot hands to the user's chat (`send_file`; migration 0030). The content lives
// in the database (`bytea`), so the backup of the database carries it. A file waits for the next
// message of its run (`appendMessageOnce` attaches it in the same transaction that writes it).
import { z } from "zod";
import type { Db } from "./client.js";

/** The largest file kept: 25 MB (the migration checks it too). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const uuid = z.uuid();

export interface StoredFile {
  id: string;
  botId: string;
  runId: string | null;
  messageId: string | null;
  name: string;
  mime: string;
  size: number;
  createdAt: Date;
}

export interface StoredFileWithContent extends StoredFile {
  content: Uint8Array;
}

interface FileRow {
  id: string;
  bot_id: string;
  run_id: string | null;
  message_id: string | null;
  name: string;
  mime: string;
  size: number;
  created_at: Date;
  content?: Uint8Array;
}

function mapFile(row: FileRow): StoredFile {
  return {
    id: row.id,
    botId: row.bot_id,
    runId: row.run_id,
    messageId: row.message_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    createdAt: row.created_at,
  };
}

const insertSchema = z.object({
  botId: uuid,
  runId: uuid,
  callId: z.string().min(1).max(200),
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  content: z.instanceof(Uint8Array).refine((b) => b.length <= MAX_FILE_BYTES, "file too large"),
});

export interface InsertFileInput {
  botId: string;
  runId: string;
  /** The tool call that sent it: the same call stores the file once (after a crash, a retry). */
  callId: string;
  name: string;
  mime: string;
  content: Uint8Array;
}

/** Stores a file a run sent. Idempotent by (run, call): the second time returns the first file. */
export async function insertFile(
  db: Db,
  input: InsertFileInput,
): Promise<{ file: StoredFile; created: boolean }> {
  const f = insertSchema.parse(input);
  const columns = db.sql`id, bot_id, run_id, message_id, name, mime, size, created_at`;
  const [row] = await db.sql<FileRow[]>`
    insert into files (bot_id, run_id, call_id, name, mime, size, content)
    values (${f.botId}, ${f.runId}, ${f.callId}, ${f.name}, ${f.mime}, ${f.content.length},
      ${Buffer.from(f.content.buffer, f.content.byteOffset, f.content.length)})
    on conflict (run_id, call_id) do nothing
    returning ${columns}`;
  if (row !== undefined) return { file: mapFile(row), created: true };
  const [existing] = await db.sql<FileRow[]>`
    select ${columns} from files where run_id = ${f.runId} and call_id = ${f.callId}`;
  if (existing === undefined) throw new Error("file insert conflicted but no row was found");
  return { file: mapFile(existing), created: false };
}

/** A file with its content; `null` for an unknown id (or one that is not a uuid). */
export async function getFile(db: Db, id: string): Promise<StoredFileWithContent | null> {
  const parsed = uuid.safeParse(id);
  if (!parsed.success) return null;
  const [row] = await db.sql<FileRow[]>`
    select id, bot_id, run_id, message_id, name, mime, size, created_at, content
    from files where id = ${parsed.data}`;
  if (row === undefined) return null;
  return { ...mapFile(row), content: new Uint8Array(row.content ?? new Uint8Array()) };
}
