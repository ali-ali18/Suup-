import { expect, test } from "@playwright/test";
import { DATABASE_URL, SKIP_REASON, startWorld, type World } from "./harness.js";
import {
  botItem,
  choose,
  closeSettings,
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
    expect(created).toMatchObject({ avatar: "mascot:teardrop", color: "azul", personality: "" });
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

  test("the sidebar is resized by dragging its edge: wider, then below the threshold (rail), then back; remembered across a reload", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openApp(page, world);
    const sidebar = page.getByTestId("sidebar");
    const handle = sidebar.getByRole("separator", { name: "Redimensionar a barra lateral" });
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveAttribute("aria-valuenow", "316");
    const width = async () => Math.round((await sidebar.boundingBox())?.width ?? 0);
    expect(await width()).toBe(316);
    const y = 400;
    const drag = async (to: number, release = true) => {
      const box = await sidebar.boundingBox();
      await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0), y);
      await page.mouse.down();
      await page.mouse.move(to, y, { steps: 8 });
      if (release) await page.mouse.up();
    };
    // Wider, and capped at the maximum.
    await drag(380);
    expect(await width()).toBe(380);
    await expect(handle).toHaveAttribute("aria-valuenow", "380");
    await drag(900);
    expect(await width()).toBe(420);
    // Below the threshold: only the avatars (the rail), mid-drag already.
    await drag(120, false);
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-resizing"))).toBe(
      true,
    );
    await page.mouse.up();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(await width()).toBeLessThan(150);
    await expect(sidebar.getByTestId("bot-item").first()).toBeVisible();
    await expect(sidebar.getByTestId("bot-entry-text")).toHaveCount(0);
    await page.reload();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    // Back out past the threshold: the expanded layout, at the width the drag ended on.
    await drag(330);
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    expect(await width()).toBe(330);
    await page.reload();
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    expect(await width()).toBe(330);
    // The button collapses, and expanding restores the last expanded width.
    await page.getByRole("button", { name: "Recolher a barra lateral" }).click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await page.getByRole("button", { name: "Expandir a barra lateral" }).click();
    expect(await width()).toBe(330);
  });

  test("the sidebar handle works with the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openApp(page, world);
    const sidebar = page.getByTestId("sidebar");
    const handle = sidebar.getByRole("separator", { name: "Redimensionar a barra lateral" });
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "332");
    await page.keyboard.press("End");
    await expect(handle).toHaveAttribute("aria-valuenow", "420");
    await page.keyboard.press("ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", "404");
    await page.keyboard.press("Home");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await expect(handle).toHaveAttribute("aria-valuenow", "110");
    await page.keyboard.press("ArrowRight");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    await expect(handle).toHaveAttribute("aria-valuenow", "404");
  });

  test("the pinned tiles and the active bot: more columns when wider, and the selected bot's tile is a quiet fill with no border", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    for (const name of ["Tile1", "Tile2", "Tile3"]) await freshBot(world, name, { pinned: true });
    await openApp(page, world);
    const sidebar = page.getByTestId("sidebar");
    await selectBot(page, "Tile1");
    const tiles = sidebar.getByTestId("pinned-tiles");
    const columns = () =>
      tiles.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(await columns()).toBe(2);
    await sidebar.getByRole("separator").focus();
    await page.keyboard.press("End");
    expect(await columns()).toBe(3);
    // The selected bot keeps aria-current and a quiet fill (--color-sidebar-active, dark), but no border.
    await page.mouse.move(900, 500); // fora da barra: o hover tem estilo próprio
    const current = sidebar.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    const style = await current.evaluate((el) => {
      const css = getComputedStyle(el);
      return { background: css.backgroundColor, border: css.borderTopColor };
    });
    expect(style.background).toBe("rgb(28, 28, 28)");
    expect(style.border).toBe("rgba(0, 0, 0, 0)");
  });

  test("the bot panel is resized by dragging its left edge, closes below the threshold, and remembers its width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openApp(page, world);
    const panel = page.getByTestId("panel");
    await expect(panel).toBeVisible();
    const handle = panel.getByRole("separator", { name: "Redimensionar o painel" });
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    const width = async () => Math.round((await panel.boundingBox())?.width ?? 0);
    expect(await width()).toBe(450);
    const drag = async (to: number, release = true) => {
      const box = await panel.boundingBox();
      await page.mouse.move(box?.x ?? 0, 400);
      await page.mouse.down();
      await page.mouse.move(to, 400, { steps: 8 });
      if (release) await page.mouse.up();
    };
    // Wider: the left edge goes to x=1000, the panel is 600 wide.
    await drag(1000);
    expect(await width()).toBe(600);
    await drag(100);
    expect(await width()).toBe(640);
    // The chat column keeps a usable minimum on a narrow window.
    await page.setViewportSize({ width: 1100, height: 700 });
    const centre = page.getByRole("region", { name: /^Conversa com/ });
    expect((await centre.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(420);
    await page.setViewportSize({ width: 1600, height: 900 });
    await drag(1100);
    expect(await width()).toBe(500);
    await page.reload();
    expect(await width()).toBe(500);
    // Below the threshold: closed on release; the chip brings it back at the last width.
    await drag(1400);
    await expect(panel).toHaveCount(0);
    await page.reload();
    await expect(panel).toHaveCount(0);
    await page.getByTestId("bot-chip").click();
    await expect(panel).toBeVisible();
    expect(await width()).toBe(500);
    // Keyboard.
    await panel.getByRole("separator").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await width()).toBe(516);
    await page.keyboard.press("End");
    expect(await width()).toBe(640);
    await page.keyboard.press("Home");
    await expect(panel).toHaveCount(0);
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
    await freshBot(world, "Azulado", { color: "azul", avatar: "mascot:wedge" });
    await freshBot(world, "Rosado", { color: "rosa", avatar: "mascot:leaf" });
    await freshBot(world, "Branquinho", { color: "branco", avatar: "mascot:blob" });
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
      await expect(userBubbles(page).last().locator('[data-testid="bubble-user"]')).toHaveCSS(
        "background-color",
        bg,
      );
      await expect(userBubbles(page).last().locator('[data-testid="bubble-user"]')).toHaveCSS(
        "color",
        fg,
      );
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
    await expect(page.getByTestId("section-routines")).toContainText("Nenhuma rotina");
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
    // What the product does not have is on screen only as an ornament (owner's decision, 22/11/2026):
    // the voice chat is hidden from assistive technology, dimmed, "Em breve", with nothing to click.
    for (const text of ["Compartilhar", "Criar chat em grupo"])
      await expect(page.getByText(text)).toHaveCount(0);
    const voice = page.getByTestId("ornament-voice");
    await expect(voice).toHaveAttribute("aria-hidden", "true");
    await expect(voice).toContainText("Em breve");
    await expect(voice.getByRole("button")).toHaveCount(0);
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
    await expect(userBubbles(page).last().locator('[data-testid="bubble-user"]')).toHaveCSS(
      "background-color",
      "rgb(0, 201, 114)",
    );
    const gap = await page.getByTestId("chat-log").evaluate((el) => getComputedStyle(el).rowGap);
    const width = (await page.getByTestId("chat-composer").boundingBox())?.width ?? 0;
    // Links: underlined text in the normal colour, a neutral glyph, NO request to the site by default.
    const link = bubble.getByRole("link", { name: "a documentação" });
    await expect(link).toHaveCSS("text-decoration-line", "underline");
    await expect(link.locator("svg")).toBeVisible();
    await expect(link.locator("img")).toHaveCount(0);
    expect(requested).toEqual([]);

    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: "Configurações" }).click();
    await choose(page, page.getByTestId("setting-bubble"), "Sempre neutro");
    await choose(page, page.getByTestId("setting-density"), "Compacta");
    await expect(page.locator("html")).toHaveAttribute("data-bubble", "neutral");
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    await closeSettings(page);
    await selectBot(page, "Visual");
    // The user's bubble is neutral now (not the bot's green), and the column is denser.
    await expect(userBubbles(page).last().locator('[data-testid="bubble-user"]')).toHaveCSS(
      "background-color",
      "rgb(42, 42, 42)",
    );
    expect(
      await page.getByTestId("chat-log").evaluate((el) => getComputedStyle(el).rowGap),
    ).not.toBe(gap);
    expect(width).toBeGreaterThan(0);

    // They persist across a reload (the app's own storage, not the server).
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-bubble", "neutral");
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    await selectBot(page, "Visual");
    await expect(userBubbles(page).last().locator('[data-testid="bubble-user"]')).toHaveCSS(
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
    await page.getByTestId("setting-favicons").click();
    await expect(page.getByTestId("setting-favicons")).toHaveAttribute("aria-checked", "true");
    await closeSettings(page);
    await selectBot(page, "Visual");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __imgs: string[] }).__imgs))
      .toContain("https://example.com/favicon.ico|no-referrer|lazy");
    // Wide column and "show all actions" are settings too.
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: "Configurações" }).click();
    await choose(page, page.getByTestId("setting-width"), "Larga");
    await choose(page, page.getByTestId("setting-phrase"), "Discreta");
    await page.getByTestId("setting-fold").click();
    await expect(page.locator("html")).toHaveAttribute("data-width", "wide");
    await expect(page.locator("html")).toHaveAttribute("data-phrase", "discreet");
    await expect(page.locator("html")).toHaveAttribute("data-fold", "off");
    await choose(page, page.getByTestId("setting-bubble"), "Seguir o bot");
    await choose(page, page.getByTestId("setting-density"), "Confortável");
    await page.getByTestId("setting-favicons").click();
    await expect(page.getByTestId("setting-favicons")).toHaveAttribute("aria-checked", "false");
    await choose(page, page.getByTestId("setting-width"), "Padrão");
    await choose(page, page.getByTestId("setting-phrase"), "Estado real");
    await page.getByTestId("setting-fold").click();
    await closeSettings(page);
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
    await choose(page, settings.getByTestId("setting-theme"), "Claro");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await choose(page, settings.getByTestId("setting-theme"), "Escuro");
    await closeSettings(page);
    await page.getByTestId("owner-menu").click();
    await page.getByRole("menuitem", { name: "Desconectar" }).click();
    await expect(page.getByRole("button", { name: "Conectar" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Conectar" })).toBeVisible();
  });
});
