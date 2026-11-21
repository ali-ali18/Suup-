// The program that runs INSIDE the reader container (docker/reader): reads JSON lines on stdin, one
// read request each, and answers with JSON lines on stdout (stdio-protocol.ts). It holds the robots
// cache and the per-host pace, so it must stay up between requests. Rendering is available when the
// environment says so (SUUP_RENDER=1) and Chromium starts; otherwise only plain reads work.
import { createInterface } from "node:readline";
import { createReader, type PageRenderer, userAgent, WEB_VERSION } from "./reader.js";
import { createPlaywrightRenderer } from "./renderer.js";
import { type ReadResponseLine, type ReadyLine, readRequestLine } from "./stdio-protocol.js";

function send(line: ReadyLine | ReadResponseLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const agent = userAgent(
    WEB_VERSION,
    process.env.SUUP_REPOSITORY_URL === undefined || process.env.SUUP_REPOSITORY_URL === ""
      ? undefined
      : process.env.SUUP_REPOSITORY_URL,
  );
  let renderer: (PageRenderer & { close(): Promise<void> }) | undefined;
  if (process.env.SUUP_RENDER === "1") {
    try {
      renderer = await createPlaywrightRenderer({
        userAgent: agent,
        noSandbox: process.env.SUUP_RENDER_NO_SANDBOX === "1",
        ...(process.env.SUUP_CHROMIUM_PATH === undefined || process.env.SUUP_CHROMIUM_PATH === ""
          ? {}
          : { executablePath: process.env.SUUP_CHROMIUM_PATH }),
      });
    } catch (error) {
      process.stderr.write(
        `renderer unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  const reader = createReader({
    userAgent: agent,
    ...(renderer === undefined ? {} : { renderer }),
    ...(process.env.SUUP_ROBOTS === "0" ? { robots: false } : {}),
  });
  send({ op: "ready", version: WEB_VERSION, renderAvailable: reader.renderAvailable });

  const lines = createInterface({ input: process.stdin });
  const running = new Set<Promise<void>>();
  lines.on("line", (text) => {
    let parsed: ReturnType<typeof readRequestLine.safeParse>;
    try {
      parsed = readRequestLine.safeParse(JSON.parse(text));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const request = parsed.data;
    const task = reader
      .read({
        url: request.url,
        ...(request.render === undefined ? {} : { render: request.render }),
      })
      .then((outcome) => send({ id: request.id, op: "read", outcome }))
      .catch((error: unknown) =>
        send({
          id: request.id,
          op: "read",
          outcome: {
            ok: false,
            reason: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      )
      .finally(() => running.delete(task));
    running.add(task);
  });
  await new Promise<void>((done) => lines.on("close", done));
  await Promise.allSettled([...running]);
  await renderer?.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `reader crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
