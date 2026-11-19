import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, useWorld } from "./world.js";

// The network allowlist through the API: add, list and remove a host of a bot, with the same exact
// rules the proxy decides by. (The local sandbox of this world has no proxy: this is the list.)
describe.skipIf(!DATABASE_URL)(dbSuiteName("network allowlist through the API"), () => {
  const w = useWorld({ scripts: { roteiro: { agent: [] }, outro: { agent: [] } }, worker: false });

  it("lists the defaults, adds and removes a host, and says no to what is not a name", async () => {
    const { api } = w.started;
    const bot = await api.bots.create({ name: "net-bot", modelId: "model-x", allowedTools: [] });
    const before = await api.network.forBot(bot.id);
    expect(before.defaults).toEqual(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
    expect(before.hosts).toEqual([]);

    const added = await api.network.allow(bot.id, "API.Example.com");
    expect(added.hosts.map((h) => h.host)).toEqual(["api.example.com"]);
    expect(added.hosts[0]?.createdBy).toBe("user");

    for (const bad of ["127.0.0.1", "localhost", "169.254.169.254"]) {
      await expect(api.network.allow(bot.id, bad), bad).rejects.toMatchObject({ status: 400 });
    }
    const gone = await api.network.remove(bot.id, "api.example.com");
    expect(gone.hosts).toEqual([]);
    await expect(api.network.remove(bot.id, "api.example.com")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("answers not found for a bot that does not exist", async () => {
    await expect(
      w.started.api.network.forBot("00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404 });
  });
});
