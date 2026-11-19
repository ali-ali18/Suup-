import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { openWithBot, send } from "./helpers.js";

// The bot comes back by itself (docs/RETORNO.md), seen from the chat. The owner's rule: the return
// has NO marker of its own in the interface. The bot says it in its own message ("volto em 1
// minuto"); when the time comes, the run wakes and the next message arrives in the same chat.
// The test never waits a minute: the instant is moved into the past in the database, and the job of
// the worker (another runtime on the same database) wakes the run.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-VOLTA",
        agent: [
          s({
            calls: [
              {
                name: "schedule_return",
                args: { inMinutes: 1, note: "Conferir o deploy e contar ao usuário." },
              },
            ],
          }),
          s({ text: "Disparei o deploy, volto em 1 minuto para conferir." }),
          s({ text: "O deploy terminou e deu tudo certo." }),
        ],
      },
    ],
  },
};

test.describe("o bot volta sozinho", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ scripts: SCRIPTS, wakeEveryMs: 100 });
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("a mensagem do bot avisa; na hora, a resposta chega na mesma conversa, sem nenhuma marca", async ({
    page,
  }) => {
    await openWithBot(page, world, "Voltador");
    await send(page, "CASE-VOLTA faça o deploy");

    // The warning is the bot's own bubble.
    const bot = page.getByTestId("message-bot");
    await expect(bot.filter({ hasText: "volto em 1 minuto" })).toBeVisible();
    // The run is parked (a diagnostic fact the app never draws).
    await expect
      .poll(async () => (await world.api.runs.list({ limit: 5 })).items[0]?.status)
      .toBe("waiting_timer");

    // Calm: no working indicator, no chip of the bot, no ended line, no notice, no word of "retorno".
    await expect(page.getByTestId("working-indicator")).toHaveCount(0);
    await expect(page.getByTestId("bot-chip")).toHaveAttribute("data-run", "");
    await expect(page.getByTestId("ended-line")).toHaveCount(0);
    const chat = page.getByTestId("chat");
    await expect(chat).not.toContainText("agendad");
    await expect(chat).not.toContainText("schedule_return");
    await expect(page.getByTestId("message-user")).toHaveCount(1);
    await expect(bot).toHaveCount(1);

    // The time comes (moved into the past); the worker wakes the same run.
    const run = (await world.api.runs.list({ limit: 5 })).items[0];
    await world.db
      .sql`update runs set wake_at = now() - interval '1 minute' where id = ${run?.id as string} and status = 'waiting_timer'`;
    await expect(bot.filter({ hasText: "O deploy terminou e deu tudo certo." })).toBeVisible();
    await expect(bot).toHaveCount(2);
    await expect(page.getByTestId("message-user")).toHaveCount(1);
    // Still nothing but messages: no marker appeared for the return, and nothing is working.
    await expect(page.getByTestId("working-indicator")).toHaveCount(0);
    await expect(page.getByTestId("ended-line")).toHaveCount(0);
    await expect(chat).not.toContainText("agendad");
    await expect(chat).not.toContainText("schedule_return");
    await expect(page.getByTestId("bot-chip")).toHaveAttribute("data-run", "");

    // The same run did it all.
    const finished = await world.api.runs.get(run?.id as string);
    expect(finished.status).toBe("done");
    expect(finished.wakeAt ?? null).toBeNull();
  });
});
