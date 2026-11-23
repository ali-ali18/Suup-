import { cleanup, render } from "@testing-library/react";
import { Plug } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsRow } from "../features/settings/parts.js";
import { brandGlyphFor } from "./brand-icons.js";

afterEach(cleanup);

describe("brand glyphs of the connectors (Simple Icons, docs/DESIGN.md §5c)", () => {
  const CASES: [string, string][] = [
    ["github", "github"],
    ["notion", "notion"],
    ["figma", "figma"],
    ["gmail", "gmail"],
    ["google-drive", "googledrive"],
    ["googledrive", "googledrive"],
    ["google-calendar", "googlecalendar"],
    ["google-docs", "googledocs"],
    ["google-sheets", "googlesheets"],
    ["stack-overflow", "stackoverflow"],
  ];

  it.each(CASES)("the connector %s draws the %s glyph, in one colour, 16 px", (name, slug) => {
    const Glyph = brandGlyphFor(name);
    expect(Glyph).toBeDefined();
    const { container } = render(Glyph === undefined ? null : <Glyph size={16} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-brand")).toBe(slug);
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(50);
  });

  it("only an EXACT name has a glyph: a name that merely contains one, a variant or an object key has none", () => {
    for (const name of [
      "github-enterprise",
      "meu-github",
      "GitHub",
      "composio",
      "higgsfield",
      "fake",
      "",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(brandGlyphFor(name), name).toBeUndefined();
    }
  });

  it("a row takes the glyph in its leading slot, muted, and the generic plug when there is none", () => {
    const Brand = brandGlyphFor("github");
    const { container, rerender } = render(
      <SettingsRow icon={Brand ?? Plug} title="github" description="HTTP" />,
    );
    expect(container.querySelector("svg[data-brand='github']")).not.toBeNull();
    expect(container.querySelector("span.text-text-muted svg")).not.toBeNull();
    rerender(<SettingsRow icon={brandGlyphFor("composio") ?? Plug} title="composio" />);
    expect(container.querySelector("svg[data-brand]")).toBeNull();
    expect(container.querySelector("svg.lucide-plug")).not.toBeNull();
  });
});
