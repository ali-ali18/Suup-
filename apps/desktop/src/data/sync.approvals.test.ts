import { ApiError, type SuupClient } from "@suup/api";
import { describe, expect, it, vi } from "vitest";
import { makeApproval, makeMessageApproval, makeRule } from "../test-fixtures.js";
import { mergeApprovals } from "./reducers.js";
import { createDataStore, update } from "./store.js";
import { Sync } from "./sync.js";

function setup(api: Record<string, unknown>) {
  const store = createDataStore();
  const errors: string[] = [];
  const notices: { kind: string; text: string }[] = [];
  const sync = new Sync({
    api: api as unknown as SuupClient,
    store,
    onError: (m) => errors.push(m),
    onNotice: (n) => notices.push(n),
  });
  return { store, sync, errors, notices };
}

describe("deciding an approval: never optimistic", () => {
  it("the card changes only with what the server answers, and a 'Permitir destinatário' rule arrives with it", async () => {
    const card = makeMessageApproval();
    const rule = makeRule({ sourceApprovalId: card.id, createdBy: "approval" });
    let resolveDecision: (value: unknown) => void = () => {};
    const decide = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    const { store, sync } = setup({ approvals: { decide } });
    update(store, (s) => mergeApprovals(s, [card]));
    const pending = sync.decideApproval(card.id, { decision: "approve", allowRecipient: true });
    // On its way: the card is exactly as it was.
    expect(store.getState().approvals[card.id]?.status).toBe("pending");
    expect(store.getState().rules).toEqual({});
    resolveDecision({ approval: { ...card, status: "approved", ruleId: rule.id }, rule });
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: true, rule: { id: rule.id } });
    expect(store.getState().approvals[card.id]?.status).toBe("approved");
    expect(store.getState().rules[rule.id]).toEqual(rule);
  });

  it("a second decision on a card whose first is still on its way is not sent", async () => {
    const card = makeApproval();
    let resolveDecision: (value: unknown) => void = () => {};
    const decide = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    const { sync } = setup({ approvals: { decide } });
    const first = sync.decideApproval(card.id, { decision: "deny" });
    expect(await sync.decideApproval(card.id, { decision: "approve" })).toEqual({
      ok: false,
      reason: "busy",
    });
    resolveDecision({ approval: { ...card, status: "denied" }, rule: null });
    await first;
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("already decided elsewhere (409): the card is read again and shows how it stands, with no error toast", async () => {
    const card = makeApproval();
    const decide = vi.fn().mockRejectedValue(new ApiError("conflict", "já decidido", 409));
    const get = vi.fn().mockResolvedValue({ ...card, status: "denied", reason: "no celular" });
    const { store, sync, errors } = setup({ approvals: { decide, get } });
    update(store, (s) => mergeApprovals(s, [card]));
    const outcome = await sync.decideApproval(card.id, { decision: "approve" });
    expect(outcome).toMatchObject({
      ok: false,
      reason: "decided_elsewhere",
      approval: { status: "denied", reason: "no celular" },
    });
    expect(store.getState().approvals[card.id]?.status).toBe("denied");
    expect(errors).toEqual([]);
  });

  it("any other failure leaves the card pending and hands back a friendly sentence (never the server's text)", async () => {
    const card = makeApproval();
    const decide = vi.fn().mockRejectedValue(new ApiError("internal_error", "falhou", 500));
    const { store, sync } = setup({ approvals: { decide } });
    update(store, (s) => mergeApprovals(s, [card]));
    expect(await sync.decideApproval(card.id, { decision: "approve" })).toEqual({
      ok: false,
      reason: "error",
      message: "Algo deu errado. Tenta de novo?",
    });
    expect(store.getState().approvals[card.id]?.status).toBe("pending");
    // And it can be tried again: the failed one is not stuck "on its way".
    decide.mockResolvedValueOnce({ approval: { ...card, status: "approved" }, rule: null });
    expect(await sync.decideApproval(card.id, { decision: "approve" })).toMatchObject({ ok: true });
  });
});

describe("the list of pending cards", () => {
  it("a card held as pending that the list no longer has is read by id: it was decided elsewhere", async () => {
    const stay = makeApproval();
    const gone = makeApproval();
    const list = vi.fn().mockResolvedValue([stay]);
    const get = vi.fn().mockResolvedValue({ ...gone, status: "cancelled" });
    const { store, sync } = setup({ approvals: { list, get } });
    update(store, (s) => mergeApprovals(s, [stay, gone]));
    await sync.loadPendingApprovals();
    expect(list).toHaveBeenCalledWith({ status: "pending", limit: 200 });
    expect(get).toHaveBeenCalledExactlyOnceWith(gone.id);
    expect(store.getState().approvals[gone.id]?.status).toBe("cancelled");
    expect(store.getState().approvals[stay.id]?.status).toBe("pending");
  });
});

describe("rules written from the screens", () => {
  it("a write that fails reports the message and changes nothing; deleting a rule already gone is fine", async () => {
    const remove = vi.fn().mockRejectedValue(new ApiError("not_found", "x", 404));
    const { store, sync } = setup({ rules: { remove } });
    const rule = makeRule();
    store.setState({ ...store.getState(), rules: { [rule.id]: rule } }, true);
    expect(
      await sync.ruleCall(() =>
        Promise.reject(new ApiError("invalid_request", "campo inválido", 400)),
      ),
    ).toEqual({
      ok: false,
      message: "campo inválido",
    });
    expect(Object.keys(store.getState().rules)).toEqual([rule.id]);
    expect(await sync.deleteRule(rule.id)).toEqual({ ok: true });
    expect(store.getState().rules).toEqual({});
  });
});

describe("the stream", () => {
  it("a new card is stored and noticed once; the same card again, or its decision, is not noticed", () => {
    let onEvent: (event: unknown) => void = () => {};
    const subscribe = vi.fn((options: { onEvent: (event: unknown) => void }) => {
      onEvent = options.onEvent;
      return { close() {}, setRuns() {} };
    });
    const { store, sync, notices } = setup({ subscribe });
    void sync.start();
    const card = makeApproval({ summary: "Shell em repo: git push" });
    const frame = (approval: typeof card, change: "created" | "updated", id: number) =>
      onEvent({ type: "approval.changed", id, data: { change, approval } });
    frame(card, "created", 1);
    frame(card, "created", 2);
    frame({ ...card, status: "approved" }, "updated", 3);
    expect(store.getState().approvals[card.id]?.status).toBe("approved");
    expect(notices).toEqual([
      { kind: "approval", botId: card.botId, text: "Shell em repo: git push" },
    ]);
    sync.stop();
  });
});
