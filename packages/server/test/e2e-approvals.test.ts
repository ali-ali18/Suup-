import type { Approval, StreamEvent } from "@suup/api";
import { generateKeyText } from "@suup/runtime";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, follow, until, useWorld } from "./world.js";

// The approval card and the vault through the API: a worker in another runtime asks, the user
// answers over HTTP, and the stream carries every step. Waits are on conditions, not on time.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const shell = (command: string) => ({ name: "shell", args: { command } });

const VALUE = "srv_live_Q1w2E3r4T5y6U7i8";

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-SEND",
        agent: [
          s({ text: "Vou enviar.", calls: [shell("echo enviado-1")] }),
          s({ text: "Enviado." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-DENY",
        agent: [s({ calls: [shell("echo nao-envie")] }), s({ text: "Entendi, não enviei." })],
      },
      {
        whenObjectiveContains: "CASE-ALWAYS",
        agent: [s({ calls: [shell("echo sempre-ok")] }), s({ text: "Feito." })],
      },
      {
        whenObjectiveContains: "CASE-CANCEL",
        agent: [s({ calls: [shell("echo nunca-roda")] }), s({ text: "Nunca chega aqui." })],
      },
      {
        whenObjectiveContains: "CASE-SECRET-USE",
        agent: [
          s({ calls: [shell('echo "chave={{secret:SRV_TOKEN}}"')] }),
          s({ text: "Usei a chave." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-ASK-SECRET",
        agent: [
          s({
            calls: [
              { name: "request_secret", args: { name: "ASKED_TOKEN", reason: "para o teste" } },
            ],
          }),
          s({ text: "Obrigado, já posso usar." }),
        ],
      },
    ],
  },
  outro: { agent: [] },
};

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("approvals and the vault through the API"),
  { timeout: 60_000 },
  () => {
    const w = useWorld({
      scripts: SCRIPTS,
      // No user rule about shell here (the other suites set one): on the local machine it asks.
      config: { approvals: {}, vault: { keyEnv: "SERVER_TEST_VAULT_KEY" } },
      env: { SERVER_TEST_VAULT_KEY: generateKeyText() },
    });
    const setup = async (name: string) => {
      const { api } = w.started;
      const bot = await api.bots.create({ name, modelId: "model-x", allowedTools: ["shell"] });
      const conversation = await api.bots.openConversation(bot.id);
      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "ready");
      return { api, bot, conversation, f };
    };
    const pendingOf = (runId: string) =>
      until(async () => {
        const [card] = await w.started.api.approvals.list({ status: "pending", runId });
        return card;
      }, "the approval card");
    const approvalEvents = (f: { events: StreamEvent[] }, id: string) =>
      f.events.flatMap((e) =>
        e.type === "approval.changed" && e.data.approval.id === id
          ? [`${e.data.change}:${e.data.approval.status}`]
          : [],
      );
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "no error",
        (error: { code?: string }) => error.code ?? String(error),
      );

    it("asks, publishes the card, and runs exactly what was approved", async () => {
      const { api, bot, conversation, f } = await setup("Aprovador");
      const sent = await api.conversations.send(conversation.id, "CASE-SEND por favor");
      const runId = sent.run.id;

      const card = await pendingOf(runId);
      expect(card).toMatchObject({
        runId,
        botId: bot.id,
        conversationId: conversation.id,
        tool: "shell",
        level: "external_irreversible",
        status: "pending",
        args: { command: "echo enviado-1" },
        secrets: [],
        reason: null,
        expiresAt: null,
      });
      expect(card.summary).toContain("echo enviado-1");

      // The run waits, and the stream said so.
      await until(
        async () => (await api.runs.get(runId)).status === "waiting_approval" || undefined,
        "waiting_approval",
      );
      await f.waitFor(
        (e) =>
          e.type === "run.updated" &&
          e.data.run.id === runId &&
          e.data.run.status === "waiting_approval",
        "run.updated waiting_approval",
      );
      await f.waitFor(
        (e) =>
          e.type === "approval.changed" &&
          e.data.approval.id === card.id &&
          e.data.change === "created",
        "approval.changed created",
      );

      // Listings: global, per conversation, per bot, and one by id.
      expect((await api.approvals.get(card.id)).id).toBe(card.id);
      expect((await api.approvals.list({ status: "pending" })).map((a) => a.id)).toContain(card.id);
      expect(
        (await api.approvals.list({ conversationId: conversation.id })).map((a) => a.id),
      ).toEqual([card.id]);
      expect((await api.approvals.list({ botId: bot.id, status: "approved" })).length).toBe(0);
      const nested = await fetch(`${w.started.url}/v1/conversations/${conversation.id}/approvals`, {
        headers: { Authorization: `Bearer ${w.token}` },
      });
      expect(((await nested.json()) as { items: Approval[] }).items.map((a) => a.id)).toEqual([
        card.id,
      ]);

      // A message does not approve anything.
      const note = await api.conversations.send(conversation.id, "sim, pode enviar");
      expect(note.queuedForRun).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect((await api.runs.get(runId)).status).toBe("waiting_approval");
      expect((await api.approvals.get(card.id)).status).toBe("pending");
      // And a run that waits for approval cannot be paused: it is not using a worker.
      expect(await code(api.runs.pause(runId))).toBe("conflict");

      // The user approves.
      const decided = await api.approvals.decide(card.id, { decision: "approve" });
      expect(decided.rule).toBeNull();
      expect(decided.approval).toMatchObject({ status: "approved" });
      expect(decided.approval.decidedAt).not.toBeNull();
      await until(
        async () => (await api.runs.get(runId)).status === "done" || undefined,
        "the run to finish",
      );
      const events = (await api.runs.events(runId, { limit: 1000 })).items;
      expect(events.find((e) => e.type === "tool_result")?.payload).toMatchObject({
        outcome: "ok",
        content: expect.stringContaining("enviado-1"),
      });
      expect(
        events.filter((e) => e.type === "approval_decided").map((e) => e.payload.decision),
      ).toEqual(["approved"]);
      await until(
        () => (approvalEvents(f, card.id).includes("updated:approved") ? true : undefined),
        "approval.changed approved",
      );
      expect(approvalEvents(f, card.id)).toEqual(["created:pending", "updated:approved"]);

      // A card is decided once, from wherever.
      expect(await code(api.approvals.decide(card.id, { decision: "deny" }))).toBe("conflict");
      expect(await code(api.approvals.get("11111111-1111-4111-8111-111111111111"))).toBe(
        "not_found",
      );
      expect(
        await code(
          api.approvals.decide("11111111-1111-4111-8111-111111111111", { decision: "approve" }),
        ),
      ).toBe("not_found");
      // Even a late `send` after the run ended is just a message.
      f.close();
    });

    it("a denial reaches the bot with its reason, and the run is not failed", async () => {
      const { api, conversation, f } = await setup("Negador");
      const sent = await api.conversations.send(conversation.id, "CASE-DENY");
      const card = await pendingOf(sent.run.id);
      const decided = await api.approvals.decide(card.id, { decision: "deny", reason: "hoje não" });
      expect(decided.approval).toMatchObject({ status: "denied", reason: "hoje não" });
      await until(
        async () => (await api.runs.get(sent.run.id)).status === "done" || undefined,
        "done",
      );
      const run = await api.runs.get(sent.run.id);
      expect(run).toMatchObject({ status: "done", failureOrigin: null });
      const result = (await api.runs.events(sent.run.id, { types: ["tool_result"] })).items[0];
      expect(result?.payload).toMatchObject({ outcome: "denied", isError: true });
      expect(String(result?.payload.content)).toContain("hoje não");
      f.close();
    });

    it("a normal card cannot make a standing rule: no 'always allow' in the API, and no allowRecipient on a non-message", async () => {
      const { api, bot, conversation, f } = await setup("Sempre");
      const first = await api.conversations.send(conversation.id, "CASE-ALWAYS 1");
      const card = await pendingOf(first.run.id);
      expect(card.outbound).toBeNull();
      // the removed field is refused loudly, not ignored
      const raw = await fetch(`${w.started.url}/v1/approvals/${card.id}/decision`, {
        method: "POST",
        headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", always: { scope: "global" } }),
      });
      expect(raw.status).toBe(400);
      // and a tool that never declared a message cannot be turned into a recipient rule
      expect(
        await code(api.approvals.decide(card.id, { decision: "approve", allowRecipient: true })),
      ).toBe("conflict");
      expect((await api.approvals.get(card.id)).status).toBe("pending");
      const { rule } = await api.approvals.decide(card.id, { decision: "approve" });
      expect(rule).toBeNull();
      expect((await api.approvals.get(card.id)).ruleId).toBeNull();
      expect(
        (await api.rules.list({ botId: bot.id })).filter((r) => r.createdBy === "approval"),
      ).toEqual([]);
      await until(
        async () => (await api.runs.get(first.run.id)).status === "done" || undefined,
        "first done",
      );
      // The next equal call asks again: nothing was remembered behind the user's back.
      f.close();
      const twin = await setup("Sempre-bis");
      const second = await api.conversations.send(twin.conversation.id, "CASE-ALWAYS 2");
      expect((await pendingOf(second.run.id)).args).toMatchObject({ command: "echo sempre-ok" });
      twin.f.close();
    });

    it("cancelling a run that waits cancels its card, and the stream shows both", async () => {
      const { api, conversation, f } = await setup("Cancelador");
      const sent = await api.conversations.send(conversation.id, "CASE-CANCEL");
      const card = await pendingOf(sent.run.id);
      await until(
        async () => (await api.runs.get(sent.run.id)).status === "waiting_approval" || undefined,
        "waiting",
      );
      expect((await api.runs.cancel(sent.run.id)).status).toBe("cancelled");
      expect((await api.approvals.get(card.id)).status).toBe("cancelled");
      expect(await code(api.approvals.decide(card.id, { decision: "approve" }))).toBe("conflict");
      await until(
        () => (approvalEvents(f, card.id).includes("updated:cancelled") ? true : undefined),
        "approval.changed cancelled",
      );
      const events = (await api.runs.events(sent.run.id, { limit: 100 })).items;
      expect(events.map((e) => e.type)).toContain("approval_decided");
      expect(events.some((e) => e.type === "tool_result")).toBe(false);
      f.close();
    });

    it("cancelling a run the moment its card exists (the run may not be parked yet) never leaves the card or the run waiting", async () => {
      const { api, conversation, f } = await setup("Apressado");
      // The card is written a moment before the run is parked for it: cancel as soon as it shows.
      for (let round = 0; round < 8; round++) {
        const sent = await api.conversations.send(conversation.id, "CASE-CANCEL");
        const card = await pendingOf(sent.run.id);
        await api.runs.cancel(sent.run.id);
        await until(
          async () => (await api.runs.get(sent.run.id)).status === "cancelled" || undefined,
          `run ${round} cancelled`,
        );
        expect((await api.approvals.get(card.id)).status).toBe("cancelled");
        const events = (await api.runs.events(sent.run.id, { limit: 100 })).items;
        expect(JSON.stringify(events)).not.toContain("nunca-roda\\n");
        expect(events.filter((e) => e.type === "approval_decided")).toHaveLength(1);
      }
      f.close();
    });

    it("rules: create, validate, edit, list by bot, delete", async () => {
      const { api } = w.started;
      const bot = await api.bots.create({
        name: "Regrista",
        modelId: "model-x",
        allowedTools: ["shell"],
      });
      const created = await api.rules.create({
        botId: bot.id,
        tool: "shell",
        effect: "deny",
        matchers: [{ field: "command", value: "rm -rf build" }],
        note: "nada de rm",
      });
      expect(created).toMatchObject({
        botId: bot.id,
        effect: "deny",
        createdBy: "user",
        note: "nada de rm",
      });
      const global = await api.rules.create({ tool: "*", effect: "allow" });
      expect(global.botId).toBeNull();
      const forBot = (await api.rules.list({ botId: bot.id })).map((r) => r.id);
      expect(forBot).toEqual(expect.arrayContaining([created.id, global.id]));
      const edited = await api.rules.update(created.id, { effect: "allow", note: null });
      expect(edited).toMatchObject({ effect: "allow", note: null });
      expect(edited.matchers).toEqual(created.matchers);
      expect(await code(api.rules.create({ tool: "", effect: "deny" }))).toBe("invalid_request");
      expect(
        await code(
          api.rules.create({
            tool: "x",
            effect: "deny",
            matchers: [{ field: "a", op: "regex", value: "b" } as never],
          }),
        ),
      ).toBe("invalid_request");
      // every removed way of comparing is refused as an unknown field, never read as equality
      for (const op of ["equals", "starts_with", "contains", "glob"]) {
        expect(
          await code(
            api.rules.create({
              tool: "x",
              effect: "deny",
              matchers: [{ field: "a", op, value: "b*" } as never],
            }),
          ),
          op,
        ).toBe("invalid_request");
        expect(
          await code(
            api.rules.update(created.id, { matchers: [{ field: "a", op, value: "b" } as never] }),
          ),
          op,
        ).toBe("invalid_request");
      }
      // a rule without conditions is "any use of the tool", and says so
      expect(global.matchers).toEqual([]);
      expect(global).toMatchObject({ enabled: true, disabledReason: null });
      expect(
        await code(
          api.rules.create({
            botId: "11111111-1111-4111-8111-111111111111",
            tool: "x",
            effect: "deny",
          }),
        ),
      ).toBe("invalid_request");
      expect(
        await code(api.rules.update("11111111-1111-4111-8111-111111111111", { effect: "deny" })),
      ).toBe("not_found");
      await api.rules.remove(created.id);
      await api.rules.remove(global.id);
    });

    it("the vault status says the server can write secrets, and never shows the key", async () => {
      const status = await w.started.api.vault.status();
      expect(status).toMatchObject({ configured: true, ok: true, keyEnv: "SERVER_TEST_VAULT_KEY" });
      expect(Object.keys(status).sort()).toEqual(["configured", "keyEnv", "ok", "reason"]);
    });

    it("the vault is write-only: no route brings a value back, and grants are per bot", async () => {
      const { api } = w.started;
      const bot = await api.bots.create({
        name: "Cofre",
        modelId: "model-x",
        allowedTools: ["shell"],
      });
      const other = await api.bots.create({
        name: "Outro",
        modelId: "model-x",
        allowedTools: ["shell"],
      });
      const saved = await api.vault.set("SRV_TOKEN", {
        value: VALUE,
        description: "token do servidor de teste",
        grantBotIds: [bot.id],
      });
      expect(saved).toMatchObject({
        name: "SRV_TOKEN",
        description: "token do servidor de teste",
        grantedBotIds: [bot.id],
        lastUsedAt: null,
      });
      expect(JSON.stringify(saved)).not.toContain(VALUE);
      const listed = await api.vault.list();
      expect(listed.map((x) => x.name)).toContain("SRV_TOKEN");
      expect(JSON.stringify(listed)).not.toContain(VALUE);

      // There is no read route, and the ones that exist are not one.
      for (const path of [
        "/v1/secrets/SRV_TOKEN",
        "/v1/secrets/SRV_TOKEN/value",
        "/v1/secrets/SRV_TOKEN/grants",
      ]) {
        const res = await fetch(`${w.started.url}${path}`, {
          headers: { Authorization: `Bearer ${w.token}` },
        });
        expect([404, 405]).toContain(res.status);
        expect(await res.text()).not.toContain(VALUE);
      }

      expect((await api.vault.grant("SRV_TOKEN", other.id)).grantedBotIds).toEqual(
        expect.arrayContaining([bot.id, other.id]),
      );
      expect((await api.vault.revoke("SRV_TOKEN", other.id)).grantedBotIds).toEqual([bot.id]);
      // Replacing keeps the grants; a bad name or a short value is refused.
      expect((await api.vault.set("SRV_TOKEN", { value: `${VALUE}-2` })).grantedBotIds).toEqual([
        bot.id,
      ]);
      expect(await code(api.vault.set("srv_token", { value: VALUE }))).toBe("not_found");
      expect(await code(api.vault.set("SHORT_ONE", { value: "short" }))).toBe("invalid_request");
      expect(await code(api.vault.grant("NO_SUCH_SECRET", bot.id))).toBe("not_found");
      await api.vault.remove("SRV_TOKEN");
      expect(await code(api.vault.remove("SRV_TOKEN"))).toBe("not_found");
    });

    it("a run that uses a secret asks first, shows the placeholder, and no response or frame carries the value", async () => {
      const { api, bot, conversation, f } = await setup("Usuario");
      await api.vault.set("SRV_TOKEN", { value: VALUE, grantBotIds: [bot.id] });
      const sent = await api.conversations.send(conversation.id, "CASE-SECRET-USE");
      const card = await pendingOf(sent.run.id);
      expect(card.secrets).toEqual(["SRV_TOKEN"]);
      expect(card.args).toEqual({ command: 'echo "chave={{secret:SRV_TOKEN}}"' });
      await api.approvals.decide(card.id, { decision: "approve" });
      await until(
        async () => (await api.runs.get(sent.run.id)).status === "done" || undefined,
        "done",
      );

      const events = (await api.runs.events(sent.run.id, { limit: 1000 })).items;
      expect(String(events.find((e) => e.type === "tool_result")?.payload.content)).toContain(
        "[REDACTED:SRV_TOKEN]",
      );
      const everything = JSON.stringify([
        events,
        await api.conversations.messages(conversation.id),
        f.events,
      ]);
      expect(everything).not.toContain(VALUE);
      expect(everything).toContain("{{secret:SRV_TOKEN}}");

      // Even text that reached the database before the secret was known is scrubbed on the way out.
      const typed = await api.conversations.send(conversation.id, `minha chave é ${VALUE}, guarde`);
      const page = await api.conversations.messages(conversation.id);
      expect(JSON.stringify(page)).not.toContain(VALUE);
      expect(page.items.find((m) => m.id === typed.message.id)?.text).toContain(
        "[REDACTED:SRV_TOKEN]",
      );
      f.close();
    });

    it("request_secret: the app answers through the API and the bot learns only that it is available", async () => {
      const { api, bot, conversation, f } = await setup("Pedinte");
      const sent = await api.conversations.send(conversation.id, "CASE-ASK-SECRET");
      await until(
        async () => (await api.runs.get(sent.run.id)).status === "waiting_user" || undefined,
        "waiting_user",
      );
      const request = await api.vault.request(sent.run.id);
      expect(request).toMatchObject({
        runId: sent.run.id,
        botId: bot.id,
        name: "ASKED_TOKEN",
        reason: "para o teste",
      });
      // The bot's message in the chat says what it needs, without a form to type the value in.
      const messages = await until(async () => {
        const page = await api.conversations.messages(conversation.id);
        return page.items.some((m) => m.text.includes("ASKED_TOKEN")) ? page.items : undefined;
      }, "the bot's request in the chat");
      expect(messages.find((m) => m.text.includes("ASKED_TOKEN"))?.authorKind).toBe("bot");

      expect(await code(api.vault.answerRequest(sent.run.id, {}))).toBe("invalid_request");
      const answer = await api.vault.answerRequest(sent.run.id, {
        value: "asked-token-value-4242",
      });
      expect(answer).toEqual({ name: "ASKED_TOKEN", provided: true });
      await until(
        async () => (await api.runs.get(sent.run.id)).status === "done" || undefined,
        "done",
      );
      expect(await api.vault.request(sent.run.id)).toBeNull();
      const result = (await api.runs.events(sent.run.id, { types: ["tool_result"] })).items[0];
      expect(result?.payload.content).toBe(
        "The secret ASKED_TOKEN is now available. Use it as {{secret:ASKED_TOKEN}}.",
      );
      expect((await api.vault.list()).find((x) => x.name === "ASKED_TOKEN")?.grantedBotIds).toEqual(
        [bot.id],
      );
      expect(JSON.stringify(f.events)).not.toContain("asked-token-value-4242");
      // Nothing is waiting any more.
      expect(await code(api.vault.answerRequest(sent.run.id, { declined: true }))).toBe("conflict");
      f.close();
    });

    it("everything here needs the token", async () => {
      for (const path of ["/v1/approvals", "/v1/approval-rules", "/v1/secrets"]) {
        const res = await fetch(`${w.started.url}${path}`);
        expect(res.status).toBe(401);
      }
    });
  },
);

describe.skipIf(!DATABASE_URL)(dbSuiteName("a server without a vault"), { timeout: 60_000 }, () => {
  const w = useWorld({ scripts: SCRIPTS, config: { approvals: {} } });
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "no error",
      (error: { code?: string }) => error.code ?? String(error),
    );
  it("says so before anyone tries to write, and writes answer 503 with the reason", async () => {
    const { api } = w.started;
    const status = await api.vault.status();
    expect(status).toMatchObject({ configured: false, ok: false, keyEnv: null });
    expect(status.reason).toContain("vault");
    expect(await api.vault.list()).toEqual([]);
    expect(await code(api.vault.set("NO_VAULT_TOKEN", { value: "12345678" }))).toBe("unavailable");
  });
});
