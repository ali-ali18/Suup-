import { ApiError, type SuupClient, type BotNetwork as View } from "@suup/api";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { createDataStore } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { at } from "../../test-fixtures.js";
import { BotNetwork } from "./BotNetwork.js";

const view = (over: Partial<View> = {}): View => ({
  defaults: ["registry.npmjs.org", "pypi.org"],
  hosts: [{ host: "api.exemplo.com", createdBy: "user", createdAt: at(0) }],
  refusals: [
    {
      host: "api.novo.com",
      port: 443,
      reason: "not_allowed",
      message: "host api.novo.com is not allowed for this bot",
      createdAt: at(1000),
    },
  ],
  ...over,
});

function setup(
  network: Record<string, unknown>,
  tools: string[] = ["shell", "request_network_access"],
) {
  const api = {
    network,
    tools: { list: async () => ({ items: tools.map((name) => ({ name })), control: [] }) },
  } as unknown as SuupClient;
  const store = createDataStore();
  const sync = new Sync({ api, store });
  render(
    <ServicesProvider services={{ api, sync, data: store } as unknown as Services}>
      <BotNetwork botId="b1" />
    </ServicesProvider>,
  );
  return { store };
}

describe("the Rede section of a bot", () => {
  it("shows the defaults (read only), the bot's own hosts and the recent refusals", async () => {
    setup({ forBot: vi.fn(async () => view()) });
    const defaults = await screen.findByTestId("network-defaults");
    expect(defaults.textContent).toBe("registry.npmjs.orgpypi.org");
    expect(within(defaults).queryAllByRole("button")).toHaveLength(0);
    expect(within(screen.getByTestId("network-hosts")).getByText("api.exemplo.com")).toBeTruthy();
    const refusal = screen.getByTestId("network-refusals");
    expect(refusal.textContent).toContain("api.novo.com:443");
    expect(refusal.textContent).toContain("o host não está na lista");
    expect(screen.getByTestId("bot-network").textContent).toContain("exato");
  });

  it("says plainly when the server is on the local sandbox, and not when it is isolated", async () => {
    setup({ forBot: async () => view() }, ["shell"]);
    expect((await screen.findByTestId("network-local-note")).textContent).toContain(
      "sandbox local",
    );
  });

  it("is silent about it on the isolated sandbox", async () => {
    setup({ forBot: async () => view() });
    await screen.findByTestId("network-defaults");
    await waitFor(() => expect(screen.queryByTestId("network-local-note")).toBeNull());
  });

  it("an empty field is refused in the app; nothing else is judged there", async () => {
    const allow = vi.fn(async () => view());
    setup({ forBot: async () => view(), allow });
    await screen.findByTestId("network-defaults");
    fireEvent.click(screen.getByTestId("network-add"));
    expect(screen.getByRole("alert").textContent).toBe("Digite o nome do host.");
    expect(allow).not.toHaveBeenCalled();
  });

  it("adds a host exactly as typed (trimmed) and shows what the server answers", async () => {
    const allow = vi.fn(async (_id: string, host: string) =>
      view({
        hosts: [
          { host: "api.exemplo.com", createdBy: "user", createdAt: at(0) },
          { host, createdBy: "user", createdAt: at(2000) },
        ],
      }),
    );
    setup({ forBot: async () => view(), allow });
    await screen.findByTestId("network-defaults");
    fireEvent.change(screen.getByLabelText("Liberar um host"), {
      target: { value: "  novo.exemplo.com " },
    });
    fireEvent.click(screen.getByTestId("network-add"));
    await waitFor(() => expect(allow).toHaveBeenCalledWith("b1", "novo.exemplo.com"));
    await waitFor(() =>
      expect(within(screen.getByTestId("network-hosts")).getAllByText(/exemplo\.com/)).toHaveLength(
        2,
      ),
    );
    expect((screen.getByLabelText("Liberar um host") as HTMLInputElement).value).toBe("");
  });

  it("shows the server's refusal message for an IP or localhost, in the server's words", async () => {
    const allow = vi.fn(async () => {
      throw new ApiError(
        "invalid_request",
        "Endereços IP não são aceitos: use o nome do host.",
        400,
      );
    });
    setup({ forBot: async () => view(), allow });
    await screen.findByTestId("network-defaults");
    fireEvent.change(screen.getByLabelText("Liberar um host"), { target: { value: "10.0.0.1" } });
    fireEvent.click(screen.getByTestId("network-add"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Endereços IP não são aceitos: use o nome do host.",
    );
    expect(allow).toHaveBeenCalledWith("b1", "10.0.0.1");
  });

  it("removes a host of the bot, and the list is the server's answer", async () => {
    const remove = vi.fn(async () => view({ hosts: [] }));
    setup({ forBot: async () => view(), remove });
    await screen.findByTestId("network-hosts");
    fireEvent.click(screen.getByRole("button", { name: "Remover api.exemplo.com" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("b1", "api.exemplo.com"));
    expect((await screen.findByTestId("network-hosts-empty")).textContent).toContain("Nenhum host");
  });

  it("a refusal can become 'Liberar <host>'", async () => {
    const allow = vi.fn(async () => view());
    setup({ forBot: async () => view(), allow });
    await screen.findByTestId("network-refusals");
    fireEvent.click(screen.getByRole("button", { name: "Liberar api.novo.com" }));
    await waitFor(() => expect(allow).toHaveBeenCalledWith("b1", "api.novo.com"));
  });
});
