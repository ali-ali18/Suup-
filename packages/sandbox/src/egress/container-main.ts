// The entry point of the egress container image (docker/egress): bundled into one file by
// `apps/sidecar/scripts/egress-image.mjs`. Not exported by the package.
import { networkInterfaces } from "node:os";
import { runEgressContainer } from "./container-service.js";

const log = (text: string): void => {
  process.stdout.write(`suup-egress: ${text}\n`);
};

try {
  const running = await runEgressContainer(process.env, networkInterfaces(), log);
  const stop = (): void => {
    void running.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  log(`não iniciou: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
