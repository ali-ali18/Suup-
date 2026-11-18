import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import {
  botItem,
  freshBot,
  openApp,
  openWithBot,
  selectBot,
  send,
  userBubbles,
} from "./helpers.js";

test.describe("bots, sidebar, palette, memory", () => {
  test.skip(DATABASE_URL === undefined, SKIP_REASON);
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld();
  });
  test.afterAll(async () => {
    await world?.stop();
  });

  test("create a bot in one step (mascot, colour, name), chat with it, and describe it later with a suggestion", async ({
    page,
  }) => {
    await openApp(page, world);
    await page.getByRole("button", { name: "Novo bot" }).click();
    const dialog = page.getByRole("dialog", { name: "Criar novo Bot" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Criar", exact: true })).toBeDisabled();
    await dialog.getByLabel("Dê um nome ao seu bot").fill("Pepê");
    await dialog.getByRole("radio", { name: "Gota" }).click();
    await dialog.getByRole("radio", { name: "Azul" }).click();
    await expect(dialog.getByTestId("newbot-preview")).toHaveAttribute("data-color", "azul");
    await dialog.getByRole("button", { name: "Criar", exact: true }).click();
    // The conversation with the new bot opens, painted in its colour; it has no personality yet: a hint.
    await expect(page.getByTestId("chat")).toHaveAttribute("data-bot", "Pepê");
    await expect(botItem(page, "Pepê")).toBeVisible();
    const created = (await world.api.bots.list()).find((b) => b.name === "Pepê");
    expect(created).toMatchObject({ avatar: "mascot:gota", color: "azul", personality: "" });
    const hint = page.getByTestId("personality-hint");
    await expect(hint).toBeVisible();
    // The hint opens "Editar bot" on the second step; the suggestion fills description and personality.
    await hint.click();
    const edit = page.getByRole("dialog", { name: /Editar Pepê/ });
    await edit.getByLabel("O que esse bot faz?").fill("DRAFT-ME ajuda a estudar inglês");
    await edit.getByRole("button", { name: "Gerar sugestão" }).click();
    await expect(edit.getByLabel("Personalidade")).toHaveValue(/professor de inglês paciente/);
    await expect(edit.getByLabel("O que esse bot faz?")).toHaveValue(
      "Ajuda a estudar inglês com paciência.",
    );
    await edit.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The name typed in the first step won over the drafted one.
    await expect
      .poll(async () => (await world.api.bots.list()).find((b) => b.id === created?.id)?.name)
      .toBe("Pepê");
    await expect
      .poll(
        async () => (await world.api.bots.list()).find((b) => b.id === created?.id)?.personality,
      )
      .toContain("professor de inglês");
    await expect(page.getByTestId("personality-hint")).toHaveCount(0);
    // And it talks.
    await send(page, "OI-SIMPLES oi");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Como posso ajudar" }),
    ).toBeVisible();
  });

  test("pin a bot, move another to a group, and the sidebar shows them where they belong", async ({
    page,
  }) => {
    await freshBot(world, "Alfa");
    await freshBot(world, "Beta");
    await openApp(page, world);
    const sidebar = page.getByTestId("sidebar");
    // Pin Alfa: it becomes a tile in the pinned grid.
    await botItem(page, "Alfa").hover();
    await page.getByRole("button", { name: "Mais opções de Alfa" }).click();
    await page.getByRole("menuitem", { name: "Fixar" }).click();
    const pinned = page.getByTestId("pinned-section");
    await expect(pinned.locator('[data-bot="Alfa"]')).toBeVisible();
    await expect(page.getByTestId("rest-section").locator('[data-bot="Alfa"]')).toHaveCount(0);
    // Move Beta to a new group.
    await botItem(page, "Beta").hover();
    await page.getByRole("button", { name: "Mais opções de Beta" }).click();
    await page.getByRole("menuitem", { name: "Mover para grupo…" }).click();
    const dialog = page.getByRole("dialog", { name: /Mover Beta/ });
    await dialog.getByLabel("Novo grupo…").check();
    await dialog.getByLabel("Nome do grupo").fill("Estudos");
    await dialog.getByRole("button", { name: "Mover" }).click();
    const group = sidebar.locator('[data-testid="group-section"][data-group="Estudos"]');
    await expect(group.locator('[data-bot="Beta"]')).toBeVisible();
    await expect(group).toContainText("Estudos");
    // It persists on the server.
    await expect
      .poll(async () =>
        (await world.api.bots.list())
          .filter((b) => ["Alfa", "Beta"].includes(b.name))
          .map((b) => [b.name, b.pinned, b.groupName])
          .sort(),
      )
      .toEqual([
        ["Alfa", true, null],
        ["Beta", false, "Estudos"],
      ]);
    // Unpin Alfa: back to the default list ("Bots").
    await botItem(page, "Alfa").hover();
    await page.getByRole("button", { name: "Mais opções de Alfa" }).click();
    await page.getByRole("menuitem", { name: "Desafixar" }).click();
    await expect(page.getByTestId("rest-section").locator('[data-bot="Alfa"]')).toBeVisible();
    await expect(page.getByTestId("pinned-section")).toHaveCount(0);
  });

  test("the sidebar collapses to a rail and expands again, and remembers its state across a reload", async ({
    page,
  }) => {
    await openApp(page, world);
    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    const wide = (await sidebar.boundingBox())?.width ?? 0;
    await page.getByRole("button", { name: "Recolher a barra lateral" }).click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect((await sidebar.boundingBox())?.width ?? 999).toBeLessThan(wide / 2);
    // A bot is still reachable, by its name.
    await expect(sidebar.getByRole("button", { name: /^Principal/ })).toBeVisible();
    await page.reload();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await page.keyboard.press("Control+b");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  });

  test("the command palette opens with the keyboard and jumps to a bot, or runs an action", async ({
    page,
  }) => {
    await freshBot(world, "Zeta", { description: "Cuida das contas" });
    await openApp(page, world);
    await page.keyboard.press("Control+k");
    const palette = page.getByTestId("palette");
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("combobox")).toBeFocused();
    await expect(palette.getByRole("option", { name: /Novo Bot/i })).toBeVisible();
    await palette.getByRole("combobox").fill("contas");
    await expect(palette.getByRole("option").first()).toContainText("Zeta");
    await page.keyboard.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(page.getByTestId("chat")).toHaveAttribute("data-bot", "Zeta");
    // Escape closes it; an action opens a screen.
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette").getByRole("combobox").fill("memória");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("memory-screen")).toBeVisible();
    // The shortcuts dialog lists what the app implements.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette").getByRole("combobox").fill("atalhos");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Atalhos de teclado" })).toContainText(
      "Ctrl/⌘ + K",
    );
  });

  test("message search finds a message of another bot, from two characters on", async ({
    page,
  }) => {
    await freshBot(world, "Busca");
    await openApp(page, world);
    await selectBot(page, "Busca");
    await send(page, "OI-SIMPLES girafa");
    await expect(
      page.getByTestId("message-bot").filter({ hasText: "Como posso ajudar" }),
    ).toBeVisible();
    await selectBot(page, "Principal");
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette").getByRole("combobox").fill("girafa");
    const hit = page
      .getByTestId("palette")
      .getByRole("group", { name: "Conversas" })
      .getByRole("option");
    await expect(hit.first()).toContainText("Busca");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("palette").getByRole("combobox")).toHaveAttribute(
      "aria-activedescendant",
      /.+/,
    );
  });

  test("the user's bubble takes the colour of the conversation's bot", async ({ page }) => {
    await freshBot(world, "Azulado", { color: "azul", avatar: "mascot:cunha" });
    await freshBot(world, "Rosado", { color: "rosa", avatar: "mascot:folha" });
    await freshBot(world, "Branquinho", { color: "branco", avatar: "mascot:esfera" });
    await openApp(page, world);
    const expected: [string, string, string][] = [
      ["Azulado", "rgb(16, 132, 254)", "rgb(11, 11, 12)"],
      ["Rosado", "rgb(255, 92, 138)", "rgb(11, 11, 12)"],
      ["Branquinho", "rgb(58, 58, 60)", "rgb(245, 245, 245)"],
    ];
    for (const [name, bg, fg] of expected) {
      await selectBot(page, name);
      await send(page, "OI-SIMPLES cor");
      // (the bubble is replaced when the server confirms the message: the assertion retries)
      await expect(userBubbles(page).last().locator(".ui-bubble--user")).toHaveCSS(
        "background-color",
        bg,
      );
      await expect(userBubbles(page).last().locator(".ui-bubble--user")).toHaveCSS("color", fg);
      await expect(page.getByTestId("message-bot").last()).toContainText("Como posso ajudar");
    }
    // The white bot's bubble is a neutral grey, and its send button is the plain white round one;
    // the others' send button follows the bot's colour.
    const sendButton = () => page.getByRole("button", { name: "Enviar mensagem" });
    await sendButton().evaluate((el) => el.removeAttribute("disabled"));
    await expect(sendButton()).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await selectBot(page, "Azulado");
    await sendButton().evaluate((el) => el.removeAttribute("disabled"));
    await expect(sendButton()).toHaveCSS("background-color", "rgb(16, 132, 254)");
  });

  test("the panel opens and closes from the bot chip; Atividade and Biblioteca are honest about what is not there yet", async ({
    page,
  }) => {
    await openWithBot(page, world, "Painel");
    const panel = page.getByTestId("panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Painel" })).toBeVisible();
    await expect(page.getByTestId("section-soon")).toContainText(
      "As rotinas deste bot vão aparecer aqui.",
    );
    await expect(page.getByTestId("section-computer")).toContainText("Computador do bot");
    await panel.getByRole("tab", { name: "Biblioteca" }).click();
    await expect(panel.getByRole("button", { name: "Todos" })).toBeVisible();
    await expect(panel).toContainText(
      "Os arquivos e as páginas que o bot criar vão aparecer aqui.",
    );
    await panel.getByRole("button", { name: "Fechar o painel" }).click();
    await expect(panel).toHaveCount(0);
    await page.getByTestId("bot-chip").click();
    await expect(panel).toBeVisible();
    // Nothing the product does not have is on screen.
    for (const text of ["Compartilhar", "Chat de voz", "Criar chat em grupo"])
      await expect(page.getByText(text)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /microfone|voz/i })).toHaveCount(0);
  });

  test("memory: add a rule, see it listed, forget it and restore it", async ({ page }) => {
    await openApp(page, world);
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: "Memória" }).click();
    const screen = page.getByTestId("memory-screen");
    await expect(screen).toBeVisible();
    await screen.getByRole("button", { name: "Adicionar" }).click();
    const dialog = page.getByRole("dialog", { name: "Adicionar à memória" });
    await dialog.getByLabel("Texto").fill("Responda sempre em português.");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    const item = screen
      .getByTestId("memory-item")
      .filter({ hasText: "Responda sempre em português." });
    await expect(item).toBeVisible();
    await expect(item).toContainText("Regra");
    await expect(item).toContainText("Você");
    // Forget: it disappears from the list...
    await item.getByRole("button", { name: "Esquecer memória" }).click();
    await expect(item).toHaveCount(0);
    // ...and shows again, forgotten, with a way back.
    await screen.getByRole("switch", { name: "Mostrar esquecidas" }).click();
    const forgotten = screen
      .getByTestId("memory-item")
      .filter({ hasText: "Responda sempre em português." });
    await expect(forgotten).toContainText("Esquecida");
    await forgotten.getByRole("button", { name: "Restaurar" }).click();
    await screen.getByRole("switch", { name: "Mostrar esquecidas" }).click();
    await expect(
      screen.getByTestId("memory-item").filter({ hasText: "Responda sempre em português." }),
    ).toBeVisible();
    // Search is accent-insensitive.
    await screen.getByLabel("Buscar na memória").fill("portugues");
    await expect(screen.getByTestId("memory-item")).toHaveCount(1);
    await screen.getByLabel("Buscar na memória").fill("zzz");
    await expect(screen.getByTestId("memory-item")).toHaveCount(0);
  });

  test("appearance settings: two changes show in the chat and survive a reload; icons of sites stay off until asked", async ({
    page,
  }) => {
    await freshBot(world, "Visual", { color: "verde" });
    const requested: string[] = [];
    await page.route("https://example.com/**", async (route) => {
      requested.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          "base64",
        ),
      });
    });
    await openApp(page, world);
    await selectBot(page, "Visual");
    await send(page, "CASE-MD mostre");
    const bubble = page.getByTestId("message-bot").filter({ hasText: "Resumo:" });
    await expect(bubble).toBeVisible();
    await expect(userBubbles(page).last().locator(".ui-bubble--user")).toHaveCSS(
      "background-color",
      "rgb(0, 201, 114)",
    );
    const gap = await page.locator(".chat__log").evaluate((el) => getComputedStyle(el).rowGap);
    const width = (await page.locator(".chat__composer").boundingBox())?.width ?? 0;
    // Links: underlined text in the normal colour, a neutral glyph, NO request to the site by default.
    const link = bubble.getByRole("link", { name: "a documentação" });
    await expect(link).toHaveCSS("text-decoration-line", "underline");
    await expect(link.locator("svg")).toBeVisible();
    await expect(link.locator("img")).toHaveCount(0);
    expect(requested).toEqual([]);

    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: "Configurações" }).click();
    await page.getByTestId("setting-bubble-neutral").click();
    await page.getByTestId("setting-density-compact").click();
    await expect(page.locator("html")).toHaveAttribute("data-bubble", "neutral");
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    await selectBot(page, "Visual");
    // The user's bubble is neutral now (not the bot's green), and the column is denser.
    await expect(userBubbles(page).last().locator(".ui-bubble--user")).toHaveCSS(
      "background-color",
      "rgb(42, 42, 42)",
    );
    expect(await page.locator(".chat__log").evaluate((el) => getComputedStyle(el).rowGap)).not.toBe(
      gap,
    );
    expect(width).toBeGreaterThan(0);

    // They persist across a reload (the app's own storage, not the server).
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-bubble", "neutral");
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    await selectBot(page, "Visual");
    await expect(userBubbles(page).last().locator(".ui-bubble--user")).toHaveCSS(
      "background-color",
      "rgb(42, 42, 42)",
    );

    // Site icons on: now (and only now) the icon of the link's host is asked for, host only. (The
    // test browser refuses `/favicon.ico` before the network, so the element is recorded as it is
    // added, with the attributes the app gave it.)
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __imgs: string[] }).__imgs = seen;
      const note = (node: Node) => {
        for (const img of node instanceof Element ? [node, ...node.querySelectorAll("img")] : []) {
          if (img instanceof HTMLImageElement) {
            seen.push(
              `${img.getAttribute("src")}|${img.getAttribute("referrerpolicy")}|${img.getAttribute("loading")}`,
            );
          }
        }
      };
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) note(n);
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: "Configurações" }).click();
    await page.getByTestId("setting-favicons-on").click();
    await selectBot(page, "Visual");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __imgs: string[] }).__imgs))
      .toContain("https://example.com/favicon.ico|no-referrer|lazy");
    // Wide column and "show all actions" are settings too.
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: "Configurações" }).click();
    await page.getByTestId("setting-width-wide").click();
    await page.getByTestId("setting-phrase-discreet").click();
    await page.getByTestId("setting-fold-off").click();
    await expect(page.locator("html")).toHaveAttribute("data-width", "wide");
    await expect(page.locator("html")).toHaveAttribute("data-phrase", "discreet");
    await expect(page.locator("html")).toHaveAttribute("data-fold", "off");
    await page.getByTestId("setting-bubble-bot").click();
    await page.getByTestId("setting-density-comfortable").click();
    await page.getByTestId("setting-favicons-off").click();
    await page.getByTestId("setting-width-default").click();
    await page.getByTestId("setting-phrase-real").click();
    await page.getByTestId("setting-fold-on").click();
  });

  test("the account menu leads to pendências and settings, and disconnects", async ({ page }) => {
    await openApp(page, world);
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: /Pendências/ }).click();
    await expect(page.getByTestId("pending-screen")).toContainText("Nenhuma pergunta aberta");
    await expect(page.getByTestId("pending-screen")).toContainText("Nenhuma aprovação");
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: "Configurações" }).click();
    const settings = page.getByTestId("settings-screen");
    await expect(settings.getByTestId("server-url")).toHaveText(world.serverUrl);
    await expect(settings.getByTestId("model-row")).toHaveCount(2);
    await settings.getByTestId("setting-theme-light").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await settings.getByTestId("setting-theme-dark").click();
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: "Desconectar" }).click();
    await expect(page.getByRole("button", { name: "Conectar" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Conectar" })).toBeVisible();
  });
});
