// Owns the vault's cryptography: AES-256-GCM through `node:crypto`, a random 96-bit nonce for every
// value, the secret's name bound in as associated data (so a ciphertext copied onto another
// secret's row fails to decrypt), and a fingerprint of the key stored with each value so the key
// can be replaced. Nothing here reads the environment or the database, and no message it raises
// ever contains a key or a value.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AAD_PREFIX = "suup-vault:v1:";

export type VaultErrorCode =
  /** The vault is not set up in the configuration. */
  | "not_configured"
  /** The environment variable that holds the key is not set. */
  | "key_missing"
  /** The key is not a valid 32-byte key. */
  | "key_invalid"
  /** A value was written with a key that is not configured any more. */
  | "key_unknown"
  /** The ciphertext does not authenticate: wrong key, altered, or moved to another secret. */
  | "decrypt_failed"
  | "value_invalid";

/** A vault failure. The message is for the person and never holds a key or a value. */
export class VaultError extends Error {
  override readonly name = "VaultError";
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface VaultKey {
  /** A fingerprint of the key (not the key): stored with every value it encrypts. */
  id: string;
  readonly key: Buffer;
}

/** A new random key, as base64url text (print it once and keep it somewhere safe). */
export function generateKeyText(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}

export function fingerprint(key: Buffer): string {
  return createHash("sha256").update("suup-vault-key-id:").update(key).digest("hex").slice(0, 16);
}

/** Reads a key given as base64, base64url or 64 hex characters. Throws `VaultError` `key_invalid`. */
export function parseKey(text: string, source: string): VaultKey {
  const trimmed = text.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) key = Buffer.from(trimmed, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(trimmed)) {
    // Node's base64 decoder takes both alphabets (standard and URL-safe).
    key = Buffer.from(trimmed.replace(/=+$/, ""), "base64");
  }
  if (key === undefined || key.length !== KEY_BYTES) {
    throw new VaultError(
      "key_invalid",
      `A chave do cofre em ${source} não é válida: precisa ter ${KEY_BYTES} bytes, em base64 ou 64 caracteres hexadecimais. Gere uma com: suup vault key generate`,
    );
  }
  return { id: fingerprint(key), key };
}

export interface Sealed {
  nonce: Buffer;
  /** The encrypted value followed by its 16-byte authentication tag. */
  ciphertext: Buffer;
  keyId: string;
}

function aad(name: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}${name}`, "utf8");
}

export function encrypt(key: VaultKey, name: string, value: string): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(name));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]), keyId: key.id };
}

/** Decrypts a stored value. Throws `VaultError` `key_unknown` or `decrypt_failed`, never the value. */
export function decrypt(keys: ReadonlyMap<string, VaultKey>, name: string, sealed: Sealed): string {
  const key = keys.get(sealed.keyId);
  if (key === undefined) {
    throw new VaultError(
      "key_unknown",
      `O segredo ${name} foi cifrado com uma chave (${sealed.keyId}) que não está configurada. Informe a chave antiga em vault.previousKeyEnvs ou restaure a variável de ambiente anterior.`,
    );
  }
  if (sealed.ciphertext.length < TAG_BYTES || sealed.nonce.length !== NONCE_BYTES) {
    throw new VaultError("decrypt_failed", `O segredo ${name} está corrompido.`);
  }
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, sealed.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad(name));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new VaultError(
      "decrypt_failed",
      `Não foi possível decifrar o segredo ${name}: a chave está errada ou o dado foi alterado.`,
    );
  }
}
