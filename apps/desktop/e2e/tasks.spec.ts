import { expect, type Locator, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openWithBot, send } from "./helpers.js";

// Tasks of a bot (KOD-68, docs/TAREFAS.md), in the browser, against the real server and the scripted
// provider: the bot opens a task for the long work, the chat stays free, a label above the bubble
// says "name · state" (one line, a reply stroke and a chat icon at its left), tapping it opens the task in the right panel (header, messages, the box "Adicione
// uma resposta" that writes straight to the task), and when the task ends the chat gets a short
// message. The cards of a task are decided in the chat, with the label of the task above them.
// The screenshots are for the design review against docs/DESIGN.md.

const usage = { inputTokens: 800, outputTokens: 90 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const open = (title: string, marker: string) =>
  s({
    calls: [
      {
        name: "start_task",
        args: {
          title,
          objective: `${marker}: faça o trabalho longo que o usuário pediu.`,
          deliver: "Um resumo curto do que foi feito.",
        },
      },
    ],
  });
const closing = s({ text: "A revisão terminou: três achados, e o principal está no login." });

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        // The turn that receives the report: the chat's earlier answers are turns of its history.
        whenObjectiveContains: "Report of the task",
        agent: Array.from({ length: 8 }, () => closing),
      },
      {
        // Before the cases that open a task: the chat history of those carries their words too.
        whenObjectiveContains: "CASE-OI",
        agent: Array.from({ length: 8 }, () =>
          s({ text: "Oi! Estou aqui, me diga o que precisa." }),
        ),
      },
      {
        whenObjectiveContains: "TAREFA-REVISAO",
        agent: [
          s({
            text: "Comecei a olhar o projeto.",
            calls: [{ name: "escalate", args: { question: "Qual pasta devo revisar primeiro?" } }],
          }),
          s({ text: "Revisão pronta: três achados, o principal está no login." }),
        ],
      },
      {
        whenObjectiveContains: "TAREFA-ARQUIVO",
        agent: [
          s({
            text: "Vou gravar o relatório.",
            calls: [
              { name: "write_file", args: { path: "relatorio.txt", content: "três achados" } },
            ],
          }),
          s({ text: "Relatório gravado." }),
        ],
      },
      {
        whenObjectiveContains: "TAREFA-LONGA",
        agent: [s({ text: "Esta resposta nunca deve chegar.", delayMs: 120_000 })],
      },
      {
        whenObjectiveContains: "CASE-PARAR",
        agent: [
          open("Compilar o relatório mensal", "TAREFA-LONGA"),
          s({ text: "Abri uma tarefa para compilar o relatório." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-DUAS",
        agent: [
          s({
            calls: [
              ...open("Compilar o relatório mensal", "TAREFA-LONGA").calls,
              ...open("Revisar o projeto", "TAREFA-REVISAO").calls,
            ],
          }),
          s({ text: "Abri duas tarefas, uma compila e outra revisa." }),
        ],
      },
      {
        whenObjectiveContains: "TAREFA-CURTA",
        agent: [s({ text: "Feito: o relatório está pronto." })],
      },
      {
        whenObjectiveContains: "CASE-TRES",
        agent: [
          s({
            calls: [
              ...open("Compilar o relatório mensal", "TAREFA-LONGA").calls,
              ...open("Revisar o projeto", "TAREFA-REVISAO").calls,
              ...open("Resumir as notas", "TAREFA-CURTA").calls,
            ],
          }),
          s({ text: "Abri três tarefas." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-REVISAO",
        agent: [
          open("Revisar o projeto", "TAREFA-REVISAO"),
          s({ text: "Abri uma tarefa para revisar o projeto. O resultado volta aqui." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-LONGO",
        agent: [
          open("Implementar a revisão completa do projeto inteiro", "TAREFA-REVISAO"),
          s({ text: "O CI ainda não terminou: o build passou e o check principal ainda roda." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-ARQUIVO",
        agent: [
          open("Gravar o relatório", "TAREFA-ARQUIVO"),
          s({ text: "Abri uma tarefa para gravar o relatório." }),
        ],
      },
    ],
  },
};

const shot = (name: string) => `screenshots/kod-68-${name}.png`;
const label = (page: Page) => page.getByTestId("task-label");

/** The gap name to dot equals the gap dot to state (within 1 px): the dot is its own element. */
async function expectDotCentred(tag: Locator) {
  const name = await tag.getByTestId("task-label-name").boundingBox();
  const dot = await tag.getByTestId("task-label-dot").boundingBox();
  const state = await tag.getByTestId("task-label-state").boundingBox();
  const before = (dot?.x ?? 0) - ((name?.x ?? 0) + (name?.width ?? 0));
  const after = (state?.x ?? 0) - ((dot?.x ?? 0) + (dot?.width ?? 0));
  expect(before).toBeGreaterThan(0);
  expect(Math.abs(before - after)).toBeLessThanOrEqual(1);
}

test.describe("tasks of a bot", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  test.describe.configure({ mode: "serial" });
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ scripts: SCRIPTS });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("opens a task from the chat, labels it, opens its view, replies there and the chat gets the result", async ({
    page,
  }) => {
    await openWithBot(page, world, "Ajudante");
    await send(page, "CASE-REVISAO revise o projeto inteiro, por favor");

    // The bot says it opened a task; the label sits ABOVE that bubble, with the task's state.
    const bubble = page
      .getByTestId("message-bot")
      .filter({ hasText: "Abri uma tarefa para revisar o projeto" });
    await expect(bubble).toBeVisible();
    await expect(label(page)).toHaveCount(1);
    // The task asks something: its question is for ITS view, not the chat; the label says it waits.
    await expect(label(page)).toHaveAttribute("data-task-state", "waiting_user");
    // The task posted while you are in the chat: the label says "Novas respostas", in the unread
    // blue (the colour of the avatar's dot), instead of the state, until you open the task.
    await expect(label(page)).toHaveAttribute("title", "Revisar o projeto · Novas respostas");
    await expect(label(page)).toHaveAttribute("data-task-unread", "true");
    const unreadColour = await label(page)
      .getByTestId("task-label-state")
      .evaluate((el) => getComputedStyle(el).color);
    expect(unreadColour).toBe("rgb(36, 150, 232)");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Qual pasta devo revisar primeiro?" }),
    ).toHaveCount(0);
    // The message that opened the task carries its link inside the bubble: the outline chat icon and
    // the name, underlined, in the text colour (never blue).
    const link = bubble.getByTestId("task-link");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText("Revisar o projeto");
    const linkLook = await link.evaluate((el) => {
      const name = el.querySelector("span") as HTMLElement;
      return {
        line: getComputedStyle(name).textDecorationLine,
        colour: getComputedStyle(el).color,
        text: getComputedStyle(el.closest("[data-testid=bubble-bot]") as HTMLElement).color,
        icon: el.querySelector("svg") !== null,
      };
    });
    expect(linkLook.line).toContain("underline");
    expect(linkLook.colour).toBe(linkLook.text);
    expect(linkLook.icon).toBe(true);
    // The bubble's text is fully shown before the capture.
    await expect(bubble).toContainText("O resultado volta aqui.");
    await page.waitForTimeout(600);
    await page.screenshot({ path: shot("novas-respostas") });

    // Geometry: the label is above the bubble, on its left edge, and is not a bubble itself.
    const lb = await label(page).boundingBox();
    const bb = await bubble.getByTestId("bubble-bot").boundingBox();
    expect(lb && bb).toBeTruthy();
    expect((lb?.y ?? 0) + (lb?.height ?? 0)).toBeLessThanOrEqual((bb?.y ?? 0) + 1);
    expect(Math.abs((lb?.x ?? 0) - (bb?.x ?? 0))).toBeLessThanOrEqual(8);
    expect(lb?.height ?? 99).toBeLessThanOrEqual(24);
    // One line, no box: transparent background, no border, text smaller than the message's.
    const look = await label(page).evaluate((el) => {
      const c = getComputedStyle(el);
      return { bg: c.backgroundColor, border: c.borderTopWidth, size: parseFloat(c.fontSize) };
    });
    expect(look.bg).toBe("rgba(0, 0, 0, 0)");
    expect(look.border).toBe("0px");
    const msgSize = await bubble
      .getByTestId("bubble-bot")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(look.size).toBeLessThan(msgSize);
    // The reply stroke is at the left, inside the label, and ends right above the bubble's top-left.
    const sb = await label(page).getByTestId("task-label-stroke").boundingBox();
    const ib = await label(page).locator("svg").last().boundingBox();
    expect(sb && ib).toBeTruthy();
    // A visible horizontal gap (about 8 px) between the stroke's end and the icon.
    const iconGap = (ib?.x ?? 0) - ((sb?.x ?? 0) + (sb?.width ?? 0));
    expect(iconGap).toBeGreaterThanOrEqual(4);
    expect(iconGap).toBeLessThanOrEqual(12);
    expect(Math.abs((sb?.x ?? 0) - (bb?.x ?? 0))).toBeLessThanOrEqual(40);
    // It ends just above the bubble: never inside its box (bottom <= bubble top), and not far from it.
    const strokeBottom = (sb?.y ?? 0) + (sb?.height ?? 0);
    expect(strokeBottom).toBeLessThanOrEqual(bb?.y ?? 0);
    expect(strokeBottom).toBeGreaterThanOrEqual((bb?.y ?? 0) - 6);
    // Drawn as an SVG with round line caps and a stroke at least 2 px thick.
    const strokeLook = await label(page)
      .getByTestId("task-label-stroke")
      .evaluate((el) => {
        const c = getComputedStyle(el);
        return { cap: c.strokeLinecap, width: parseFloat(c.strokeWidth) };
      });
    expect(strokeLook.cap).toBe("round");
    expect(strokeLook.width).toBeGreaterThanOrEqual(2);
    // A small gap (about 4 px) between the stroke's right tip and the LEFT edge of the hover pill.
    const pill = await label(page).getByTestId("task-label-body").boundingBox();
    const pillGap = (pill?.x ?? 0) - ((sb?.x ?? 0) + (sb?.width ?? 0));
    expect(pillGap).toBeGreaterThanOrEqual(2);
    expect(pillGap).toBeLessThanOrEqual(6);
    // The "·" has the same space before it as after it (full name).
    await expectDotCentred(label(page));
    await page.screenshot({ path: shot("rotulo-no-chat") });
    // Hover: a gray background shows on the label's body (none at rest), with no layout shift.
    const body = label(page).getByTestId("task-label-body");
    const rest = await body.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(rest).toBe("rgba(0, 0, 0, 0)");
    await label(page).hover();
    await expect
      .poll(() => body.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe("rgba(0, 0, 0, 0)");
    const hover = await label(page).boundingBox();
    expect(hover?.x).toBe(lb?.x);
    expect(hover?.width).toBe(lb?.width);
    expect(hover?.height).toBe(lb?.height);
    await page.screenshot({ path: shot("rotulo-hover") });
    await page.mouse.move(5, 5);

    // The chat stays free while the task waits: a new message gets its own answer.
    await send(page, "CASE-OI tudo bem?");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Oi! Estou aqui, me diga o que precisa." }),
    ).toBeVisible();
    // That answer is not from the task: no label on it.
    await expect(label(page)).toHaveCount(1);

    // Tapping the label opens the task in the RIGHT panel, like a thread: the chat stays in the middle.
    await label(page).click();
    const view = page.getByTestId("task-panel");
    await expect(view).toBeVisible();
    await expect(page.getByTestId("panel")).toHaveCount(0);
    await expect(page.getByTestId("chat-composer")).toBeVisible();
    await expect(page.getByTestId("chat-log").first()).toContainText("CASE-REVISAO");
    // Header: only the name, the state and the close (the "Parar" is in the overflow menu).
    await expect(view.getByTestId("task-title")).toHaveText("Revisar o projeto");
    await expect(view.getByTestId("task-state")).toHaveText("Aguardando sua resposta");
    await expect(view.getByTestId("task-back")).toBeVisible();
    await expect(view.getByTestId("task-stop")).toHaveCount(0);
    // One single bar: the pill is truly centred in the panel (like the bot's pill in the chat), the
    // state is inside it, the back arrow at the left and the menu at the right.
    const pillBox = await view.getByTestId("task-pill").boundingBox();
    const botPill = await page.getByTestId("bot-chip").boundingBox();
    const panelBox = await view.boundingBox();
    const closeBox = await view.getByTestId("task-back").boundingBox();
    const menuBox = await view.getByRole("button", { name: "Mais opções da tarefa" }).boundingBox();
    const stateBox = await view.getByTestId("task-state").boundingBox();
    expect(
      Math.abs(
        (pillBox?.x ?? 0) +
          (pillBox?.width ?? 0) / 2 -
          ((panelBox?.x ?? 0) + (panelBox?.width ?? 0) / 2),
      ),
    ).toBeLessThanOrEqual(2);
    expect(pillBox?.height).toBe(botPill?.height);
    expect(Math.abs((pillBox?.y ?? 0) - (botPill?.y ?? 0))).toBeLessThanOrEqual(2);
    expect((stateBox?.x ?? 0) >= (pillBox?.x ?? 0)).toBe(true);
    expect(
      (stateBox?.x ?? 0) + (stateBox?.width ?? 0) <= (pillBox?.x ?? 0) + (pillBox?.width ?? 0),
    ).toBe(true);
    // The back arrow is at the left of the pill and the menu at its right, on the pill's line.
    const centreY = (b: { y: number; height: number } | null) => (b?.y ?? 0) + (b?.height ?? 0) / 2;
    expect(Math.abs(centreY(closeBox) - centreY(pillBox))).toBeLessThanOrEqual(2);
    expect(Math.abs(centreY(menuBox) - centreY(pillBox))).toBeLessThanOrEqual(2);
    expect((closeBox?.x ?? 0) + (closeBox?.width ?? 0)).toBeLessThanOrEqual(pillBox?.x ?? 0);
    expect((menuBox?.x ?? 0) >= (pillBox?.x ?? 0) + (pillBox?.width ?? 0)).toBe(true);
    await expect(page.getByText("Dados da tarefa")).toHaveCount(0);
    await expect(view.getByText("US$")).toHaveCount(0);
    // The panel starts with what gave rise to the task, as ordinary chat bubbles: the user's message
    // (right, accent) and the bot's words that opened it (left); no quote, no label between them.
    await expect(view.getByTestId("task-request")).toHaveCount(0);
    await expect(view.getByText("Ver na conversa")).toHaveCount(0);
    await expect(view.getByTestId("task-label")).toHaveCount(0);
    const originUser = view.getByTestId("message-user").first();
    await expect(originUser).toContainText("CASE-REVISAO revise o projeto inteiro, por favor");
    const originBot = view.getByTestId("message-bot").first();
    await expect(originBot).toContainText("Abri uma tarefa para revisar o projeto");
    const hb = await view.getByTestId("task-head").boundingBox();
    const ub = await originUser.getByTestId("bubble-user").boundingBox();
    const ob = await originBot.getByTestId("bubble-bot").boundingBox();
    expect((ub?.y ?? 0) >= (hb?.y ?? 0) + (hb?.height ?? 0) - 1).toBe(true);
    expect((ob?.y ?? 0) > (ub?.y ?? 0)).toBe(true);
    // The user's bubble hangs at the right and the bot's at the left, as in the chat.
    expect((ub?.x ?? 0) + (ub?.width ?? 0) / 2).toBeGreaterThan(
      (ob?.x ?? 0) + (ob?.width ?? 0) / 2,
    );
    const originOrder = await view
      .getByTestId("message-bot")
      .filter({ hasText: "Comecei a olhar o projeto." })
      .boundingBox();
    expect((originOrder?.y ?? 0) > (ob?.y ?? 0)).toBe(true);
    // The pending question is a normal question card of the log, and the avatar line is not drawn.
    await expect(view.getByTestId("working-wrap")).toHaveCount(0);
    await expect(
      view.getByTestId("message-bot").filter({ hasText: "Qual pasta devo revisar primeiro?" }),
    ).toBeVisible();
    await expect(
      view.getByTestId("message-bot").filter({ hasText: "Comecei a olhar o projeto." }),
    ).toBeVisible();
    const box = view.getByPlaceholder("Adicione uma resposta");
    await expect(box).toBeEnabled();
    // The panel is inside the window and the chat keeps its width.
    const vb = await view.boundingBox();
    const pageWidth = page.viewportSize()?.width ?? 0;
    expect((vb?.x ?? 0) + (vb?.width ?? 0)).toBeLessThanOrEqual(pageWidth);
    expect((await page.getByTestId("chat-composer").boundingBox())?.width ?? 0).toBeGreaterThan(
      380,
    );
    // Opening it marked the task read: "Novas respostas" is gone from the label and the header.
    await expect(page.locator("[data-task-unread]")).toHaveCount(0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot("painel-pergunta") });

    // The reply goes straight to the task (no chat message), and the task finishes with it.
    await box.fill("Comece pela pasta src.");
    await box.press("Enter");
    await expect(
      view.getByTestId("message-user").filter({ hasText: "Comece pela pasta src." }),
    ).toBeVisible();
    await expect(view.getByTestId("task-state")).toHaveText("Concluída");
    // The sidebar: a finished task whose replies are read leaves the list under the bot.
    await expect(page.getByTestId("sidebar-task")).toHaveCount(0);
    await expect(
      view.getByTestId("message-bot").filter({ hasText: "Revisão pronta: três achados" }),
    ).toBeVisible();
    // A finished task shows a quiet notice, no box to type in.
    await expect(view.getByTestId("task-finished")).toHaveText("Esta tarefa terminou.");
    await expect(view.getByRole("textbox")).toHaveCount(0);
    // Nothing to stop any more: no overflow menu.
    await expect(view.getByRole("button", { name: "Mais opções da tarefa" })).toHaveCount(0);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shot("painel-concluida") });

    // The back arrow returns to the bot's list of tasks.
    await view.getByTestId("task-back").click();
    await expect(view).toHaveCount(0);
    await expect(page.getByTestId("panel")).toBeVisible();
    await expect(page.getByTestId("tasks-tab")).toBeVisible();
    const result = page
      .getByTestId("message-bot")
      .filter({ hasText: "A revisão terminou: três achados" });
    await expect(result).toBeVisible();
    await expect(page.getByTestId("chat-log").first()).not.toContainText("Comece pela pasta src.");
    await expect(result.getByTestId("task-label")).toHaveAttribute(
      "title",
      "Revisar o projeto · Concluída",
    );
    await expect(label(page).first()).toHaveAttribute("data-task-state", "done");
    await expect(page.locator("[data-task-unread]")).toHaveCount(0);
    // The result message has the link too, and it opens the task in the panel.
    const resultLink = result.getByTestId("task-link");
    await expect(resultLink).toHaveText("Revisar o projeto");
    await page.screenshot({ path: shot("resultado-no-chat") });
    await result.screenshot({ path: shot("link-na-mensagem") });
    await resultLink.click();
    await expect(page.getByTestId("task-panel")).toBeVisible();
    await page.getByTestId("task-back").click();
    await expect(page.getByTestId("panel")).toBeVisible();
  });

  test("the approval card of a task appears in the chat that asked, with the name of the task above", async ({
    page,
  }) => {
    await openWithBot(page, world, "Gravador");
    await send(page, "CASE-ARQUIVO grave o relatório");
    const card = page.getByTestId("approval-card");
    await expect(card).toBeVisible();
    // The label of the task is right above the card, and says the task waits for the approval.
    const tag = page.getByTestId("message-bot").filter({ has: card }).getByTestId("task-label");
    await expect(tag).toHaveAttribute("title", "Gravar o relatório · Aguardando sua aprovação");
    const tb = await tag.boundingBox();
    const cb = await card.boundingBox();
    expect((tb?.y ?? 0) + (tb?.height ?? 0)).toBeLessThanOrEqual((cb?.y ?? 0) + 1);
    await page.screenshot({ path: shot("aprovacao-da-tarefa") });
    // Decided the normal way, in the chat; the task goes on and ends.
    await card.getByTestId("approval-approve").click();
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "A revisão terminou" }),
    ).toBeVisible();
    // The task brought words you have not read: until you open it, the label says so.
    await expect(page.getByTestId("task-label").last()).toContainText("Novas respostas");
    await expect(page.getByTestId("task-label").last()).toHaveAttribute("data-task-state", "done");
    // Opening the task in the panel marks it read.
    await page.getByTestId("task-label").last().click();
    await expect(page.getByTestId("task-panel")).toBeVisible();
    await expect(page.locator("[data-task-unread]")).toHaveCount(0);
  });

  test("a long task name is cut with an ellipsis and the state stays whole", async ({ page }) => {
    await openWithBot(page, world, "Comprido");
    await send(page, "CASE-LONGO confira o CI");
    const tag = label(page);
    await expect(tag).toHaveCount(1);
    await expect(tag).toHaveAttribute(
      "title",
      "Implementar a revisão completa do projeto inteiro · Novas respostas",
    );
    await expect(tag).toHaveAttribute(
      "aria-label",
      "Abrir a tarefa: Implementar a revisão completa do projeto inteiro · Novas respostas",
    );
    const name = tag.getByTestId("task-label-name");
    const cut = await name.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(cut).toBe(true);
    const lb = await tag.boundingBox();
    expect(lb?.height ?? 99).toBeLessThanOrEqual(24);
    await expect(tag.getByTestId("task-label-state")).toHaveText("Novas respostas");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "o check principal ainda roda." }),
    ).toBeVisible();
    await page.waitForTimeout(600);
    // The same space on both sides of the "·" with the name cut by an ellipsis.
    await expectDotCentred(tag);
    await page.screenshot({ path: shot("rotulo-nome-longo") });
    // Keyboard: Tab to the label and Enter opens the task panel.
    await tag.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("task-panel")).toBeVisible();
  });

  test("the Tarefas tab of the bot's profile lists its tasks by day, the finished ones apart", async ({
    page,
  }) => {
    await openWithBot(page, world, "Dupla");
    const tab = page.getByRole("tab", { name: "Tarefas" });
    await tab.click();
    // No task yet: the empty notice, in the style of "Nenhuma rotina".
    await expect(page.getByTestId("tasks-empty")).toContainText("Nenhuma tarefa");
    await expect(page.getByTestId("tasks-empty")).toContainText(
      "Peça um trabalho longo no chat e ele vira uma tarefa.",
    );
    await send(page, "CASE-TRES abra as três tarefas");
    const rows = page.getByTestId("task-row");
    // One working and one waiting, by day; the finished one in the closed group "Resolvidas · 1".
    await expect(rows).toHaveCount(2);
    await expect(rows.and(page.locator('[data-task-state="working"]'))).toHaveCount(1);
    await expect(rows.and(page.locator('[data-task-state="waiting_user"]'))).toHaveCount(1);
    await expect(page.getByTestId("tasks-day")).toHaveCount(1);
    await expect(page.getByTestId("tasks-day")).toHaveAttribute("data-day", "Hoje");
    await expect(page.getByTestId("tasks-resolved-toggle")).toHaveText("Resolvidas · 1");
    // No task rows in the sidebar.
    await expect(page.getByTestId("sidebar-task")).toHaveCount(0);
    // Each row: the generated face, the name, the state whole and coloured by a status token, and
    // the time at the right.
    await expect(rows.getByTestId("task-avatar")).toHaveCount(2);
    const cut = await rows
      .getByTestId("task-row-state")
      .evaluateAll((els) => els.map((el) => el.scrollWidth > el.clientWidth));
    expect(cut).toEqual([false, false]);
    const working = rows.and(page.locator('[data-task-state="working"]'));
    const waiting = rows.and(page.locator('[data-task-state="waiting_user"]'));
    await expect(working.getByTestId("task-row-state")).toHaveText("Trabalhando…");
    // The task asked something the person has not seen yet: "Novas respostas" (blue). Once seen
    // (the read cursor), the state line is the amber "Aguardando sua resposta".
    await expect(waiting.getByTestId("task-row-state")).toHaveText("Novas respostas");
    await world.api.tasks.markRead((await waiting.getAttribute("data-task")) ?? "");
    await expect(waiting.getByTestId("task-row-state")).toHaveText("Aguardando sua resposta");
    const colourOf = (row: Locator) =>
      row.getByTestId("task-row-state").evaluate((el) => getComputedStyle(el).color);
    expect(await colourOf(waiting)).not.toBe(await colourOf(working));
    await expect(working.getByTestId("task-row-time")).not.toHaveText("");
    // Open the group: the finished task, with "Novas respostas" (its result is not read yet) in blue.
    await page.getByTestId("tasks-resolved-toggle").click();
    const done = rows.and(page.locator('[data-task-state="done"]'));
    await expect(done).toHaveCount(1);
    await expect(done.getByTestId("task-row-state")).toHaveText("Novas respostas");
    expect(await colourOf(done)).toBe("rgb(36, 150, 232)");
    // Read: the plain state, "Concluída", in the success green.
    await world.api.tasks.markRead((await done.getAttribute("data-task")) ?? "");
    await expect(done.getByTestId("task-row-state")).toHaveText("Concluída");
    expect(await colourOf(done)).toBe("rgb(74, 222, 128)");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "o principal está no login" }),
    ).toBeVisible();
    const faces = async () =>
      rows.evaluateAll((els) =>
        Object.fromEntries(
          els.map((el) => {
            const svg = el.querySelector("[data-testid=task-avatar]");
            return [
              el.getAttribute("data-task"),
              `${svg?.getAttribute("data-face")}/${svg?.getAttribute("data-color")}`,
            ];
          }),
        ),
      );
    const before = await faces();
    expect(new Set(Object.values(before)).size).toBe(3);
    await page.waitForTimeout(800);
    await page.screenshot({ path: shot("aba-tarefas") });
    // The same task is the same face after a reload.
    await page.reload();
    await page.getByTestId("bot-item").filter({ hasText: "Dupla" }).click();
    await page.getByRole("tab", { name: "Tarefas" }).click();
    await page.getByTestId("tasks-resolved-toggle").click();
    await expect(page.getByTestId("task-row")).toHaveCount(3);
    expect(await faces()).toEqual(before);
    // A row opens the task in the third column; the back arrow returns to the list.
    await rows.filter({ hasText: "Revisar o projeto" }).click();
    const panel = page.getByTestId("task-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("task-title")).toHaveText("Revisar o projeto");
    await expect(page.getByTestId("tasks-tab")).toHaveCount(0);
    await expect(page.getByTestId("chat-composer")).toBeVisible();
    await panel.getByTestId("task-back").click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId("tasks-tab")).toBeVisible();
  });

  test("Parar, in the overflow menu of the task panel, stops a working task", async ({ page }) => {
    await openWithBot(page, world, "Parador");
    await send(page, "CASE-PARAR compile o relatório");
    await expect(label(page)).toHaveCount(1);
    await label(page).click();
    const view = page.getByTestId("task-panel");
    await expect(view).toBeVisible();
    await expect(view.getByTestId("task-title")).toHaveText("Compilar o relatório mensal");
    await expect(view.getByTestId("task-state")).toHaveText("Trabalhando…");
    await view.getByRole("button", { name: "Mais opções da tarefa" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot("painel-rodando-menu") });
    await page.getByTestId("task-stop").click();
    await expect(view.getByTestId("task-state")).toHaveText("Parada");
    await expect(view.getByRole("button", { name: "Mais opções da tarefa" })).toHaveCount(0);
    await expect(view.getByTestId("task-finished")).toBeVisible();
    await expect(view.getByRole("textbox")).toHaveCount(0);
    await page.screenshot({ path: shot("painel-parada") });
  });
});
