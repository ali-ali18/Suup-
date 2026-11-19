import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in for the `docker` CLI, used to exercise the DockerExecutor code paths without a
 * daemon. It is NOT a container: `docker exec` simply runs the command on this machine with a
 * clean environment. What it does prove is that the host-side argv handling, the in-container
 * scripts (realpath/timeout/find/pgrep...), and the exit code protocol work end to end.
 *
 * Environment: FAKE_DOCKER_LOG (file receiving one JSON argv array per call) and
 * FAKE_DOCKER_STATE (JSON file describing the single fake container: {exists, running}).
 */
const SCRIPT = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const stateFile = process.env.FAKE_DOCKER_STATE;
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { exists: false, running: false }; } };
const writeState = (s) => stateFile && fs.writeFileSync(stateFile, JSON.stringify(s));
const [cmd, ...rest] = args;
if (cmd === "exec") {
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" };
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === "-i") i += 1;
    else if (a === "-u" || a === "-w") i += 2;
    else if (a === "-e") { const [k, ...v] = rest[i + 1].split("="); env[k] = v.join("="); i += 2; }
    else break;
  }
  const [, ...command] = rest.slice(i); // skip the container name
  const child = spawn(command[0], command.slice(1), { env, stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 137 : 1)));
} else if (cmd === "network") {
  // An internal network that always exists, with a gateway the tests can listen on.
  if (rest[0] === "inspect") console.log("true false 0 127.0.0.1|127.0.0.0/8 ");
} else if (cmd === "inspect") {
  const s = readState();
  if (!s.exists) { console.error("Error response from daemon: No such container: " + rest[rest.length - 1]); process.exit(1); }
  console.log(rest.some((a) => a.includes("NetworkSettings")) ? (s.network ?? "bridge") + " " : String(s.running));
} else if (cmd === "run") {
  const s = readState();
  if (s.exists) { console.error("Conflict. The container name is already in use"); process.exit(125); }
  const at = rest.indexOf("--network");
  writeState({ exists: true, running: true, network: at < 0 ? undefined : rest[at + 1] });
  console.log("fakecontainerid");
} else if (cmd === "start") {
  writeState({ exists: true, running: true });
} else if (cmd === "rm") {
  const s = readState();
  if (!s.exists) { console.error("Error response from daemon: No such container: " + rest[rest.length - 1]); process.exit(1); }
  writeState({ exists: false, running: false });
} else if (cmd === "volume") {
  console.log(rest[rest.length - 1]);
} else { console.error("fake docker: unsupported " + cmd); process.exit(2); }
`;

export function installFakeDocker(dir: string): string {
  const path = join(dir, "docker");
  writeFileSync(path, SCRIPT);
  chmodSync(path, 0o755);
  return path;
}
