import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { expectIdle, freshBot, openApp, selectBot, send } from "./helpers.js";

// The text of a message never makes the chat scroll sideways (it wraps, even a word or a link with
// no break, and a code block wraps too), no scrollbar is drawn anywhere (owner's decision,
// 22/11/2026), and the bot's pill above the chat shows only its name, with the chevron on hover.

const usage = { inputTokens: 900, outputTokens: 90 };
const s = <T extends object>(step: T) => ({ ...step, usage });

const WORD = "palavra".repeat(60);
const URL_TEXT = `https://exemplo.com.br/${"caminho-muito-longo/".repeat(14)}fim`;
const CODE_LINE = `const valor = "${"x".repeat(420)}";`;
const REPLY = [
  `Uma palavra sem quebra: ${WORD}`,
  "",
  `Um endereço longo: ${URL_TEXT}`,
  "",
  `- item com ${WORD}`,
  `- item com \`${"codigo".repeat(50)}\` inline`,
  "",
  "```",
  CODE_LINE,
  ...Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`),
  "```",
].join("\n");

const SCRIPTS = {
  roteiro: {
    cases: [{ whenObjectiveContains: "CASE-OVERFLOW", agent: [s({ text: REPLY })] }],
  },
};

type Fit = { scrollWidth: number; clientWidth: number };
const fitOf = (el: Element): Fit => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });

test.describe("overflow and scrollbars", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ scripts: SCRIPTS });
    await freshBot(world, "Largo", { description: "Um bot com uma descrição bem comprida." });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  for (const size of [
    { width: 1440, height: 900 },
    { width: 1100, height: 700 },
  ]) {
    test(`long words, links and code wrap: nothing scrolls sideways, at ${size.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await openApp(page, world);
      await selectBot(page, "Largo");
      await send(page, `CASE-OVERFLOW ${"y".repeat(500)}`);
      await expect(page.getByTestId("message-bot").last()).toContainText("Uma palavra sem quebra");
      await expectIdle(page);

      const scroll = page.getByTestId("message-scroll");
      const log = page.getByTestId("chat-log");
      for (const [name, locator] of [
        ["the chat scroll area", scroll],
        ["the chat log", log],
        ["the last bot message", page.getByTestId("message-bot").last()],
        ["the user's message", page.getByTestId("message-user").last()],
        ["the code block", page.getByTestId("message-bot").last().locator("pre")],
      ] as const) {
        const fit = await locator.evaluate(fitOf);
        expect(fit.scrollWidth, `${name} must not overflow sideways`).toBeLessThanOrEqual(
          fit.clientWidth + 1,
        );
      }
      // The page itself does not scroll sideways either.
      const page_ = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(page_.scrollWidth).toBeLessThanOrEqual(page_.clientWidth);
    });
  }

  test("no scrollbar is drawn: the scroll areas take no width for a bar", async ({ page }) => {
    await openApp(page, world);
    await selectBot(page, "Largo");
    await send(page, "CASE-OVERFLOW curto");
    await expect(page.getByTestId("message-bot").last()).toContainText("Uma palavra sem quebra");
    await expectIdle(page);
    const scroll = page.getByTestId("message-scroll");
    // The reply is taller than the window, so the area really scrolls (by the wheel or the keys).
    const metrics = await scroll.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      // what is between the border and the content: where a vertical scrollbar would sit
      barWidth:
        (el as HTMLElement).offsetWidth -
        el.clientWidth -
        Number.parseFloat(getComputedStyle(el).borderLeftWidth) -
        Number.parseFloat(getComputedStyle(el).borderRightWidth),
      scrollbarWidth: getComputedStyle(el).scrollbarWidth,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.scrollbarWidth).toBe("none");
    expect(metrics.barWidth).toBe(0);
    await scroll.hover();
    await page.mouse.wheel(0, -400);
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollTop))
      .toBeLessThan(metrics.scrollHeight - metrics.clientHeight);
    // Every scroll area of the screen has no bar: the sidebar list and the panel body.
    const bars = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("*")]
        .filter((el) => el.scrollHeight > el.clientHeight && el.clientHeight > 0)
        .filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY))
        .map(
          (el) =>
            el.offsetWidth -
            el.clientWidth -
            Number.parseFloat(getComputedStyle(el).borderLeftWidth) -
            Number.parseFloat(getComputedStyle(el).borderRightWidth),
        ),
    );
    for (const bar of bars) expect(bar).toBe(0);
  });

  test("the bot's pill shows only its name, and the chevron appears on hover", async ({ page }) => {
    await openApp(page, world);
    await selectBot(page, "Largo");
    const chip = page.getByTestId("bot-chip");
    await expect(chip).toHaveText("Largo");
    await expect(chip).not.toContainText("descrição");
    const chevron = chip.locator("svg.lucide-chevron-down");
    await page.mouse.move(900, 500);
    await expect(chevron).toBeHidden();
    await chip.hover();
    await expect(chevron).toBeVisible();
  });
});
