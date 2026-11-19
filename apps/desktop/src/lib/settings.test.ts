import { describe, expect, it } from "vitest";
import {
  applySettings,
  DEFAULT_SETTINGS,
  migrateSettings,
  parseSettings,
  SETTING_OPTIONS,
  serializeSettings,
  settingsAttributes,
} from "./settings.js";

describe("settings: one typed object with defaults", () => {
  it("nothing stored: the defaults (dark, bubble follows the bot, real phrase, folding on, icons off)", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({
      theme: "dark",
      bubble: "bot",
      width: "default",
      density: "comfortable",
      phrase: "real",
      fold: "on",
      favicons: "off",
      motion: "system",
      alwaysScope: "bot",
      approvalResolved: "collapsed",
      approvalLong: "collapse",
      notifyApprovals: "on",
    });
  });

  it("'always allow' proposes this bot, never all bots, until the person says otherwise", () => {
    expect(DEFAULT_SETTINGS.alwaysScope).toBe("bot");
    expect(parseSettings({ alwaysScope: "global" }).alwaysScope).toBe("global");
    expect(parseSettings({ alwaysScope: "everyone" }).alwaysScope).toBe("bot");
    expect(
      parseSettings({ approvalResolved: "open", approvalLong: "full", notifyApprovals: "off" }),
    ).toMatchObject({
      approvalResolved: "open",
      approvalLong: "full",
      notifyApprovals: "off",
    });
  });

  it("round-trips what was saved", () => {
    const changed = {
      ...DEFAULT_SETTINGS,
      theme: "light",
      bubble: "neutral",
      favicons: "on",
      fold: "off",
    } as const;
    expect(parseSettings(serializeSettings(changed))).toEqual(changed);
    expect(JSON.parse(serializeSettings(changed)).version).toBe(1);
  });

  it("unknown or invalid values fall back to the default, field by field; the rest is kept", () => {
    const parsed = parseSettings({
      theme: "light",
      bubble: "rainbow",
      width: 7,
      density: null,
      phrase: "discreet",
      fold: "maybe",
      favicons: "ON",
      motion: "reduce",
      extra: "x",
    });
    expect(parsed).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "light",
      phrase: "discreet",
      motion: "reduce",
    });
    expect("extra" in parsed).toBe(false);
  });

  it.each([["not json{"], [""], ["null"], ["[]"], ["42"], ['"light"'], [undefined], [123], [[]]])(
    "rubbish %j gives the defaults",
    (raw) => {
      expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
    },
  );

  it("a newer or older stored version keeps what it has in common", () => {
    expect(parseSettings({ version: 99, theme: "light", somethingNew: true })).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "light",
    });
    expect(parseSettings({ theme: "light" })).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
  });

  it("migrates the key the app used before (the theme only), once", () => {
    expect(migrateSettings(null, "light")).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
    expect(migrateSettings(null, "garbage")).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings(null, null)).toEqual(DEFAULT_SETTINGS);
    // what is stored wins over the old key
    expect(
      migrateSettings(serializeSettings({ ...DEFAULT_SETTINGS, theme: "dark" }), "light").theme,
    ).toBe("dark");
  });

  it("every setting has defaults among its options, and the root carries one attribute for each", () => {
    for (const [key, options] of Object.entries(SETTING_OPTIONS)) {
      expect(
        (options as readonly string[]).includes(
          DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS],
        ),
      ).toBe(true);
    }
    expect(Object.keys(settingsAttributes(DEFAULT_SETTINGS))).toHaveLength(
      Object.keys(DEFAULT_SETTINGS).length,
    );
    const root = document.createElement("html");
    applySettings(root, { ...DEFAULT_SETTINGS, width: "wide", density: "compact" });
    expect(root.getAttribute("data-width")).toBe("wide");
    expect(root.getAttribute("data-density")).toBe("compact");
    expect(root.getAttribute("data-theme")).toBe("dark");
  });
});
