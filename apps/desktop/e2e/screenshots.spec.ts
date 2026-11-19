import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { recordNetworkEvent } from "@suup/db";
import { DATABASE_URL, fakeMcpCommand, SKIP_REASON, startWorld, type World } from "./harness.js";
import {
  choose,
  closeSettings,
  connect,
  freshBot,
  openSettings,
  selectBot,
  send,
} from "./helpers.js";

// Takes a screenshot of each main screen from a real run of the app, for the visual review against
// the owner's references (1920x1080) and for the design review (1440x900 at 2x).

const SIZES = [
  { dir: "1920x1080", viewport: { width: 1920, height: 1080 }, scale: 1 },
  { dir: "1440x900@2x", viewport: { width: 1440, height: 900 }, scale: 2 },
] as const;

test.describe("screenshots", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  /** Each size gets a world of its own: the scripted runs cannot be repeated in one conversation. */
  async function seed(): Promise<World & { dir: string }> {
    // `networkTool`: the isolated machine has the tool that asks for a host (the card is real).
    const world = await startWorld({ networkTool: true });
    const dir = await mkdtemp(join(tmpdir(), "suup-shots-"));
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
    // Phase 3: a card waiting for approval, a secret request, the vault, rules and a connector.
    await api.bots.create({
      ...base,
      name: "Escriba",
      description: "Escreve e organiza as notas",
      avatar: "mascot:star",
      color: "laranja",
    });
    await api.bots.create({
      ...base,
      name: "Chaveiro",
      description: "Cuida das integrações",
      avatar: "mascot:clover",
      color: "rosa",
    });
    const phase3 = await api.bots.list();
    const phase3Id = (name: string) => phase3.find((b) => b.name === name)?.id as string;
    await api.vault.set("GITHUB_TOKEN", {
      value: "ghp_screenshot_value_000111",
      description: "push no repositório da loja",
      grantBotIds: [phase3Id("Nova"), phase3Id("Escriba")],
    });
    await api.vault.set("ERP_TOKEN", {
      value: "erp_screenshot_value_222333",
      description: "API do ERP (somente leitura)",
    });
    await api.rules.create({
      tool: "write_file",
      effect: "allow",
      botId: phase3Id("Nova"),
      matchers: [{ field: "path", value: "notas/ideias.md" }],
      note: "Só este arquivo, sem perguntar",
    });
    await api.rules.create({
      tool: "web_fetch",
      effect: "deny",
      matchers: [{ field: "url", value: "https://exemplo-ruim.com/" }],
    });
    // The rules the owner writes (the main view of Permissões), one group each; the two exact rules
    // above are only the quiet "Regras exatas (avançado)" row.
    await api.writtenRules.create({ kind: "never", text: "Apagar a pasta notas" });
    await api.writtenRules.create({
      kind: "never",
      text: "Mandar dinheiro por Pix",
      botId: phase3Id("Nova"),
    });
    await api.writtenRules.create({ kind: "ask", text: "Qualquer coisa que gaste dinheiro" });
    await api.writtenRules.create({
      kind: "allow",
      text: "E-mails para minha equipe em acme.com",
    });
    const mcp = fakeMcpCommand();
    await api.connectors.create({
      name: "fake",
      description: "Servidor de teste do Suup",
      transport: { kind: "stdio", command: mcp.command, args: mcp.args },
      scope: "read_write",
      grants: [{ botId: phase3Id("Nova"), tools: "all" }],
    });
    await api.connectors.test("fake");
    await api.connectors.setToolRisk("fake", "echo", { risk: "read" });
    // The user marks the e-mail tool of the connector as a message to another person.
    await api.connectors.setToolOutbound("fake", "send_email", {
      outbound: { kind: "message", recipientFields: ["to"] },
    });
    await api.bots.create({
      ...base,
      name: "Carteiro",
      description: "Escreve e envia e-mails",
      avatar: "mascot:clover",
      color: "azul",
    });
    const mailer = (await api.bots.list()).find((b) => b.name === "Carteiro")?.id as string;
    // The mailer may use three of the tools (a list); Nova has them all (`all`).
    await api.connectors.grant("fake", mailer, {
      tools: ["echo", "send_email", "write_thing"],
    });
    {
      const conversation = await api.bots.openConversation(mailer);
      await api.conversations.send(conversation.id, "CASE-EMAIL-MARCADO envie o e-mail");
    }
    for (const [name, text] of [
      ["Escriba", "CASE-APPROVE escreva o arquivo de notas"],
      ["Chaveiro", "CASE-SECRET preciso do token"],
    ] as const) {
      const conversation = await api.bots.openConversation(phase3Id(name));
      await api.conversations.send(conversation.id, text);
    }
    // A connector whose server changed a definition and added a tool: they wait for a review.
    const tweak = join(dir, "tweak.txt");
    const late = join(dir, "late.txt");
    await api.connectors.create({
      name: "revisao",
      description: "Servidor cujas definições mudaram",
      transport: {
        kind: "stdio",
        command: mcp.command,
        args: mcp.args,
        env: { FAKE_TWEAK: tweak, FAKE_LATE: late },
      },
      scope: "read_write",
    });
    await api.connectors.test("revisao");
    await api.connectors.setToolRisk("revisao", "echo", { risk: "read" });
    await api.connectors.grant("revisao", phase3Id("Escriba"), { tools: ["echo", "write_thing"] });
    await writeFile(
      tweak,
      "Now it also sends a copy of the text to an address of the server's choosing.",
    );
    await writeFile(late, "x");
    await api.connectors.test("revisao");
    // The network of Nova's machine: a host of its own, and what the proxy refused lately.
    await api.network.allow(phase3Id("Nova"), "api.exemplo.com");
    for (const [host, reason, message] of [
      ["api.novo.com", "not_allowed", "host api.novo.com is not allowed for this bot"],
      [
        "registry.exemplo.org",
        "not_allowed",
        "host registry.exemplo.org is not allowed for this bot",
      ],
    ] as const) {
      await recordNetworkEvent(world.db, {
        subjectKind: "bot",
        subjectId: phase3Id("Nova"),
        host,
        port: 443,
        reason,
        message,
      });
    }
    // A bot that asks to reach one more host: a card waits for the user.
    await api.bots.create({
      ...base,
      name: "Pedinte",
      description: "Baixa relatórios de serviços externos",
      avatar: "mascot:leaf",
      color: "laranja",
      allowedTools: [...base.allowedTools, "request_network_access"],
    });
    {
      const requester = (await api.bots.list()).find((b) => b.name === "Pedinte")?.id as string;
      const conversation = await api.bots.openConversation(requester);
      await api.conversations.send(conversation.id, "CASE-NETWORK baixe o relatório");
    }
    await api.memories.add({ layer: "rule", text: "Responda sempre em português." });
    await api.memories.add({ layer: "profile", text: "Moro em São Paulo e estudo à noite." });
    return Object.assign(world, { dir });
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
        // Past the short transitions of buttons and cards.
        await page.waitForTimeout(250);
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
      // An open dropdown (the one of the rows, our menu surface: never a native select).
      await page.getByTestId("setting-theme").click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await shot("15a-configuracoes-dropdown");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await closeSettings(page);
      await selectBot(page, "Nova");
      await page.getByTestId("bot-chip").click({ button: "right" });
      await page.getByRole("menuitem", { name: /Abrir o inspetor/ }).click();
      await expect(page.getByTestId("inspector-events").locator("li").first()).toBeVisible();
      await shot("16-inspetor");

      // Phase 3: the approval card, the secure form, and the settings sections.
      await page.getByRole("button", { name: "Voltar" }).click();
      await selectBot(page, "Escriba");
      const approval = page.getByTestId("approval-card");
      await expect(approval).toHaveAttribute("data-state", "needs-action");
      await settle();
      await shot("18-aprovacao-cartao");
      // A normal action: only Recusar and Aprovar, nothing else.
      expect(await approval.getByRole("button").allTextContents()).toEqual(["Recusar", "Aprovar"]);
      await approval.getByTestId("approval-approve").click();
      await expect(
        page.getByTestId("message-bot").filter({ hasText: "Escrevi o arquivo aprovado." }),
      ).toBeVisible();
      // One row for the call: the approval merged into it.
      const approved = page.getByTestId("action-card");
      await expect(approved).toHaveCount(1);
      await expect(approved).toHaveAttribute("data-state", "done");
      // Collapsed to one row, chevron hidden at rest; then on hover; then opened.
      await page.mouse.move(0, 0);
      await settle();
      await shot("18c-aprovacao-resolvida-recolhida");
      await approved.getByRole("button", { name: /Aprovado/ }).hover();
      await settle();
      await shot("18d-aprovacao-resolvida-hover");
      await approved.getByRole("button", { name: /Aprovado/ }).click();
      await page.mouse.move(0, 0);
      await settle();
      await shot("18e-aprovacao-resolvida-aberta");
      // A message to another person (the user marked the tool): Descartar, and the split button Enviar.
      await selectBot(page, "Carteiro");
      const message = page.getByTestId("approval-card");
      await expect(message).toHaveAttribute("data-state", "needs-action");
      await expect(message.getByTestId("approval-approve")).toHaveText("Enviar");
      await settle();
      await shot("18f-mensagem-cartao");
      await message.getByTestId("approval-more").click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(page.getByRole("menuitem", { name: /Permitir destinatário/ })).toBeVisible();
      await settle();
      await shot("18g-mensagem-menu");
      await page.keyboard.press("Escape");
      await message.getByTestId("approval-deny").click();
      await expect(page.getByTestId("approval-card")).toHaveCount(0);
      await selectBot(page, "Chaveiro");
      const secret = page.getByTestId("secret-card");
      await expect(secret).toHaveAttribute("data-state", "needs-action");
      await secret.getByTestId("secret-input").fill("valor-so-para-a-captura");
      await settle();
      await shot("19-segredo-formulario");
      await secret.getByTestId("secret-input").fill("");
      await expect(secret.getByTestId("secret-save")).toBeDisabled();
      await settle();
      await shot("19a-segredo-vazio");
      await page.getByTestId("owner-menu").click();
      await page.getByRole("menuitem", { name: /Pendências/ }).click();
      await expect(page.getByTestId("pending-secret")).toHaveCount(1);
      await page.getByTestId("pending-secret").scrollIntoViewIfNeeded();
      await settle();
      await shot("19b-pendencias-segredo");
      // The card that asks for a host, and the one line it becomes.
      await selectBot(page, "Pedinte");
      const network = page.getByTestId("approval-card");
      await expect(network).toHaveAttribute("data-state", "needs-action");
      await expect(network.locator('[data-testid="decision-category"]')).toHaveText("Rede");
      expect(await network.getByRole("button").allTextContents()).toEqual(["Recusar", "Aprovar"]);
      await settle();
      await shot("18h-rede-cartao");
      await network.getByTestId("approval-approve").click();
      await expect(
        page.getByTestId("message-bot").filter({ hasText: "Tentei liberar o host." }),
      ).toBeVisible();
      await page.mouse.move(0, 0);
      await settle();
      await shot("18i-rede-cartao-resolvido");
      // The "Rede" of a bot, in its edit surface: defaults, its own hosts, what the proxy refused.
      await selectBot(page, "Nova");
      await page.getByTestId("bot-chip").click({ button: "right" });
      await page.getByRole("menuitem", { name: /Editar o bot/ }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Descrever o que ele faz" })
        .click();
      await expect(page.getByTestId("network-refusals")).toBeVisible();
      await page.getByTestId("bot-network").scrollIntoViewIfNeeded();
      await settle();
      await shot("11b-editar-bot-rede");
      await page.getByRole("dialog").getByRole("button", { name: "Voltar" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click();
      await openSettings(page, "Permissões");
      await expect(page.getByTestId("written-rule")).toHaveCount(4);
      await expect(page.getByTestId("rules-exact")).toContainText("2 regras");
      await settle();
      await shot("20-config-permissoes");
      await page.getByTestId("rule-new-never").click();
      await settle();
      await shot("20a-config-adicionar-regra");
      await page
        .getByTestId("written-rule-text")
        .fill("Apagar qualquer arquivo fora da pasta do projeto");
      await settle();
      await shot("20b-config-regra-preenchida");
      await page.getByRole("button", { name: "Cancelar" }).click();
      await page.getByTestId("rules-exact-open").click();
      await expect(page.getByTestId("rule-row")).toHaveCount(2);
      await settle();
      await shot("20e-config-regras-exatas");
      await page.getByTestId("rules-exact-close").click();
      await page.getByRole("tab", { name: "Cofre" }).click();
      await expect(page.getByTestId("secret-row")).toHaveCount(2);
      await settle();
      await shot("21-config-cofre");
      await page.getByTestId("secret-row").first().getByTestId("secret-grants-toggle").click();
      await settle();
      await shot("21a-config-cofre-item-aberto");
      await page.getByTestId("secret-new").click();
      await settle();
      await shot("21b-config-novo-segredo");
      await page.getByRole("button", { name: "Cancelar" }).click();
      await page.getByRole("tab", { name: "Conectores" }).click();
      await expect(page.getByTestId("connector-item").filter({ hasText: "fake" })).toBeVisible();
      await settle();
      await shot("22-config-conectores-lista");
      await page
        .getByTestId("connector-item")
        .filter({ hasText: "fake" })
        .getByTestId("connector-details")
        .click();
      const connector = page.getByTestId("connector-row").filter({ hasText: "fake" });
      await expect(connector.getByTestId("connector-tools")).toBeVisible();
      await settle();
      await shot("22a-config-conector-aberto");
      await connector.getByTestId("connector-tools").scrollIntoViewIfNeeded();
      await connector.getByTestId("connector-tools-unavailable").scrollIntoViewIfNeeded();
      await settle();
      await shot("22b-config-conectores-ferramentas");
      // Per tool: a bot's row collapsed ("3 de N"), then opened with the ticks.
      const grants = connector.getByTestId("connector-grants");
      await grants.scrollIntoViewIfNeeded();
      await settle();
      await shot("22c-config-conectores-quem-pode-usar");
      const mailer = grants.locator('[data-testid="grant-row"][data-bot="Carteiro"]');
      await mailer.getByRole("button", { name: /Carteiro/ }).click();
      await mailer.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await settle();
      await shot("22d-config-conectores-ferramentas-por-bot");
      await mailer.getByRole("button", { name: /Carteiro/ }).click();
      // Where the program runs, and the hosts it may reach.
      await connector.getByTestId("connector-network").scrollIntoViewIfNeeded();
      await settle();
      await shot("22e-config-conectores-onde-roda");
      // A connector with tools waiting for a review: the calm notice, then the comparison.
      await page.getByRole("tab", { name: "Conectores" }).click();
      await page
        .getByTestId("connector-item")
        .filter({ hasText: "revisao" })
        .getByTestId("connector-details")
        .click();
      const reviewed = page.getByTestId("connector-row").filter({ hasText: "revisao" });
      await expect(reviewed.getByTestId("review-notice")).toContainText("mudou");
      await settle();
      await shot("22f-config-conectores-aviso-de-revisao");
      await reviewed.getByTestId("connector-review").click();
      await expect(page.getByTestId("review-item")).toHaveCount(2);
      await settle();
      await shot("22g-revisao-de-definicao");
      await page.getByTestId("review-item").first().getByTestId("review-keep").click();
      await settle();
      await shot("22h-revisao-mantida-desligada");
      await page.getByTestId("review-close").click();
      await page.getByRole("tab", { name: "Conectores" }).click();
      await page.getByTestId("connector-new").click();
      await settle();
      await shot("23-adicionar-conector");
      await page.getByRole("button", { name: "Cancelar" }).click();
      await page.getByRole("tab", { name: "Geral" }).click();
      await closeSettings(page);

      // Light theme, once.
      await openSettings(page, "Geral");
      await choose(page, page.getByTestId("setting-theme"), "Claro");
      await closeSettings(page);
      await selectBot(page, "Cookie");
      await shot("17-tema-claro");
      await openSettings(page, "Geral");
      await choose(page, page.getByTestId("setting-theme"), "Escuro");
      await closeSettings(page);
      await context.close();
      await world.stop();
      await rm(world.dir, { recursive: true, force: true });
    });

    test(`the network on the local sandbox and the tool search at ${size.dir}`, async ({
      browser,
    }) => {
      // The default server: commands on its own machine (no isolation), tool search on.
      const world = await startWorld({ toolSearch: { minTools: 5, minDefinitionTokens: 1 } });
      await freshBot(world, "Pesquisador", { allowedTools: [] });
      const finder = (await world.api.bots.list()).find((b) => b.name === "Pesquisador")
        ?.id as string;
      const mcp = fakeMcpCommand();
      await world.api.connectors.create({
        name: "fake",
        transport: {
          kind: "stdio",
          command: mcp.command,
          args: mcp.args,
          env: { FAKE_MANY: "30" },
        },
        scope: "read_write",
      });
      await world.api.connectors.test("fake");
      await world.api.connectors.setToolRisk("fake", "gen_3", { risk: "read" });
      await world.api.connectors.grant("fake", finder, { tools: "all" });
      await recordNetworkEvent(world.db, {
        subjectKind: "bot",
        subjectId: finder,
        host: "api.novo.com",
        port: 443,
        reason: "not_allowed",
        message: "host api.novo.com is not allowed for this bot",
      });
      const context = await browser.newContext({
        viewport: size.viewport,
        deviceScaleFactor: size.scale,
        locale: "pt-BR",
      });
      const page = await context.newPage();
      const shot = (name: string) =>
        page.screenshot({ path: `screenshots/${size.dir}/${name}.png` });
      await connect(page, world);
      await expect(page.getByTestId("sidebar")).toBeVisible();
      await selectBot(page, "Pesquisador");
      await send(page, "CASE-META consulte o registro");
      await expect(
        page.getByTestId("message-bot").filter({ hasText: "Consultei o registro 7." }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await shot("24-pesquisa-de-ferramentas-chat");
      await page.getByTestId("bot-chip").click({ button: "right" });
      await page.getByRole("menuitem", { name: /Abrir o inspetor/ }).click();
      await expect(page.getByTestId("tool-catalog")).toHaveAttribute("data-mode", "meta");
      await page.getByTestId("tool-stats-card").scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await shot("24b-inspetor-definicoes-de-ferramentas");
      await page.getByRole("button", { name: "Voltar" }).click();
      await page.getByTestId("bot-chip").click({ button: "right" });
      await page.getByRole("menuitem", { name: /Editar o bot/ }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Descrever o que ele faz" })
        .click();
      await expect(page.getByTestId("network-local-note")).toBeVisible();
      await page.getByTestId("bot-network").scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await shot("11c-editar-bot-rede-sandbox-local");
      await context.close();
      await world.stop();
    });
  }
  for (const size of SIZES) {
    test(`the settings dialog with nothing configured, and in a small window, at ${size.dir}`, async ({
      browser,
    }) => {
      const world = await startWorld();
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
        await page.waitForTimeout(250);
      };
      await connect(page, world);
      await expect(page.getByTestId("sidebar")).toBeVisible();
      await openSettings(page, "Permissões");
      await expect(page.getByTestId("written-rule")).toHaveCount(0);
      await expect(page.getByTestId("rules-exact")).toHaveCount(0);
      await settle();
      await shot("20c-config-permissoes-vazio");
      await page.getByRole("tab", { name: "Cofre" }).click();
      await expect(page.getByTestId("vault-empty")).toBeVisible();
      await settle();
      await shot("21c-config-cofre-vazio");
      await page.getByRole("tab", { name: "Conectores" }).click();
      await expect(page.getByTestId("connectors-card")).toContainText("Nenhum conector");
      await settle();
      await shot("22i-config-conectores-vazio");
      // A small window: the nav becomes a strip on top and nothing overflows the page.
      await page.setViewportSize({ width: 560, height: 700 });
      await page.getByRole("tab", { name: "Permissões" }).click();
      await settle();
      await shot("20d-config-permissoes-janela-pequena");
      const overflow = await page
        .getByTestId("settings-screen")
        .evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(overflow).toBe(false);
      await context.close();
      await world.stop();
    });
  }
});

void (null as unknown as Page);
