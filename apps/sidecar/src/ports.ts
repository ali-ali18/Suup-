import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

/** Whether `port` of the loopback can be listened on right now. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** A free port the system picks (the small window until it is used again is accepted). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export interface Ports {
  postgres: number;
  server: number;
}

function readPorts(file: string): Partial<Ports> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null) return {};
    const { postgres, server } = value as Record<string, unknown>;
    return {
      ...(typeof postgres === "number" ? { postgres } : {}),
      ...(typeof server === "number" ? { server } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The ports of this install. They are chosen once and kept, so a restart (the app took a new key, the
 * server crashed) comes back at the same address and the open app reconnects by itself; a kept port
 * that is busy now is replaced.
 */
export async function choosePorts(file: string): Promise<Ports> {
  const kept = readPorts(file);
  const pick = async (saved: number | undefined, taken: number[]): Promise<number> => {
    if (saved !== undefined && !taken.includes(saved) && (await portIsFree(saved))) return saved;
    for (let i = 0; i < 20; i++) {
      const port = await freePort();
      if (!taken.includes(port)) return port;
    }
    throw new Error("não há porta livre neste computador");
  };
  const server = await pick(kept.server, []);
  const postgres = await pick(kept.postgres, [server]);
  const ports = { postgres, server };
  writeFileSync(file, JSON.stringify(ports));
  return ports;
}
