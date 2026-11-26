import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openWithBot, send } from "./helpers.js";

// Tasks of a bot (KOD-68, docs/TAREFAS.md), in the browser, against the real server and the scripted
// provider: the bot opens a task for the long work, the chat stays free, a label above the bubble
// says "name · state" (one line, a reply stroke and a chat icon at its left), tapping it opens the task's own view (header, messages, the box "Adicione
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
    await expect(label(page)).toHaveText("Revisar o projeto · Aguardando sua resposta");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Qual pasta devo revisar primeiro?" }),
    ).toHaveCount(0);

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
    expect((ib?.x ?? 0) - ((sb?.x ?? 0) + (sb?.width ?? 0))).toBeGreaterThanOrEqual(4);
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
    // A clear gap (about 8 px) between the stroke's right tip and the LEFT edge of the hover pill.
    const pill = await label(page).getByTestId("task-label-body").boundingBox();
    expect((pill?.x ?? 0) - ((sb?.x ?? 0) + (sb?.width ?? 0))).toBeGreaterThanOrEqual(6);
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

    // Tapping the label opens the task's own view: title, state, number of updates, its messages.
    await label(page).click();
    const view = page.getByTestId("task-view");
    await expect(view).toBeVisible();
    await expect(view.getByTestId("task-title")).toHaveText("Revisar o projeto");
    await expect(view.getByTestId("task-state")).toHaveText("Aguardando sua resposta");
    await expect(view.getByTestId("task-updates")).toHaveText("2 atualizações");
    await expect(
      view.getByTestId("message-bot").filter({ hasText: "Comecei a olhar o projeto." }),
    ).toBeVisible();
    // An open question (no options) is the bot's bubble, as in any chat.
    await expect(
      view.getByTestId("message-bot").filter({ hasText: "Qual pasta devo revisar primeiro?" }),
    ).toBeVisible();
    // The chat is not on screen meanwhile (the view takes its place) and the box is the task's.
    await expect(page.getByTestId("chat-composer")).toHaveCount(0);
    const box = view.getByPlaceholder("Adicione uma resposta");
    await expect(box).toBeEnabled();
    // The view fits the window and the header is inside it.
    const vb = await view.boundingBox();
    const hb = await view.getByTestId("task-head").boundingBox();
    expect((hb?.x ?? 0) >= (vb?.x ?? 0)).toBe(true);
    expect((hb?.y ?? 0) + (hb?.height ?? 0)).toBeLessThanOrEqual((vb?.y ?? 0) + 72);
    expect((vb?.width ?? 0) <= 1440).toBe(true);
    await page.screenshot({ path: shot("tarefa-aberta") });

    // The reply goes straight to the task (no chat message), and the task finishes with it.
    await box.fill("Comece pela pasta src.");
    await box.press("Enter");
    await expect(
      view.getByTestId("message-user").filter({ hasText: "Comece pela pasta src." }),
    ).toBeVisible();
    await expect(view.getByTestId("task-state")).toHaveText("Concluída");
    await expect(
      view.getByTestId("message-bot").filter({ hasText: "Revisão pronta: três achados" }),
    ).toBeVisible();
    // A task that ended takes no reply.
    await expect(view.getByPlaceholder("Esta tarefa terminou")).toBeDisabled();
    await page.screenshot({ path: shot("tarefa-concluida") });

    // Back to the chat: the short message of the result, with the label of the finished task.
    await view.getByTestId("task-back").click();
    await expect(view).toHaveCount(0);
    const result = page
      .getByTestId("message-bot")
      .filter({ hasText: "A revisão terminou: três achados" });
    await expect(result).toBeVisible();
    await expect(page.getByTestId("chat-log")).not.toContainText("Comece pela pasta src.");
    await expect(result.getByTestId("task-label")).toHaveText("Revisar o projeto · Concluída");
    // The opening bubble's label changed with the task, too.
    await expect(label(page).first()).toHaveAttribute("data-task-state", "done");
    await page.screenshot({ path: shot("resultado-no-chat") });
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
    await expect(tag).toHaveText("Gravar o relatório · Aguardando sua aprovação");
    const tb = await tag.boundingBox();
    const cb = await card.boundingBox();
    expect((tb?.y ?? 0) + (tb?.height ?? 0)).toBeLessThanOrEqual((cb?.y ?? 0) + 1);
    await page.screenshot({ path: shot("aprovacao-da-tarefa") });
    // Decided the normal way, in the chat; the task goes on and ends.
    await card.getByTestId("approval-approve").click();
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "A revisão terminou" }),
    ).toBeVisible();
    await expect(page.getByTestId("task-label").last()).toContainText("Concluída");
  });

  test("a long task name is cut with an ellipsis and the state stays whole", async ({ page }) => {
    await openWithBot(page, world, "Comprido");
    await send(page, "CASE-LONGO confira o CI");
    const tag = label(page);
    await expect(tag).toHaveCount(1);
    await expect(tag).toHaveAttribute(
      "title",
      "Implementar a revisão completa do projeto inteiro · Aguardando sua resposta",
    );
    await expect(tag).toHaveAttribute(
      "aria-label",
      "Abrir a tarefa: Implementar a revisão completa do projeto inteiro · Aguardando sua resposta",
    );
    const name = tag.getByTestId("task-label-name");
    const cut = await name.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(cut).toBe(true);
    const lb = await tag.boundingBox();
    expect(lb?.height ?? 99).toBeLessThanOrEqual(24);
    await expect(tag).toContainText("· Aguardando sua resposta");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "o check principal ainda roda." }),
    ).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: shot("rotulo-nome-longo") });
    // Keyboard: Tab to the label and Enter opens the task's view.
    await tag.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("task-view")).toBeVisible();
  });
});
