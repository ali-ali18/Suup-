// Owns reaching the SearXNG container without any network path from the worker to it: a short
// `docker exec` runs `wget` INSIDE the container against its own loopback. The query goes as one
// argument (no shell), so nothing in it is interpreted.
import { dockerClientEnv, runProcess } from "@suup/sandbox";
import type { SearxBackend } from "./search.js";

export function execSearxBackend(options: {
  container: string;
  port?: number;
  dockerPath?: string;
  timeoutMs?: number;
}): SearxBackend {
  const port = options.port ?? 8080;
  const timeoutMs = options.timeoutMs ?? 25_000;
  return {
    async query(params, signal) {
      const url = `http://127.0.0.1:${port}/search?${params.toString()}`;
      const result = await runProcess(
        options.dockerPath ?? "docker",
        [
          "exec",
          options.container,
          "wget",
          "--quiet",
          "--output-document=-",
          `--timeout=${Math.ceil(timeoutMs / 1000)}`,
          "--tries=1",
          url,
        ],
        {
          env: dockerClientEnv(),
          timeoutMs: timeoutMs + 5_000,
          maxOutputBytes: 2_000_000,
          killGroup: false,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (result.spawnError !== undefined)
        throw new Error(`could not run docker: ${result.spawnError.message}`);
      if (result.timedOut) throw new Error("the search timed out");
      if (result.exitCode !== 0) {
        const detail = result.stderr.toString("utf8").trim().split("\n")[0] ?? "";
        throw new Error(
          `the search container did not answer (exit code ${result.exitCode ?? "none"})${detail === "" ? "" : `: ${detail}`}`,
        );
      }
      return result.stdout.toString("utf8");
    },
  };
}
