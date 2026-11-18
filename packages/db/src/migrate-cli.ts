import { createDb } from "./client.js";
import { migrate } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example).");
  process.exit(1);
}

const db = createDb(url);
try {
  const applied = await migrate(db);
  console.log(
    applied.length === 0
      ? "Database is up to date."
      : `Applied ${applied.length} migration(s): ${applied.join(", ")}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
