import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decrypt,
  encrypt,
  fingerprint,
  generateKeyText,
  KEY_BYTES,
  parseKey,
  VaultError,
  type VaultKey,
} from "../src/index.js";

const keyOf = (): VaultKey => parseKey(generateKeyText(), "teste");
const ring = (...keys: VaultKey[]) => new Map(keys.map((k) => [k.id, k]));

describe("vault crypto (AES-256-GCM)", () => {
  it("round-trips a value, including text that is not ASCII", () => {
    const key = keyOf();
    for (const value of [
      "sk-live-abcdef0123456789",
      "senha com acentuação ✓ 日本語",
      "x".repeat(10_000),
    ]) {
      const sealed = encrypt(key, "TOKEN", value);
      expect(decrypt(ring(key), "TOKEN", sealed)).toBe(value);
    }
  });

  it("uses a new random nonce every time, so the same value never encrypts the same way", () => {
    const key = keyOf();
    const a = encrypt(key, "TOKEN", "same-value-here");
    const b = encrypt(key, "TOKEN", "same-value-here");
    expect(a.nonce.length).toBe(12);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.keyId).toBe(key.id);
  });

  it("does not hold the plaintext", () => {
    const key = keyOf();
    const value = "plaintext-value-0001";
    const sealed = encrypt(key, "TOKEN", value);
    expect(sealed.ciphertext.toString("utf8")).not.toContain(value);
    expect(sealed.ciphertext.toString("hex")).not.toContain(Buffer.from(value).toString("hex"));
  });

  it("detects any change to the ciphertext, the tag or the nonce", () => {
    const key = keyOf();
    const sealed = encrypt(key, "TOKEN", "a value worth protecting");
    for (const at of [0, 5, sealed.ciphertext.length - 1]) {
      const tampered = Buffer.from(sealed.ciphertext);
      tampered[at] = (tampered[at] ?? 0) ^ 0x01;
      expect(() => decrypt(ring(key), "TOKEN", { ...sealed, ciphertext: tampered })).toThrow(
        expect.objectContaining({ code: "decrypt_failed" }),
      );
    }
    const nonce = Buffer.from(sealed.nonce);
    nonce[0] = (nonce[0] ?? 0) ^ 0xff;
    expect(() => decrypt(ring(key), "TOKEN", { ...sealed, nonce })).toThrow(VaultError);
    expect(() =>
      decrypt(ring(key), "TOKEN", { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 8) }),
    ).toThrow(VaultError);
  });

  it("fails with the wrong key, and says the key is unknown when it is not configured", () => {
    const key = keyOf();
    const other = keyOf();
    const sealed = encrypt(key, "TOKEN", "a value worth protecting");
    // The right id but the wrong key bytes.
    const forged = new Map([[key.id, { id: key.id, key: other.key }]]);
    expect(() => decrypt(forged, "TOKEN", sealed)).toThrow(
      expect.objectContaining({ code: "decrypt_failed" }),
    );
    expect(() => decrypt(ring(other), "TOKEN", sealed)).toThrow(
      expect.objectContaining({ code: "key_unknown" }),
    );
  });

  it("binds the ciphertext to the secret's name", () => {
    const key = keyOf();
    const sealed = encrypt(key, "SECRET_A", "a value worth protecting");
    expect(() => decrypt(ring(key), "SECRET_B", sealed)).toThrow(
      expect.objectContaining({ code: "decrypt_failed" }),
    );
  });

  it("never puts a key or a value in an error message", () => {
    const key = keyOf();
    const value = "a-very-secret-value-123";
    const sealed = encrypt(key, "TOKEN", value);
    const keyText = key.key.toString("base64url");
    const caught = (fn: () => unknown): string => {
      try {
        fn();
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    };
    const messages = [
      caught(() => decrypt(ring(keyOf()), "TOKEN", sealed)),
      caught(() => decrypt(ring(key), "OTHER", sealed)),
      caught(() => parseKey(`${keyText}zz`, "a variável X")),
    ];
    for (const message of messages) {
      expect(message).not.toContain(value);
      expect(message).not.toContain(keyText);
    }
  });
});

describe("master key", () => {
  it("accepts base64, base64url and hex of 32 bytes, with the same fingerprint", () => {
    const raw = randomBytes(KEY_BYTES);
    const forms = [
      raw.toString("base64"),
      raw.toString("base64url"),
      raw.toString("hex"),
      `  ${raw.toString("hex")}\n`,
    ];
    const ids = forms.map((f) => parseKey(f, "t").id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(fingerprint(raw));
    expect(ids[0]).toHaveLength(16);
  });

  it("refuses anything else, naming where it came from", () => {
    for (const bad of [
      "",
      "short",
      randomBytes(16).toString("base64url"),
      randomBytes(33).toString("base64"),
      "zz".repeat(32),
    ]) {
      expect(() => parseKey(bad, "a variável SUUP_VAULT_KEY")).toThrow(
        expect.objectContaining({ code: "key_invalid" }),
      );
    }
    expect(() => parseKey("short", "a variável SUUP_VAULT_KEY")).toThrow(/SUUP_VAULT_KEY/);
  });

  it("generates a different valid key every time", () => {
    const a = generateKeyText();
    expect(a).not.toBe(generateKeyText());
    expect(parseKey(a, "t").key).toHaveLength(KEY_BYTES);
  });
});
