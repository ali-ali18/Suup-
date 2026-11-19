import { expect, type Page, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import { connect, selectBot, send } from "./helpers.js";

// Takes a screenshot of each main screen from a real run of the app, for the visual review against
// the owner's references (1920x1080) and for the design review (1440x900 at 2x).

const SIZES = [
  { dir: "1920x1080", viewport: { width: 1920, height: 1080 }, scale: 1 },
  { dir: "1440x900@2x", viewport: { width: 1440, height: 900 }, scale: 2 },
] as const;

test.describe("screenshots", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  /** Each size gets a world of its own: the scripted runs cannot be repeated in one conversation. */
  async function seed(): Promise<World> {
    const world = await startWorld();
    const base = {
      modelId: "model-x",
      allowedTools: ["shell", "read_file", "write_file", "edit_file"],
      personality: "Seja objetivo.",
    };
    const { api } = world;
    await api.bots.create({
      ...base,
      name: "Nova",
      description: "Revisa PRs e roda testes",
      avatar: "mascot:leaf",
      color: "branco",
      pinned: true,
      sortOrder: 0,
    });
    await api.bots.create({
      ...base,
      name: "Cookie",
      description: "Amigo diário",
      avatar: "mascot:capsule",
      color: "verde",
      pinned: true,
      sortOrder: 1,
    });
    await api.bots.create({
      ...base,
      name: "Tutor faculdade",
      description: "Professor de várias matérias da faculdade",
      avatar: "mascot:teardrop",
      color: "cinza",
      pinned: true,
      sortOrder: 2,
    });
    await api.bots.create({
      ...base,
      name: "Sênior",
      description: "Dev sênior com experiência em arquiteturas e lógicas de infra",
      avatar: "mascot:clover",
      color: "roxo",
      groupName: "Codding",
    });
    await api.bots.create({
      ...base,
      name: "Contas",
      description: "Organiza as finanças da casa",
      avatar: "mascot:star",
      color: "azul",
      groupName: "Casa",
    });
    // Something to read: a finished conversation with Cookie, one that asks a question (Sênior).
    const bots = await api.bots.list();
    const id = (name: string) => bots.find((b) => b.name === name)?.id as string;
    const talk = async (name: string, text: string) => {
      const conversation = await api.bots.openConversation(id(name));
      await api.conversations.send(conversation.id, text);
      return conversation.id;
    };
    await talk("Cookie", "CASE-MD mostre um resumo");
    await talk("Sênior", "CASE-OPTIONS escolha uma cor");
    await talk("Contas", "CASE-QUIZ pergunte");
    await api.memories.add({ layer: "rule", text: "Responda sempre em português." });
    await api.memories.add({ layer: "profile", text: "Moro em São Paulo e estudo à noite." });
    return world;
  }

  for (const size of SIZES) {
    test(`screens at ${size.dir}`, async ({ browser }) => {
      const world = await seed();
      const context = await browser.newContext({
        viewport: size.viewport,
        deviceScaleFactor: size.scale,
        locale: "pt-BR",
      });
      const page = await context.newPage();
      const shot = (name: string) =>
        page.screenshot({ path: `screenshots/${size.dir}/${name}.png` });
      const settle = async () => {
        await page.evaluate(() => document.fonts.ready);
      };

      await page.goto(world.appUrl);
      await shot("01-conectar");
      await connect(page, world);
      await expect(page.getByTestId("sidebar")).toBeVisible();

      // A conversation with a bot that worked, and the panel.
      await selectBot(page, "Cookie");
      await expect(page.getByTestId("message-bot").filter({ hasText: "Resumo:" })).toBeVisible();
      await settle();
      await shot("02-conversa-painel-atividade");
      await page.getByTestId("panel").getByRole("tab", { name: "Biblioteca" }).click();
      await shot("03-painel-biblioteca");
      await page.getByTestId("panel").getByRole("tab", { name: "Atividade" }).click();

      // A question with choices, as a card; and a questionnaire.
      await selectBot(page, "Sênior");
      await expect(page.getByTestId("question-card")).toBeVisible();
      await shot("04-pergunta-com-opcoes");
      await selectBot(page, "Contas");
      await expect(
        page.getByTestId("question-card").getByRole("img", { name: "Pergunta 1 de 3" }),
      ).toBeVisible();
      await page.getByTestId("question-card").getByTestId("question-option").first().click();
      await shot("04b-questionario");
      await page.getByTestId("question-card").getByRole("button", { name: "Avançar" }).click();

      // The bot working: the cards, the indicator, the dots in the sidebar; then an expanded card.
      await selectBot(page, "Nova");
      await send(page, "CASE-ACTIONS faça o arquivo ola.txt e confira");
      await expect(page.getByTestId("working-indicator")).toHaveAttribute(
        "data-phrase",
        "Rodando o comando sleep 3; echo primeiro",
      );
      await shot("05-trabalhando-cartao-e-indicador");
      await expect(page.getByTestId("action-card").first()).toHaveAttribute("data-state", "done");
      await page.getByTestId("action-card").first().getByRole("button").click();
      await shot("06-cartao-expandido");
      await expect(
        page.getByTestId("message-bot").filter({ hasText: "Terminei as cinco ações." }),
      ).toBeVisible({ timeout: 90_000 });
      await page.getByTestId("action-fold").getByRole("button").click();
      await shot("07-resposta-final-e-acoes-dobradas");

      // Layout states.
      await page.getByTestId("bot-chip").click();
      await expect(page.getByTestId("panel")).toHaveCount(0);
      await shot("08-painel-fechado");
      await page.getByTestId("bot-chip").click();
      // A barra lateral alargada ao máximo, e de volta à largura padrão arrastando a alça.
      const handle = page.getByRole("separator", { name: "Redimensionar a barra lateral" });
      await handle.focus();
      await page.keyboard.press("End");
      await settle();
      await shot("09b-barra-larga");
      const edge = await page.getByTestId("sidebar").boundingBox();
      await page.mouse.move((edge?.x ?? 0) + (edge?.width ?? 0), 500);
      await page.mouse.down();
      await page.mouse.move(316, 500, { steps: 6 });
      await page.mouse.up();
      await page.getByRole("button", { name: "Recolher a barra lateral" }).click();
      await shot("09-barra-recolhida");
      await page.getByRole("button", { name: "Expandir a barra lateral" }).click();

      // Overlays.
      await page.keyboard.press("Control+k");
      await expect(page.getByTestId("palette")).toBeVisible();
      await shot("10-busca-e-acoes");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Novo bot" }).click();
      await page.getByLabel("Dê um nome ao seu bot").fill("Atlas");
      await page.getByRole("radio", { name: "Trevo" }).click();
      await page.getByRole("radio", { name: "Rosa" }).click();
      await shot("11-criar-novo-bot");
      await page.getByRole("button", { name: "Cancelar" }).click();
      await page.getByTestId("owner-menu").click();
      await shot("12-menu-da-conta");
      await page.keyboard.press("Escape");

      // Full-screen views.
      await page.getByTestId("owner-menu").click();
      await page.getByRole("menuitem", { name: "Memória" }).click();
      await expect(page.getByTestId("memory-item").first()).toBeVisible();
      await shot("13-memoria");
      await page.getByTestId("owner-menu").click();
      await page.getByRole("menuitem", { name: /Pendências/ }).click();
      await expect(page.getByTestId("pending-question").first()).toBeVisible();
      await expect(page.getByTestId("pending-question")).toHaveCount(2);
      await shot("14-pendencias");
      await page.getByTestId("owner-menu").click();
      await page.getByRole("menuitem", { name: "Configurações" }).click();
      await expect(page.getByTestId("model-row").first()).toBeVisible();
      await shot("15-configuracoes");
      await selectBot(page, "Nova");
      await page.getByTestId("bot-chip").click({ button: "right" });
      await page.getByRole("menuitem", { name: /Abrir o inspetor/ }).click();
      await expect(page.getByTestId("inspector-events").locator("li").first()).toBeVisible();
      await shot("16-inspetor");

      // Light theme, once.
      await page.getByRole("button", { name: "Voltar" }).click();
      await page.getByTestId("owner-menu").click();
      await page.getByRole("menuitem", { name: "Configurações" }).click();
      await page.getByRole("radio", { name: "Claro" }).click();
      await selectBot(page, "Cookie");
      await shot("17-tema-claro");
      await page.getByTestId("owner-menu").click();
      await page.getByRole("menuitem", { name: "Configurações" }).click();
      await page.getByRole("radio", { name: "Escuro" }).click();
      await context.close();
      await world.stop();
    });
  }
});

void (null as unknown as Page);
