import { describe, expect, it, vi } from "vitest";
import { DATABASE_URL, dbSuiteName, useProject } from "./harness.js";

// The bot comes back by itself, from the terminal: `suup run` follows the run, which parks itself
// for the return the bot scheduled and is woken by the follower (this process only works on that
// run). Time is moved in the database (`wake_at` into the past), never waited for.

vi.setConfig({ testTimeout: 30_000 });

const call = (name: string, args: unknown) => ({ calls: [{ name, args }] });

describe.skipIf(!DATABASE_URL)(dbSuiteName("suup run: the bot comes back by itself"), () => {
  const p = useProject();
  const runIdOf = (stdout: string): string => {
    const id = stdout
      .split("\n")
      .find((line) => line.startsWith("Execução ") && line.includes(" criada"));
    const found = id?.split(" ")[1];
    if (found === undefined) throw new Error(`no run id:\n${stdout}`);
    return found;
  };
  const makeDue = async (runId: string) => {
    await p.db
      .sql`update runs set wake_at = now() - interval '1 minute' where id = ${runId} and status = 'waiting_timer'`;
  };
  const statusOf = async (runId: string) =>
    (await p.db.sql<{ status: string }[]>`select status from runs where id = ${runId}`)[0]?.status;
  const typesOf = async (runId: string) =>
    (
      await p.db.sql<
        { type: string }[]
      >`select type from run_events where run_id = ${runId} order by seq`
    ).map((e) => e.type);
  /** Waits until the run is parked, as the CLI shows it, and returns its id. */
  const parked = async (runId: string) => {
    for (let i = 0; i < 400; i++) {
      if ((await statusOf(runId)) === "waiting_timer") return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the run was never parked");
  };

  it("setup", async () => {
    await p.suup(["db", "migrate"]);
    await p.script("roteiro.json", {
      cases: [
        {
          whenObjectiveContains: "CASE-VOLTA",
          agent: [
            call("schedule_return", { inMinutes: 1, note: "Conferir o deploy." }),
            { text: "Disparei o deploy; volto em 1 minuto." },
            { text: "O deploy deu certo." },
          ],
        },
        {
          whenObjectiveContains: "CASE-SAY",
          agent: [
            call("schedule_return", { inMinutes: 1, note: "Conferir." }),
            { text: "Volto em 1 minuto." },
            { text: "Ok, não volto mais." },
          ],
        },
        {
          whenObjectiveContains: "CASE-STOP",
          agent: [
            call("schedule_return", { inMinutes: 1, note: "Conferir." }),
            { text: "Volto em 1 minuto." },
            { text: "Nunca." },
          ],
        },
      ],
    });
    await p.script("outro.json", { agent: [] });
    for (const name of ["volta", "fala", "para"]) {
      const r = await p.suup(["bot", "create", "--name", name, "--model", "model-x"]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
    }
  });

  it("run follows the run through the return: parked, woken when due, and it finishes", async () => {
    let runId = "";
    const r = await p.suup(["run", "CASE-VOLTA faça o deploy", "--bot", "volta"], {
      during: async (h) => {
        await h.waitFor("retorno agendado para");
        runId = runIdOf(h.stdout());
        await parked(runId);
        await makeDue(runId);
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("retorno agendado para");
    expect(r.stdout).toContain("Conferir o deploy.");
    expect(r.stdout).toContain("hora do retorno: Conferir o deploy.");
    expect(await statusOf(runId)).toBe("done");
    expect((await typesOf(runId)).filter((t) => t.startsWith("wait_"))).toEqual([
      "wait_scheduled",
      "wait_fired",
    ]);

    // The diagnostic views show the same, and the recorded run replays to the same log.
    const shown = await p.suup([
      "inspect",
      runId.slice(0, 8),
      "--type",
      "wait_scheduled,wait_fired",
    ]);
    expect(shown.code, shown.stdout + shown.stderr).toBe(0);
    expect(shown.stdout).toContain("wait_scheduled");
    expect(shown.stdout).toContain("wait_fired");
    const replayed = await p.suup(["replay", runId]);
    expect(replayed.code, replayed.stdout + replayed.stderr).toBe(0);
    expect(replayed.stdout).toContain("IDÊNTICO");
  });

  it("show says when a parked run comes back, and stop cancels it right away", async () => {
    let runId = "";
    const r = await p.suup(["run", "CASE-STOP faça o deploy", "--bot", "para"], {
      during: async (h) => {
        await h.waitFor("retorno agendado para");
        runId = runIdOf(h.stdout());
        await parked(runId);
        const shown = await p.suup(["show", runId.slice(0, 8)]);
        expect(shown.stdout).toContain("aguardando o retorno agendado");
        expect(shown.stdout).toContain("Retorno agendado:");
        expect(shown.stdout).toContain("nota: Conferir.");
        const stopped = await p.suup(["stop", runId.slice(0, 8)]);
        expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
        expect(stopped.stdout).toContain("cancelada");
      },
    });
    expect(r.code).toBe(1);
    expect(await statusOf(runId)).toBe("cancelled");
    expect((await typesOf(runId)).filter((t) => t.startsWith("wait_"))).toEqual([
      "wait_scheduled",
      "wait_cancelled",
    ]);
  });

  it("a message to the parked run cancels the return and the run answers it", async () => {
    let runId = "";
    const r = await p.suup(["run", "CASE-SAY faça o deploy", "--bot", "fala"], {
      during: async (h) => {
        await h.waitFor("retorno agendado para");
        runId = runIdOf(h.stdout());
        await parked(runId);
        const said = await p.suup(["say", runId.slice(0, 8), "esquece o deploy"]);
        expect(said.code, said.stdout + said.stderr).toBe(0);
        expect(said.stdout).toContain("retorno agendado foi cancelado");
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(await statusOf(runId)).toBe("done");
    expect(
      (await typesOf(runId)).filter((t) => t.startsWith("wait_") || t === "user_message"),
    ).toEqual(["wait_scheduled", "wait_cancelled", "user_message"]);
  });
});
