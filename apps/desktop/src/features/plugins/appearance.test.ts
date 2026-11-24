import { describe, expect, it } from "vitest";
// The server's own list, from its source (the gallery is a fixed list in the repository): the
// look of the app may only name ids that list has. No copy of the ids is kept here.
import {
  CONNECTOR_CATALOG,
  SEARCH_PLUGIN_CATALOG,
} from "../../../../../packages/connectors/src/catalog.js";
import { solidMarkFor } from "../../ui/brand-icons.js";
import { APPEARANCE_IDS, appearanceOf, BANNERS, CATEGORIES, NEUTRAL, TONES } from "./appearance.js";

const SERVER_IDS = [...CONNECTOR_CATALOG, ...SEARCH_PLUGIN_CATALOG].map((e) => e.id);

describe("the look of the connectors, by the id of the server's gallery", () => {
  it("every id with a look is a real id of the server's gallery (nothing the server does not offer)", () => {
    expect(APPEARANCE_IDS.length).toBeGreaterThan(0);
    for (const id of APPEARANCE_IDS) expect(SERVER_IDS, id).toContain(id);
  });

  it("every entry of the server's gallery has its own look today (Google Workspace: the Google logo)", () => {
    for (const id of SERVER_IDS) expect(appearanceOf(id), id).not.toBe(NEUTRAL);
    expect(appearanceOf("google-workspace").logo).toContain("google");
  });

  it("an id the app does not know: the neutral grey, no logo (the plug), no examples, section Outros", () => {
    expect(appearanceOf("algo-novo")).toBe(NEUTRAL);
    expect(NEUTRAL).toMatchObject({ tone: "neutral", category: "Outros", examples: [] });
    expect(NEUTRAL.logo).toBeUndefined();
  });

  it("the id is compared exactly: a name that only contains a known id has no look of its own", () => {
    for (const id of ["GitHub", "github-pessoal", "meu-notion", " notion"]) {
      expect(appearanceOf(id), id).toBe(NEUTRAL);
    }
  });
});

describe("the backgrounds of the logos: neutral, and FIXED for each connector", () => {
  it("there are four: the project's grey, the black and the white a brand's own icon has, and the brand's own colour", () => {
    expect([...TONES]).toEqual(["neutral", "black", "white", "solid"]);
  });

  it("a one-colour brand takes its own colour (solid), the black or white brands their own neutral, the multi-colour logos the grey", () => {
    expect(Object.fromEntries(APPEARANCE_IDS.map((id) => [id, appearanceOf(id).tone]))).toEqual({
      github: "black",
      notion: "white",
      linear: "solid",
      figma: "black",
      stackoverflow: "solid",
      "google-workspace": "neutral",
      composio: "black",
      firecrawl: "black",
      tavily: "neutral",
      brave: "solid",
    });
    // a solid tile needs the brand's mark and colour; any other needs the logo of thesvg
    for (const id of APPEARANCE_IDS) {
      const look = appearanceOf(id);
      if (look.tone === "solid") expect(solidMarkFor(id), id).toBeDefined();
      else expect(look.logo, id).toBeDefined();
    }
  });

  it("the band of a page has one of twelve gradients, FIXED for each connector and declared (nothing is drawn by chance)", () => {
    expect(BANNERS).toHaveLength(12);
    expect(new Set(BANNERS).size).toBe(12);
    expect(Object.fromEntries(APPEARANCE_IDS.map((id) => [id, appearanceOf(id).banner]))).toEqual({
      github: "slate",
      notion: "paper",
      linear: "lilac",
      figma: "ink",
      stackoverflow: "sun",
      "google-workspace": "coral",
      composio: "plum",
      firecrawl: "amber",
      tavily: "sky",
      brave: "coral",
    });
    for (const id of APPEARANCE_IDS) expect(BANNERS, id).toContain(appearanceOf(id).banner);
  });

  it("each look names a section of the screen and, when it has examples, three", () => {
    for (const id of APPEARANCE_IDS) {
      const look = appearanceOf(id);
      expect(CATEGORIES, id).toContain(look.category);
      expect(look.examples, id).toHaveLength(3);
    }
  });
});
