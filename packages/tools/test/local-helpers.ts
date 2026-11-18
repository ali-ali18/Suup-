import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor } from "@suup/sandbox";
import { afterAll } from "vitest";

/** A LocalExecutor on a fresh temp directory, removed after the test file finishes. */
export async function localWorkspace(): Promise<LocalExecutor> {
  const dir = await mkdtemp(join(tmpdir(), "suup-tools-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return new LocalExecutor({ root: join(dir, "workspace"), iUnderstandThisIsNotIsolated: true });
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
