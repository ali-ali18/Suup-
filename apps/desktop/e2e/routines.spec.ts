import { expect, test } from "@playwright/test";
import type { Tool } from "@suup/core";
import { testTools } from "@suup/core/testing";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openApp, openSettings, selectBot, send } from "./helpers.js";

// Routines in the browser (docs/ROTINAS.md), against the real server and the scripted provider: the
// user asks in the chat, the bot creates the routine (the Auto-review reviewer lets it, because the
// user asked) and says when; the Rotinas panel shows it in words; the time is forced due, the
// worker fires it, the answer lands in the chat, and the routine's detail in the panel shows what
// the bot wrote (Markdown) with the icon of the site it read. Editar goes to the chat with a draft
// and the routine bound to it (never its id in the text): the bot changes THAT routine. Remover
// asks first. The screenshots are for the design review.

const usage = { inputTokens: 900, outputTokens: 90 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const run = (decision: string, reason: string) =>
  s({ calls: [{ name: "review_call", args: { decision, ruleId: null, reason } }] });

const SITE = "https://agenda.exemplo.com.br/hoje";
const RESULT = [
  "## Seu dia",
  "",
  "- **15h**: dentista",
  "- **18h**: entrega do relatório",
  "",
  "Nada mais na agenda.",
].join("\n");

/** A tool that declares the page it read, as `web_read` does (the test has no internet). */
const readPage: Tool<unknown> = (() => {
  const base = testTools().find((t) => t.name === "fixed") as Tool<unknown>;
  return {
    ...base,
    name: "ler_pagina_teste",
    description: "Lê a página da agenda (teste).",
    execute: async () => ({
      content: "Agenda de hoje: dentista às 15h, relatório às 18h.",
      source: { url: SITE, title: "Agenda de hoje" },
    }),
  };
})();

const SCRIPTS = {
  roteiro: {
    cases: [
      // The reviewer of the edit asked in the chat (the bot answers on the other provider).
      { whenObjectiveContains: "muda pra 7h", agent: [], autoReview: [run("run", "Você pediu.")] },
      {
        whenObjectiveContains: "vê meu calendário",
        agent: [
          s({
            calls: [
              {
                name: "create_routine",
                args: {
                  name: "Calendário da manhã",
                  instruction:
                    "ROTINA-CALENDARIO Veja o calendário de hoje do usuário e diga, em poucas linhas, o que ele tem.",
                  schedule: { kind: "daily", time: "08:00" },
                },
              },
            ],
          }),
          s({ text: "Combinado, vejo seu calendário todo dia às 8h. Quer outro horário?" }),
        ],
        autoReview: [run("run", "Você pediu esta rotina.")],
      },
      {
        whenObjectiveContains: "ROTINA-CALENDARIO",
        agent: [
          s({ calls: [{ name: "ler_pagina_teste", args: {} }] }),
          s({
            calls: [{ name: "update_routine_state", args: { state: "Avisei do dentista." } }],
          }),
          s({ text: RESULT }),
        ],
      },
    ],
  },
};

const shot = (name: string) => `screenshots/1440x900@2x/${name}.png`;

test.describe("routines", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  test.describe.configure({ mode: "serial" });
  // The user's computer is in Sao Paulo; the server's process is whatever it is.
  test.use({ timezoneId: "America/Sao_Paulo" });
  let world: World;
  let botId: string;
  test.beforeAll(async () => {
    world = await startWorld({
      scripts: SCRIPTS,
      autoReviewModel: "model-x",
      routinesEveryMs: 150,
      extraTools: [readPage],
    });
    const bot = await world.api.bots.create({
      name: "Agenda",
      description: "Cuida da agenda e dos compromissos.",
      personality: "Seja breve e organizado.",
      modelId: "model-x",
      allowedTools: ["ler_pagina_teste"],
      avatar: "mascot:clover",
      color: "azul",
    });
    botId = bot.id;
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("asked in the chat, the bot creates it and says when; the panel shows it in words", async ({
    page,
  }) => {
    await openApp(page, world);
    await selectBot(page, "Agenda");
    const panel = page.getByTestId("panel");
    await expect(panel.getByTestId("section-routines")).toContainText("Nenhuma rotina");
    await send(page, "vê meu calendário todo dia");
    await expect(page.getByTestId("chat-log")).toContainText(
      "Combinado, vejo seu calendário todo dia às 8h. Quer outro horário?",
    );
    const row = panel.getByTestId("routine-row");
    await expect(row).toHaveAttribute("data-routine", "Calendário da manhã");
    await expect(row.getByTestId("routine-schedule")).toHaveText("todo dia às 08:00");
    await expect(row.getByTestId("routine-next")).toContainText("Próxima:");
    await expect(row.getByTestId("routine-next")).toContainText("08:00");
    // no menu and no schedule form on the row
    await expect(panel.getByRole("button", { name: /Ações da rotina/ })).toHaveCount(0);
    // the app sent this computer's zone when it connected: the routine is in it
    const [routine] = await world.api.routines.list();
    expect(routine?.timeZone).toBe("America/Sao_Paulo");
    expect(routine?.nextRunAt?.endsWith("T11:00:00.000Z")).toBe(true);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("rotinas-painel-criada") });
  });

  test("it fires once; the detail shows what the bot wrote, in Markdown, with the site it read", async ({
    page,
  }) => {
    // Every image the page adds, as it is added (the browser of the test has no internet, so the
    // site's icon is asked for and then falls back to the generic one).
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __imgs: string[] }).__imgs = seen;
      const note = (node: Node) => {
        for (const img of node instanceof Element ? [node, ...node.querySelectorAll("img")] : []) {
          if (img instanceof HTMLImageElement) {
            seen.push(`${img.getAttribute("src")}|${img.getAttribute("referrerpolicy")}`);
          }
        }
      };
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) note(n);
      }).observe(document, { childList: true, subtree: true });
    });
    await openApp(page, world);
    await selectBot(page, "Agenda");
    await world.db.sql`update routines set next_run_at = now() - interval '1 second'`;
    await expect(page.getByTestId("chat-log")).toContainText("Nada mais na agenda.");
    const panel = page.getByTestId("panel");
    const row = panel.getByTestId("routine-row");
    await expect(row.getByTestId("routine-last")).toContainText("Concluída");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("rotinas-resultado-no-chat") });

    await row.click();
    const detail = panel.getByTestId("routine-detail");
    await expect(detail.getByRole("heading", { name: "Calendário da manhã" })).toBeVisible();
    await expect(panel.getByTestId("section-routines")).toHaveCount(0);
    await expect(detail.getByTestId("routine-fire")).toHaveCount(1);
    await expect(detail.getByTestId("routine-fire")).toHaveAttribute("data-status", "done");
    const result = detail.getByTestId("routine-result");
    // Markdown, as in the chat: a heading, bold, a list; no asterisks left
    await expect(result.getByText("Seu dia")).toBeVisible();
    await expect(result.locator("strong").first()).toHaveText("15h");
    await expect(result.locator("li")).toHaveCount(2);
    await expect(result).not.toContainText("**");
    // the site it read, from the backend; icons of sites are off: the generic one
    const source = detail.getByTestId("routine-source");
    await expect(source).toHaveText("agenda.exemplo.com.br");
    await expect(source).toHaveAttribute("href", SITE);
    await expect(source.locator("img")).toHaveCount(0);
    await expect(source.locator(".lucide-globe")).toHaveCount(1);
    // turned on in Configurações > Geral > Aparência: the site's own icon (the host only)
    await openSettings(page, "Geral");
    await page.getByTestId("setting-favicons").click();
    await expect(page.getByTestId("setting-favicons")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __imgs: string[] }).__imgs))
      .toContain("https://agenda.exemplo.com.br/favicon.ico|no-referrer");
    // the host only, never the page's path; and still exactly one icon in the chip
    await expect(source.locator("img, svg")).toHaveCount(1);
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot("rotinas-detalhe") });

    // pause and resume from the icons on top
    await detail.getByRole("button", { name: "Pausar a rotina" }).click();
    await expect(detail.getByTestId("routine-next")).toHaveText("Pausada");
    await page.waitForTimeout(200);
    await page.screenshot({ path: shot("rotinas-painel-pausada") });
    await detail.getByRole("button", { name: "Retomar a rotina" }).click();
    await expect(detail.getByTestId("routine-next")).toContainText("Próxima:");
    // back to the list
    await detail.getByRole("button", { name: "Voltar às rotinas" }).click();
    await expect(panel.getByTestId("routine-row")).toHaveCount(1);

    const [routine] = await world.api.routines.list();
    expect(routine?.state).toBe("Avisei do dentista.");
    const runs = (await world.api.runs.list({ botId: routine?.botId as string, limit: 10 })).items;
    expect(runs.map((r) => r.origin).sort()).toEqual(["routine", "user"]);
  });

  test("Editar goes to the chat with the draft; the bot changes THAT routine by its id", async ({
    page,
  }) => {
    const [routine] = await world.api.routines.list();
    const id = routine?.id as string;
    // The bot answers on a provider no one has used yet, whose script knows the id: the scripted
    // model updates the routine only if its id is in what it READS (only the harness's note has it).
    await world.script("outro", {
      cases: [
        {
          whenObjectiveContains: id,
          // A scripted answer is picked by how many assistant turns the conversation already has:
          // the history of this chat holds one (the bot's two messages, merged), so the first
          // answer of this run is the second step.
          agent: [
            s({ text: "(não usado: o histórico já tem uma resposta do bot)" }),
            s({
              calls: [
                {
                  name: "update_routine",
                  args: { routine: id, schedule: { kind: "daily", time: "07:00" } },
                },
              ],
            }),
            s({ text: "Pronto: agora vejo seu calendário todo dia às 7h." }),
          ],
        },
        {
          whenObjectiveContains: "muda pra 7h",
          agent: [s({ text: "(não usado)" }), s({ text: "Qual rotina?" })],
        },
      ],
    });
    await world.api.bots.update(botId, { modelId: "model-y" });

    await openApp(page, world);
    await selectBot(page, "Agenda");
    const panel = page.getByTestId("panel");
    await panel.getByTestId("routine-row").click();
    await panel.getByTestId("routine-edit").click();
    const box = page.getByLabel("Mensagem", { exact: true });
    const draft = "Editar a rotina “Calendário da manhã” (todo dia às 08:00): ";
    await expect(box).toHaveValue(draft);
    await expect(box).toBeFocused();
    expect(await box.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(
      draft.length,
    );
    const chip = page.getByTestId("draft-routine");
    await expect(chip).toContainText("Calendário da manhã");
    // the id is nowhere on screen
    expect(await page.locator("body").textContent()).not.toContain(id);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("rotinas-editar-pelo-chat") });

    await box.pressSequentially("muda pra 7h");
    await box.press("Enter");
    await expect(page.getByTestId("chat-log")).toContainText(
      "Pronto: agora vejo seu calendário todo dia às 7h.",
    );
    await expect(chip).toHaveCount(0);
    // the bubble shows only what was typed
    await expect(page.getByTestId("message-user").last()).toHaveText(`${draft}muda pra 7h`);
    expect(await page.locator("body").textContent()).not.toContain(id);
    await expect(panel.getByTestId("routine-schedule")).toHaveText("todo dia às 07:00");
    expect((await world.api.routines.get(id)).schedule).toEqual({ kind: "daily", time: "07:00" });
    const conversation = await world.api.bots.openConversation(botId);
    const mine = (await world.api.conversations.messages(conversation.id)).items
      .filter((m) => m.authorKind === "user")
      .at(-1);
    expect(mine?.routineRef).toEqual({ id });
    expect(mine?.text).not.toContain(id);
  });

  test("Remover asks first, then the routine is gone", async ({ page }) => {
    await openApp(page, world);
    await selectBot(page, "Agenda");
    const panel = page.getByTestId("panel");
    await panel.getByTestId("routine-row").click();
    await panel.getByTestId("routine-remove").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Remover a rotina?");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("rotinas-remover") });
    await dialog.getByTestId("routine-remove-confirm").click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByTestId("section-routines")).toContainText("Nenhuma rotina");
    expect(await world.api.routines.list()).toEqual([]);
    // what it already said stays in the chat
    await expect(page.getByTestId("chat-log")).toContainText("Nada mais na agenda.");
  });

  test("Configurações > Geral: the user's time zone, from this computer, can be changed", async ({
    page,
  }) => {
    await openApp(page, world);
    await openSettings(page, "Geral");
    await expect(page.getByTestId("time-zone")).toHaveText("America/Sao_Paulo");
    await expect(page.getByTestId("time-zone-source")).toHaveText("Do seu computador.");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot("rotinas-fuso-configuracoes") });
    await page.getByTestId("time-zone").click();
    await page.getByLabel("Filtrar: Fuso horário").fill("Lisbon");
    await page.getByRole("option", { name: "Europe/Lisbon" }).click();
    await expect(page.getByTestId("time-zone-source")).toHaveText("Escolhido por você.");
    expect((await world.api.info()).timeZone).toBe("Europe/Lisbon");
    // the computer's zone does not replace the user's choice on the next connection
    await page.reload();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.waitForTimeout(500);
    expect(await world.api.info()).toEqual({ timeZone: "Europe/Lisbon", timeZoneSource: "user" });
  });
});
