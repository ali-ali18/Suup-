import { describe, expect, it } from "vitest";
import { HostLimiter } from "../src/rate-limit.js";

describe("HostLimiter", () => {
  it("spaces the requests to one host and leaves other hosts alone", async () => {
    let clock = 0;
    const slept: number[] = [];
    const limiter = new HostLimiter({
      minIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await limiter.wait("a.example.com");
    await limiter.wait("a.example.com");
    await limiter.wait("a.example.com");
    await limiter.wait("b.example.com");
    expect(slept).toEqual([1000, 1000]);
    clock += 5000;
    await limiter.wait("a.example.com");
    expect(slept).toEqual([1000, 1000]);
  });
});
