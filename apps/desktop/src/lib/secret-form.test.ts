import { ApiError } from "@suup/api";
import { describe, expect, it, vi } from "vitest";
import { makeSecret } from "../test-fixtures.js";
import {
  answerSecretRequest,
  hostsProblem,
  nameProblem,
  parseHosts,
  scrubSecret,
  valueProblem,
  writeSecret,
  writeSecretHosts,
} from "./secret-form.js";

const HOSTS = ["api.github.com"];
const VALUE = "ghp_SuperSecretValue123";

describe("the secure form never repeats the value", () => {
  it("scrubSecret takes the value out of any text, wherever it is and however many times", () => {
    expect(scrubSecret(`recusado: ${VALUE} e de novo ${VALUE}.`, VALUE)).toBe(
      "recusado: [valor omitido] e de novo [valor omitido].",
    );
    expect(scrubSecret("sem nada", VALUE)).toBe("sem nada");
    expect(scrubSecret("x", "")).toBe("x");
    // What was typed with spaces around it is scrubbed trimmed too.
    expect(scrubSecret(`tinha ${VALUE} aqui`, ` ${VALUE} `)).not.toContain(VALUE);
  });

  it("the value is checked without being echoed", () => {
    expect(valueProblem("curto")).toMatch(/pelo menos 8/);
    expect(valueProblem("curto")).not.toContain("curto");
    expect(valueProblem(VALUE)).toBeUndefined();
    expect(valueProblem("x".repeat(16_385))).toMatch(/passa de/);
  });

  it("answering sends the value to the answer endpoint only, and the result holds the name only", async () => {
    const answerRequest = vi.fn().mockResolvedValue({ name: "GH_TOKEN", provided: true });
    const outcome = await answerSecretRequest({ answerRequest }, "run-1", {
      value: VALUE,
      hosts: HOSTS,
    });
    expect(answerRequest).toHaveBeenCalledExactlyOnceWith("run-1", { value: VALUE, hosts: HOSTS });
    expect(outcome).toEqual({ ok: true, result: { name: "GH_TOKEN", provided: true } });
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
  });

  it("a refusal of the server that echoes the value reaches the screen without it", async () => {
    const answerRequest = vi
      .fn()
      .mockRejectedValue(new ApiError("invalid_request", `valor inválido: ${VALUE}`, 400));
    const outcome = await answerSecretRequest({ answerRequest }, "run-1", {
      value: VALUE,
      hosts: HOSTS,
    });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
    expect(outcome).toMatchObject({ ok: false, conflict: false });
  });

  it("a run that no longer waits for the secret is a conflict, said plainly", async () => {
    const answerRequest = vi.fn().mockRejectedValue(new ApiError("conflict", "x", 409));
    const outcome = await answerSecretRequest({ answerRequest }, "r", {
      value: VALUE,
      hosts: HOSTS,
    });
    expect(outcome).toMatchObject({ ok: false, conflict: true });
  });

  it("an unexpected failure (not an ApiError) says nothing about its content", async () => {
    const answerRequest = vi.fn().mockRejectedValue(new TypeError(`falhou com ${VALUE}`));
    const outcome = await answerSecretRequest({ answerRequest }, "r", {
      value: VALUE,
      hosts: HOSTS,
    });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
  });

  it("a value that is too short never leaves the form; declining sends no value", async () => {
    const answerRequest = vi.fn().mockResolvedValue({ name: "GH_TOKEN", provided: false });
    expect(
      (await answerSecretRequest({ answerRequest }, "r", { value: "curto", hosts: HOSTS })).ok,
    ).toBe(false);
    expect(answerRequest).not.toHaveBeenCalled();
    await answerSecretRequest({ answerRequest }, "r", { declined: true });
    expect(answerRequest).toHaveBeenCalledExactlyOnceWith("r", { declined: true });
  });

  it("writing a secret from the vault screen returns the metadata and nothing else", async () => {
    const saved = makeSecret({ name: "GH_TOKEN" });
    const set = vi.fn().mockResolvedValue(saved);
    const outcome = await writeSecret({ set }, "GH_TOKEN", {
      value: VALUE,
      hosts: HOSTS,
      description: "push",
      grantBotIds: ["b1"],
    });
    expect(set).toHaveBeenCalledExactlyOnceWith("GH_TOKEN", {
      value: VALUE,
      hosts: HOSTS,
      description: "push",
      grantBotIds: ["b1"],
    });
    expect(outcome).toEqual({ ok: true, result: saved });
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
    // No description and no grants: the fields are left out, not sent empty.
    await writeSecret({ set }, "GH_TOKEN", {
      value: VALUE,
      hosts: HOSTS,
      description: "",
      grantBotIds: [],
    });
    expect(set).toHaveBeenLastCalledWith("GH_TOKEN", { value: VALUE, hosts: HOSTS });
  });

  it("a bad name is explained before anything is sent", async () => {
    const set = vi.fn();
    expect(nameProblem("")).toMatch(/nome/);
    expect(nameProblem("gh_token")).toMatch(/maiúsculas/);
    expect(nameProblem("GH_TOKEN")).toBeUndefined();
    const outcome = await writeSecret({ set }, "gh token", { value: VALUE, hosts: HOSTS });
    expect(outcome.ok).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it("the sites typed in the field: one per line or comma, lower case, no repeats", () => {
    expect(parseHosts("API.GitHub.com.\n\n a.test , b.test\napi.github.com")).toEqual([
      "api.github.com",
      "a.test",
      "b.test",
    ]);
    expect(parseHosts("  \n ")).toEqual([]);
  });

  it("a site is only a name: friendly explanations, and a list needs at least one", () => {
    expect(hostsProblem("api.github.com\nlocalhost")).toBeUndefined();
    expect(hostsProblem("")).toMatch(/Diga para onde/);
    for (const bad of [
      "https://a.test",
      "a.test:8443",
      "a.test/x",
      "*.a.test",
      "10.0.0.1",
      "a..test",
    ]) {
      expect(hostsProblem(bad), bad).toMatch(/não é um endereço válido/);
    }
  });

  it("answering and writing refuse an empty list before anything is sent", async () => {
    const answerRequest = vi.fn();
    const set = vi.fn();
    expect(
      (await answerSecretRequest({ answerRequest }, "r", { value: VALUE, hosts: [] })).ok,
    ).toBe(false);
    expect(answerRequest).not.toHaveBeenCalled();
    expect((await writeSecret({ set }, "GH_TOKEN", { value: VALUE, hosts: [] })).ok).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it("changing only the sites goes through the PATCH route and returns the metadata", async () => {
    const saved = makeSecret({ name: "GH_TOKEN", hosts: ["a.test"], blocked: false });
    const setHosts = vi.fn().mockResolvedValue(saved);
    expect(await writeSecretHosts({ setHosts }, "GH_TOKEN", ["a.test"])).toEqual({
      ok: true,
      result: saved,
    });
    expect(setHosts).toHaveBeenCalledExactlyOnceWith("GH_TOKEN", { hosts: ["a.test"] });
    expect((await writeSecretHosts({ setHosts }, "GH_TOKEN", [])).ok).toBe(false);
  });
});
