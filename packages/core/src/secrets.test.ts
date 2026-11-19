import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "./secrets.js";

describe("redactSecrets (best effort)", () => {
  it.each([
    ["A senha do meu wifi de casa é Bananeira#2049, use quando precisar", "Bananeira#2049"],
    ["minha senha: Abc12345!", "Abc12345!"],
    ["the wifi password is hunter2hunter2", "hunter2hunter2"],
    ["API key = sk-live_abcdefghijklmnopqrstuvwx", "sk-live_abcdefghijklmnopqrstuvwx"],
    ["token: ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["use AKIAABCDEFGHIJKLMNOP para entrar", "AKIAABCDEFGHIJKLMNOP"],
    ["cartão 4111 1111 1111 1111 validade 12/30", "4111 1111 1111 1111"],
    ["o segredo é 'tr0ub4dor&3'", "tr0ub4dor&3"],
    ["bearer a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8"],
    ["-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", "MIIEvQIBADANBg"],
  ])("removes the value in %j", (text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("leaves ordinary text alone", () => {
    for (const text of [
      "Hoje almocei macarrão.",
      "Concluí a migração de 12 arquivos em 2026-11-19.",
      "Resumo: a senha é um requisito do cadastro",
      "caminho /var/tmp/suup-wt-fase2d/packages/core/src/loop/evidence.ts",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});
