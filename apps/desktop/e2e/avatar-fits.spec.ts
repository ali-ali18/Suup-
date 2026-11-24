import { expect, type Page, test } from "@playwright/test";
import { SHAPE_IDS } from "@suup/avatar";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { botItem, freshBot, openApp, selectBot, send } from "./helpers.js";

// Regression (owner, 24/11/2026: "Ficou cortado!"): the pinned tile cut the face. Two causes: the
// notch mask ended AT the avatar's box, flat-cutting the shapes the engine frames a little bigger
// than the box; and the top of the sidebar scroller sat under the 24 px fade ("Nada seco"), which
// melted the top of the first tile. Every shape, as a tile and as a row, must be whole: inside the
// layer the mask lives on, and below the fade.

test.skip(DATABASE_URL === undefined, SKIP_REASON);

let world: World;
test.beforeAll(async () => {
  world = await startWorld();
});
test.afterAll(async () => {
  await world.stop();
});

for (const variant of ["tile", "row"] as const) {
  test(`every shape is whole as a ${variant}: inside its layer and clear of the top fade`, async ({
    page,
  }) => {
    const bots = (await world.api.bots.list()).filter((b) => b.name.startsWith("Fit "));
    for (const b of bots) await world.api.bots.update(b.id, { pinned: variant === "tile" });
    if (bots.length === 0)
      for (const id of SHAPE_IDS)
        await freshBot(world, `Fit ${id}`, {
          avatar: `mascot:${id}`,
          color: "branco",
          pinned: variant === "tile",
        });
    const principal = (await world.api.bots.list()).find((b) => b.isDefault);
    if (principal !== undefined)
      await world.api.bots.update(principal.id, { pinned: variant === "tile" });
    // Still faces: the drawing's own framing, not the idle motion (the chat test below keeps the motion).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page, world);
    const sidebar = page.getByTestId("sidebar");
    await expect(botItem(page, `Fit ${SHAPE_IDS[0]}`)).toBeVisible();
    await page.waitForTimeout(1500);
    const fade = await sidebar
      .getByTestId("scroll-fade")
      .first()
      .evaluate((e) => e.getBoundingClientRect().height);
    let highest = Number.POSITIVE_INFINITY;
    let scrollTop = 0;
    for (const name of ["Principal", ...SHAPE_IDS.map((id) => `Fit ${id}`)]) {
      const rects = await botItem(page, name).evaluate((el) => {
        const layer = el.querySelector("[data-face-layer]") as HTMLElement;
        const scroller = layer.closest(".overflow-y-auto") as HTMLElement;
        const g = el.querySelector("[data-mascot] svg > g") as SVGGraphicsElement;
        const q = (x: DOMRect): [number, number, number, number] => [
          x.left,
          x.top,
          x.right,
          x.bottom,
        ];
        const svg = el.querySelector("[data-mascot]") as HTMLElement;
        return {
          frame: q(svg.getBoundingClientRect()),
          box: q((layer.parentElement as HTMLElement).getBoundingClientRect()),
          face: q(g.getBoundingClientRect()),
          layer: q(layer.getBoundingClientRect()),
          scrollTop: scroller.getBoundingClientRect().top,
        };
      });
      // The drawing's frame is exactly the avatar's box (owner, 24/11/2026: "Ele tá gigante!").
      expect(Math.abs(rects.frame[0] - rects.box[0]), name).toBeLessThanOrEqual(1);
      expect(Math.abs(rects.frame[1] - rects.box[1]), name).toBeLessThanOrEqual(1);
      expect(Math.abs(rects.frame[2] - rects.box[2]), name).toBeLessThanOrEqual(1);
      expect(Math.abs(rects.frame[3] - rects.box[3]), name).toBeLessThanOrEqual(1);
      expect(rects.face[0], name).toBeGreaterThanOrEqual(rects.layer[0]);
      expect(rects.face[1], name).toBeGreaterThanOrEqual(rects.layer[1]);
      expect(rects.face[2], name).toBeLessThanOrEqual(rects.layer[2]);
      expect(rects.face[3], name).toBeLessThanOrEqual(rects.layer[3]);
      highest = Math.min(highest, rects.face[1]);
      scrollTop = rects.scrollTop;
    }
    // At rest the highest face starts below the fade, not under it.
    expect(highest - scrollTop).toBeGreaterThanOrEqual(fade);
  });
}

/** Faces whose own box fits inside a clipping ancestor, but whose drawing does not (so it is cut). */
async function clippedFaces(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const inside = (a: DOMRect, b: DOMRect, slack: number) =>
      a.left >= b.left - slack &&
      a.top >= b.top - slack &&
      a.right <= b.right + slack &&
      a.bottom <= b.bottom + slack;
    for (const layer of document.querySelectorAll<HTMLElement>("[data-face-layer]")) {
      const drawing = layer.querySelector("[data-mascot] svg > g, canvas");
      if (drawing === null) continue;
      const shape = drawing.getBoundingClientRect();
      const avatar = layer.parentElement?.getBoundingClientRect();
      if (avatar === undefined || shape.width === 0) continue;
      for (let el = layer.parentElement?.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const clip = el.getBoundingClientRect();
        if (inside(avatar, clip, 0.5) && !inside(shape, clip, 0.5)) {
          const where = el.getAttribute("data-testid") ?? el.className.toString().slice(0, 60);
          const name = layer.closest("[data-testid]")?.getAttribute("data-testid") ?? "";
          out.push(`${name} -> ${where}`);
        }
      }
    }
    return out;
  });
}

test("no avatar is cut by what holds it: tile, chat chip, the live avatar in the chat, the rail", async ({
  page,
}) => {
  await freshBot(world, "Brilho", { avatar: "mascot:sparkle", color: "branco", pinned: true });
  await openApp(page, world);
  await selectBot(page, "Brilho");
  await send(page, "CASE-LIVE confira o arquivo");
  await expect(page.getByTestId("working-indicator")).toBeVisible();
  await expect(page.getByTestId("working-indicator").locator("[data-mascot]")).toBeVisible();
  await page.waitForTimeout(600);
  expect(await clippedFaces(page)).toEqual([]);
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  await page.waitForTimeout(600);
  expect(await clippedFaces(page)).toEqual([]);
});
