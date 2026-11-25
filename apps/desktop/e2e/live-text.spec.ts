import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, LIVE_TEXTS, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openWithBot, send } from "./helpers.js";

// KOD-34: the answer of the bot is typed in its bubble as it is written, and when the turn ends the
// bubble keeps the recorded text: the same element, no flicker, nothing twice. The typed text is
// never a message. The server and the worker are two runtimes here, so the text really goes through
// the database (NOTIFY) between them. Pictures at 1440x900@2x go to screenshots/1440x900@2x/.

interface Seen {
  /** Every distinct state of every bot bubble, in the order it was seen. */
  states: { node: number; text: string; busy: boolean; live: boolean }[];
  /** The most bot bubbles on screen at the same time. */
  mostAtOnce: number;
}

/** Starts watching the chat for bot bubbles (before the message is sent). */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ids = new WeakMap<Element, number>();
    let next = 1;
    const seen: Seen = { states: [], mostAtOnce: 0 };
    (window as unknown as { __seen: Seen }).__seen = seen;
    const look = () => {
      const bubbles = [...document.querySelectorAll('[data-testid="message-bot"]')];
      seen.mostAtOnce = Math.max(seen.mostAtOnce, bubbles.length);
      for (const el of bubbles) {
        if (!ids.has(el)) ids.set(el, next++);
        const text = (el.querySelector('[data-testid="bubble-bot"]')?.textContent ?? "").trim();
        if (text === "") continue;
        const state = {
          node: ids.get(el) as number,
          text,
          busy: el.getAttribute("aria-busy") === "true",
          live: el.getAttribute("data-typing") === "true",
        };
        const last = [...seen.states].reverse().find((s) => s.node === state.node);
        if (last === undefined || last.text !== state.text || last.busy !== state.busy) {
          seen.states.push(state);
        }
      }
    };
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    setInterval(look, 20);
  });
}

const seenOf = (page: Page): Promise<Seen> =>
  page.evaluate(() => (window as unknown as { __seen: Seen }).__seen);

/** The bot messages the server recorded, in order. */
async function recorded(world: World, bot: string): Promise<string[]> {
  const conversation = (await world.api.bots.list()).find((b) => b.name === bot)
    ?.conversationId as string;
  const items = (await world.api.conversations.messages(conversation)).items;
  return items.filter((m) => m.authorKind === "bot").map((m) => m.text);
}

/** The states of one bubble (a node) as it grew: each one a longer start of the one before. */
function growth(seen: Seen, node: number): string[] {
  return seen.states.filter((s) => s.node === node).map((s) => s.text);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `screenshots/1440x900@2x/${name}.png` });
}

test.describe("the answer is typed in its bubble", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  test.afterEach(async () => {
    await world.stop();
  });

  test("a plain answer grows in several steps and ends equal to the recorded text, in the same bubble", async ({
    page,
  }) => {
    world = await startWorld();
    await openWithBot(page, world, "Falante");
    await watch(page);
    await send(page, "CASE-VIVO-SIMPLES oi");

    // While it is typed: the bubble is busy, the log does not announce each piece, and a mark blinks.
    const typing = page.locator('[data-testid="message-bot"][data-typing="true"]');
    await expect(typing).toBeVisible({ timeout: 60_000 });
    await expect(typing).toHaveAttribute("aria-busy", "true");
    await expect(typing).toHaveAttribute("aria-live", "off");
    await expect
      .poll(async () => ((await typing.textContent()) ?? "").length, { timeout: 30_000 })
      .toBeGreaterThan(20);
    await shot(page, "texto-ao-vivo-digitando");

    // The end: the bubble is no longer busy and the text is the whole answer.
    const bubble = page.getByTestId("message-bot");
    await expect(bubble).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 });
    await expect(bubble).toContainText(LIVE_TEXTS.simples);
    await shot(page, "texto-ao-vivo-final");

    const seen = await seenOf(page);
    const nodes = [...new Set(seen.states.map((s) => s.node))];
    expect(nodes).toHaveLength(1); // one element for the whole answer, typed and recorded
    const steps = growth(seen, nodes[0] as number);
    // At least three different lengths, each one a start of the next: it grew, it never shrank.
    expect(new Set(steps.map((t) => t.length)).size).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < steps.length; i++) {
      expect((steps[i] as string).startsWith(steps[i - 1] as string)).toBe(true);
    }
    expect(seen.mostAtOnce).toBe(1); // never drawn twice
    // It ends equal to what the server recorded, and that is one message.
    const messages = await recorded(world, "Falante");
    expect(messages).toEqual([LIVE_TEXTS.simples]);
    expect(steps[steps.length - 1]).toBe(messages[0]);
    // And it is the same after a reload: from the recorded message, nothing typed is left over.
    await page.reload();
    await page.locator('[data-testid="bot-item"][data-bot="Falante"]').click();
    await expect(page.getByTestId("message-bot")).toHaveCount(1);
    await expect(page.getByTestId("message-bot")).toContainText(LIVE_TEXTS.simples);
  });

  test("a part and the final text: each typed in its own bubble, and each keeps its element", async ({
    page,
  }) => {
    world = await startWorld();
    await openWithBot(page, world, "Parceiro");
    await watch(page);
    await send(page, "CASE-VIVO-PARTE marque");

    await expect(page.getByTestId("message-bot").filter({ hasText: LIVE_TEXTS.fim })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="message-bot"][aria-busy="true"]')).toHaveCount(0);
    await shot(page, "texto-ao-vivo-parte-e-final");

    const seen = await seenOf(page);
    const nodes = [...new Set(seen.states.map((s) => s.node))];
    expect(nodes).toHaveLength(2); // the part and the end: one element each
    const [partNode, endNode] = nodes as [number, number];
    expect(new Set(growth(seen, partNode).map((t) => t.length)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(growth(seen, endNode).map((t) => t.length)).size).toBeGreaterThanOrEqual(3);
    expect(growth(seen, partNode).at(-1)).toBe(LIVE_TEXTS.parte);
    expect(growth(seen, endNode).at(-1)).toBe(LIVE_TEXTS.fim);
    expect(seen.mostAtOnce).toBe(2);
    expect(await recorded(world, "Parceiro")).toEqual([LIVE_TEXTS.parte, LIVE_TEXTS.fim]);
  });

  test("the summary of finish is typed, and ends equal to the recorded message", async ({
    page,
  }) => {
    world = await startWorld();
    await openWithBot(page, world, "Resumidor");
    await watch(page);
    await send(page, "CASE-VIVO-RESUMO faça");

    await expect(
      page.getByTestId("message-bot").filter({ hasText: LIVE_TEXTS.resumo }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="message-bot"][aria-busy="true"]')).toHaveCount(0);
    const seen = await seenOf(page);
    const nodes = [...new Set(seen.states.map((s) => s.node))];
    expect(nodes).toHaveLength(1);
    const steps = growth(seen, nodes[0] as number);
    expect(new Set(steps.map((t) => t.length)).size).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < steps.length; i++) {
      expect((steps[i] as string).startsWith(steps[i - 1] as string)).toBe(true);
    }
    expect(seen.mostAtOnce).toBe(1);
    expect(await recorded(world, "Resumidor")).toEqual([LIVE_TEXTS.resumo]);
    expect(steps.at(-1)).toBe(LIVE_TEXTS.resumo);
  });

  test("words and finish in one turn: the words go away at once and the summary is typed in their place", async ({
    page,
  }) => {
    world = await startWorld();
    await openWithBot(page, world, "Misto");
    await watch(page);
    await send(page, "CASE-VIVO-MISTO faça");

    await expect(
      page.getByTestId("message-bot").filter({ hasText: LIVE_TEXTS.resumo }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="message-bot"][aria-busy="true"]')).toHaveCount(0);
    const seen = await seenOf(page);
    expect(seen.mostAtOnce).toBe(1); // the draft and the summary were never on screen together
    // Once the summary started, the draft was not seen again; and it is not in the chat nor recorded.
    const texts = seen.states.map((s) => s.text);
    const firstSummary = texts.findIndex((t) => LIVE_TEXTS.resumo.startsWith(t));
    expect(firstSummary).toBeGreaterThanOrEqual(0);
    expect(texts.slice(firstSummary).some((t) => LIVE_TEXTS.rascunho.startsWith(t))).toBe(false);
    await expect(page.getByTestId("chat-log")).not.toContainText(LIVE_TEXTS.rascunho);
    expect(await recorded(world, "Misto")).toEqual([LIVE_TEXTS.resumo]);
  });

  test("a turn that is sent back: what was typed vanishes and is never a message", async ({
    page,
  }) => {
    world = await startWorld();
    await openWithBot(page, world, "Reenvio");
    await watch(page);
    await send(page, "CASE-VIVO-REENVIO faça");

    await expect(
      page.getByTestId("message-bot").filter({ hasText: LIVE_TEXTS.resumo }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-testid="message-bot"][aria-busy="true"]')).toHaveCount(0);
    const seen = await seenOf(page);
    // It was typed at some point (the bubble existed) and is gone from the chat and from the record.
    expect(seen.states.some((s) => s.text.startsWith("Parei no meio"))).toBe(true);
    await expect(page.getByTestId("chat-log")).not.toContainText(LIVE_TEXTS.reenvio);
    expect(await recorded(world, "Reenvio")).toEqual([LIVE_TEXTS.resumo]);
    // Nothing of it comes back after a reload.
    await page.reload();
    await page.locator('[data-testid="bot-item"][data-bot="Reenvio"]').click();
    await expect(page.getByTestId("chat-log")).toContainText(LIVE_TEXTS.resumo);
    await expect(page.getByTestId("chat-log")).not.toContainText(LIVE_TEXTS.reenvio);
  });

  test("a refused finish: its summary is thrown away and only the accepted one stays", async ({
    page,
  }) => {
    world = await startWorld();
    await openWithBot(page, world, "Recusa");
    await watch(page);
    await send(page, "CASE-VIVO-RECUSA faça");

    await expect(
      page.getByTestId("message-bot").filter({ hasText: LIVE_TEXTS.resumo }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-testid="message-bot"][aria-busy="true"]')).toHaveCount(0);
    const seen = await seenOf(page);
    expect(
      seen.states.some((s) => LIVE_TEXTS.recusado.startsWith(s.text) && s.text.length > 10),
    ).toBe(true);
    // The refused summary leaves the chat by itself (the wait of a few seconds), and is never saved.
    await expect(page.getByTestId("chat-log")).not.toContainText(LIVE_TEXTS.recusado, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("message-bot")).toHaveCount(1);
    expect(await recorded(world, "Recusa")).toEqual([LIVE_TEXTS.resumo]);
  });

  for (const reduced of [false, true]) {
    test(`the mark at the end of the text ${reduced ? "does not blink with reduced motion" : "blinks"}`, async ({
      page,
    }) => {
      world = await startWorld();
      await openWithBot(page, world, "Quietinho");
      if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
      const markOf = () =>
        page.evaluate(() => {
          const last = document.querySelector(
            '[data-testid="message-bot"][data-typing="true"] .ui-typing > div > :last-child',
          );
          return last === null ? null : getComputedStyle(last, "::after").animationName;
        });

      await send(page, "CASE-VIVO-SIMPLES movimento");
      await expect.poll(markOf, { timeout: 60_000 }).not.toBeNull();
      if (reduced) expect(await markOf()).toBe("none");
      else expect(await markOf()).not.toBe("none");
      // The words come the same way: reduced motion only stills the mark.
      await expect(page.getByTestId("message-bot")).toContainText(LIVE_TEXTS.simples, {
        timeout: 60_000,
      });
      await expect(page.getByTestId("message-bot")).not.toHaveAttribute("aria-busy", "true");
    });
  }
});
