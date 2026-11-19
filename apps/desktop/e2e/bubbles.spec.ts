import { expect, type Locator, test } from "@playwright/test";
import { appendMessage } from "@suup/db";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { connect, freshBot, selectBot } from "./helpers.js";

// Dynamic bubbles (docs/DESIGN.md, "Balões"): consecutive text bubbles of one sender link with a
// small corner on the sender's side; cards never change their radius and break the group.

const FULL = "24px";
const LINK = "6px";

test.describe("dynamic bubbles", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.afterEach(async () => {
    await world.stop();
  });

  async function seed(): Promise<void> {
    world = await startWorld();
    await freshBot(world, "Nova", { color: "verde" });
    const bots = await world.api.bots.list();
    const bot = bots.find((b) => b.name === "Nova")?.id as string;
    const conversation = await world.api.bots.openConversation(bot);
    const add = (authorKind: "user" | "bot", text: string, question?: object) =>
      appendMessage(world.db, {
        conversationId: conversation.id,
        authorKind,
        ...(authorKind === "bot" ? { authorBotId: bot } : {}),
        text,
        ...(question === undefined ? {} : { question: question as never }),
      });
    await add("user", "oi");
    await add("bot", "Primeira do grupo");
    await add("bot", "Segunda, no meio");
    await add("bot", "Terceira, a última do grupo");
    await add("user", "uma só minha");
    await add("bot", "Antes do cartão");
    await add("bot", "Escolha uma cor", {
      questions: [{ question: "Qual cor?", options: [{ label: "Azul" }, { label: "Verde" }] }],
    });
    await add("bot", "Depois do cartão");
    await add("bot", "Fim");
    await add("user", "primeira minha");
    await add("user", "segunda minha");
  }

  const corners = async (el: Locator) =>
    el.evaluate((node) => {
      const css = getComputedStyle(node);
      return [
        css.borderTopLeftRadius,
        css.borderTopRightRadius,
        css.borderBottomRightRadius,
        css.borderBottomLeftRadius,
      ];
    });
  const botBubble = (page: import("@playwright/test").Page, text: string) =>
    page.getByTestId("message-bot").filter({ hasText: text }).locator(".ui-bubble--bot").first();
  const userBubble = (page: import("@playwright/test").Page, text: string) =>
    page.getByTestId("message-user").filter({ hasText: text }).locator(".ui-bubble--user");

  test("first, middle and last link on the bot's side; the far side and the ends stay round; cards keep their radius", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed();
    await connect(page, world);
    await selectBot(page, "Nova");
    await expect(page.getByTestId("message-bot").filter({ hasText: "Fim" })).toBeVisible();

    // [top-left, top-right, bottom-right, bottom-left]
    expect(await corners(botBubble(page, "Primeira do grupo"))).toEqual([FULL, FULL, FULL, LINK]);
    expect(await corners(botBubble(page, "Segunda, no meio"))).toEqual([LINK, FULL, FULL, LINK]);
    expect(await corners(botBubble(page, "Terceira, a última"))).toEqual([LINK, FULL, FULL, FULL]);
    // A lone bubble is fully rounded; so is the one a card cuts off from its neighbours.
    expect(await corners(botBubble(page, "Antes do cartão"))).toEqual([FULL, FULL, FULL, FULL]);
    expect(await corners(botBubble(page, "Depois do cartão"))).toEqual([FULL, FULL, FULL, LINK]);
    expect(await corners(botBubble(page, "Fim"))).toEqual([LINK, FULL, FULL, FULL]);
    expect(await corners(userBubble(page, "oi"))).toEqual([FULL, FULL, FULL, FULL]);
    expect(await corners(userBubble(page, "uma só minha"))).toEqual([FULL, FULL, FULL, FULL]);
    // The user's bubbles mirror it: they link on the right.
    expect(await corners(userBubble(page, "primeira minha"))).toEqual([FULL, FULL, LINK, FULL]);
    expect(await corners(userBubble(page, "segunda minha"))).toEqual([FULL, LINK, FULL, FULL]);

    // The card is not part of any group: its chrome and radius are the standard ones, and it
    // carries no position.
    const card = page.getByTestId("question-card");
    await expect(card).toHaveCSS("border-radius", FULL);
    await expect(card).toHaveCSS("border-top-width", "1px");
    const cardRow = page
      .getByTestId("message-bot")
      .filter({ has: page.getByTestId("question-card") });
    expect(await cardRow.getAttribute("data-bubble")).toBeNull();

    // Tighter inside a group than between groups.
    const box = async (text: string) => (await botBubble(page, text).boundingBox()) ?? fail(text);
    const a = await box("Primeira do grupo");
    const b = await box("Segunda, no meio");
    const c = await box("Terceira, a última");
    const separate = await userBubble(page, "uma só minha").boundingBox();
    const inGroup = b.y - (a.y + a.height);
    expect(inGroup).toBeGreaterThan(0);
    expect(inGroup).toBeLessThan(8);
    expect((separate?.y ?? 0) - (c.y + c.height)).toBeGreaterThan(inGroup + 4);

    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "screenshots/bolhas/baloes-agrupados.png" });
  });
});

function fail(text: string): never {
  throw new Error(`no box for ${text}`);
}
