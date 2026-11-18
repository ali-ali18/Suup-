import { describe, expect, it } from "vitest";
import { backoffDelay, defaultSleep } from "../src/retry.js";

describe("backoffDelay", () => {
  it("grows exponentially with equal jitter and is capped", () => {
    expect(backoffDelay(0, 100, 10_000, () => 0)).toBe(50);
    expect(backoffDelay(0, 100, 10_000, () => 0.999999)).toBe(100);
    expect(backoffDelay(1, 100, 10_000, () => 0)).toBe(100);
    expect(backoffDelay(3, 100, 10_000, () => 0)).toBe(400);
    expect(backoffDelay(20, 100, 1_000, () => 0.5)).toBe(750);
  });
});

describe("defaultSleep", () => {
  it("resolves after the delay", async () => {
    await expect(defaultSleep(5)).resolves.toBeUndefined();
  });

  it("rejects as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const waiting = defaultSleep(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await expect(defaultSleep(10, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
