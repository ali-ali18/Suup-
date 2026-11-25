import { describe, expect, it } from "vitest";
import {
  OWNER_NAME_MAX_LENGTH,
  updateUserSettingsBodySchema,
  userSettingsSchema,
} from "../src/index.js";

const ok = (body: unknown) => updateUserSettingsBodySchema.safeParse(body).success;

describe("PATCH /v1/user-settings body", () => {
  it("keeps the old call (zone with its source) and accepts the name, alone or with the zone", () => {
    expect(ok({ timeZone: "America/Sao_Paulo", source: "device" })).toBe(true);
    expect(ok({ ownerName: "Ana" })).toBe(true);
    expect(ok({ ownerName: "Ana", ownerNameIfEmpty: true })).toBe(true);
    expect(ok({ ownerName: "Ana", timeZone: "America/Sao_Paulo", source: "user" })).toBe(true);
  });

  it("trims the name, keeps its case, and checks only the size", () => {
    const parsed = updateUserSettingsBodySchema.parse({ ownerName: "  ana d'Ávila  " });
    expect(parsed.ownerName).toBe("ana d'Ávila");
    expect(ok({ ownerName: "   " })).toBe(false);
    expect(ok({ ownerName: "x".repeat(OWNER_NAME_MAX_LENGTH) })).toBe(true);
    expect(ok({ ownerName: "x".repeat(OWNER_NAME_MAX_LENGTH + 1) })).toBe(false);
  });

  it("refuses an empty body, a lone zone or source, the flag without a name, and unknown fields", () => {
    expect(ok({})).toBe(false);
    expect(ok({ timeZone: "America/Sao_Paulo" })).toBe(false);
    expect(ok({ source: "user" })).toBe(false);
    expect(ok({ ownerNameIfEmpty: true })).toBe(false);
    expect(ok({ ownerName: "Ana", nope: 1 })).toBe(false);
    expect(ok({ timeZone: "Marte/Olympus", source: "user" })).toBe(false);
  });

  it("answers the name as a string or null", () => {
    const base = { timeZone: null, timeZoneSource: null };
    expect(userSettingsSchema.parse({ ...base, ownerName: null }).ownerName).toBeNull();
    expect(userSettingsSchema.parse({ ...base, ownerName: "Ana" }).ownerName).toBe("Ana");
  });
});
