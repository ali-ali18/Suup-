// Owns the vault as the rest of the system uses it: a master key read from an environment
// variable, secrets written and read through `@suup/db` as ciphertext only, the grants per bot, the
// access a run gets (placeholder values at the moment of the action) and the redactor that knows
// every secret. Values never leave this module except into `SecretAccess.resolve`, which only the
// registry's execution layer calls.
import {
  createRedactor,
  isSecretName,
  type MutableRedactor,
  type Redactor,
  type SecretAccess,
  type SecretInfo,
  SecretUnavailableError,
} from "@suup/core";
import {
  type Db,
  deleteSecret,
  getSecretRowByName,
  getSecretRowForBot,
  grantSecret,
  listSecretInfoForBot,
  listSecretRows,
  listSecrets,
  markSecretUsed,
  putSecret,
  replaceSecretCipher,
  revokeSecret,
  type SecretMeta,
} from "@suup/db";
import { decrypt, encrypt, parseKey, VaultError, type VaultKey } from "./crypto.js";

type Env = Record<string, string | undefined>;

/** The `vault` section of the configuration. */
export interface VaultSettings {
  /** NAME of the environment variable that holds the master key. */
  keyEnv: string;
  /** Names of variables that hold older keys: used to read (and re-encrypt) values written with them. */
  previousKeyEnvs?: string[] | undefined;
}

export const DEFAULT_VAULT_KEY_ENV = "SUUP_VAULT_KEY";

/** Values shorter than this cannot be redacted without mangling ordinary text. */
export const MIN_SECRET_LENGTH = 8;
export const MAX_SECRET_LENGTH = 16_384;

export interface VaultStatus {
  configured: boolean;
  keyEnv: string | null;
  /** The key is present and valid. */
  ok: boolean;
  /** The fingerprint of the current key, when it is valid. */
  keyId: string | null;
  reason: string;
}

export interface RotateResult {
  /** Re-encrypted with the current key. */
  rotated: number;
  /** Already on the current key. */
  alreadyCurrent: number;
  /** Could not be read (the old key is not configured). */
  failed: string[];
}

export interface VerifyResult {
  total: number;
  /** Names that cannot be decrypted (wrong key, key missing, corrupted). */
  unreadable: string[];
  /** Readable, but on an older key than the current one. */
  onOldKey: number;
}

export interface Vault {
  readonly settings: VaultSettings | undefined;
  status(): VaultStatus;
  /** Creates or replaces a secret. The value is never returned. */
  set(name: string, value: string, options?: { description?: string }): Promise<SecretMeta>;
  list(): Promise<SecretMeta[]>;
  remove(name: string): Promise<boolean>;
  grant(name: string, botId: string): Promise<void>;
  revoke(name: string, botId: string): Promise<boolean>;
  /** The secrets a bot may use, for the model (names and descriptions). */
  infoFor(botId: string): Promise<SecretInfo[]>;
  /** What a run of this bot gets. */
  accessFor(botId: string): SecretAccess;
  /**
   * The values of the secrets a CONNECTOR refers to, for opening its connection. Not tied to a bot:
   * the user who configured the connector named these secrets (and the connector is granted to
   * bots, not the secrets). The values go into the child's environment or an HTTP header and
   * nowhere else; they are known to the redactor before they are handed over.
   */
  resolveForConnector(names: readonly string[]): Promise<Record<string, string>>;
  /** Scrubs every known value. Call `refresh` first to be sure the set is current. */
  readonly redactor: Redactor;
  /** Reloads every value into the redactor, unless it was done less than `maxAgeMs` ago. */
  refresh(maxAgeMs?: number): Promise<void>;
  /** Whether every stored value can be read with the keys configured. Never returns a value. */
  verify(): Promise<VerifyResult>;
  /** Re-encrypts what is not on the current key (needs the old keys in `previousKeyEnvs`). */
  rotate(): Promise<RotateResult>;
}

export function createVault(db: () => Db, env: Env, settings: VaultSettings | undefined): Vault {
  const redactor: MutableRedactor = createRedactor();
  let loadedAt = 0;
  let loading: Promise<void> | undefined;

  const keyRing = (): { current: VaultKey; all: Map<string, VaultKey> } => {
    if (settings === undefined) {
      throw new VaultError(
        "not_configured",
        'O cofre não está configurado: acrescente "vault": { "keyEnv": "SUUP_VAULT_KEY" } à configuração (veja docs/COFRE.md).',
      );
    }
    const raw = env[settings.keyEnv];
    if (raw === undefined || raw.trim() === "") {
      throw new VaultError(
        "key_missing",
        `A variável de ambiente ${settings.keyEnv} (a chave do cofre) não está definida. Gere uma chave com "suup vault key generate" e defina a variável.`,
      );
    }
    const current = parseKey(raw, `a variável ${settings.keyEnv}`);
    const all = new Map<string, VaultKey>([[current.id, current]]);
    for (const name of settings.previousKeyEnvs ?? []) {
      const old = env[name];
      if (old === undefined || old.trim() === "") continue;
      const parsed = parseKey(old, `a variável ${name}`);
      all.set(parsed.id, parsed);
    }
    return { current, all };
  };

  const checkValue = (value: string): void => {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new VaultError(
        "value_invalid",
        `O valor do segredo precisa ter pelo menos ${MIN_SECRET_LENGTH} caracteres (valores curtos não podem ser removidos dos registros sem estragar o texto comum).`,
      );
    }
    if (value.length > MAX_SECRET_LENGTH) {
      throw new VaultError("value_invalid", `O valor passa de ${MAX_SECRET_LENGTH} caracteres.`);
    }
  };

  const checkName = (name: string): void => {
    if (!isSecretName(name)) {
      throw new VaultError(
        "value_invalid",
        `Nome de segredo inválido: use letras maiúsculas, números e sublinhado, começando por letra (ex.: GITHUB_TOKEN).`,
      );
    }
  };

  const reload = async (): Promise<void> => {
    const { all } = keyRing();
    const rows = await listSecretRows(db());
    const known: [string, string][] = [];
    for (const row of rows) {
      try {
        known.push([
          row.name,
          decrypt(all, row.name, {
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            keyId: row.keyId,
          }),
        ]);
      } catch {
        // A value that cannot be read cannot appear anywhere either; `rotate` and the doctor
        // report it.
      }
    }
    // Swapped in one synchronous step: no write of this process sees a half-loaded set.
    redactor.clear();
    for (const [name, value] of known) redactor.add(name, value);
    loadedAt = Date.now();
  };

  const vault: Vault = {
    settings,
    redactor,
    status() {
      if (settings === undefined) {
        return {
          configured: false,
          keyEnv: null,
          ok: false,
          keyId: null,
          reason: 'cofre não configurado (seção "vault" ausente)',
        };
      }
      try {
        const { current } = keyRing();
        return {
          configured: true,
          keyEnv: settings.keyEnv,
          ok: true,
          keyId: current.id,
          reason: `chave presente em ${settings.keyEnv} (id ${current.id})`,
        };
      } catch (error) {
        return {
          configured: true,
          keyEnv: settings.keyEnv,
          ok: false,
          keyId: null,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async set(name, value, options = {}) {
      checkName(name);
      checkValue(value);
      const { current } = keyRing();
      const sealed = encrypt(current, name, value);
      const meta = await putSecret(db(), {
        name,
        ...(options.description === undefined ? {} : { description: options.description }),
        ...sealed,
      });
      // From this instant the value is scrubbed from everything this process writes.
      redactor.add(name, value);
      return meta;
    },
    list: () => listSecrets(db()),
    async remove(name) {
      const gone = await deleteSecret(db(), name);
      if (gone) loadedAt = 0; // reload (without it) at the next refresh
      return gone;
    },
    async grant(name, botId) {
      await grantSecret(db(), name, botId);
    },
    revoke: (name, botId) => revokeSecret(db(), name, botId),
    infoFor: (botId) => listSecretInfoForBot(db(), botId),
    accessFor(botId) {
      return {
        redactor,
        async resolve(names) {
          const { all } = keyRing();
          const values: Record<string, string> = {};
          for (const name of names) {
            const row = await getSecretRowForBot(db(), botId, name);
            if (row === null) throw new SecretUnavailableError(name);
            const value = decrypt(all, name, {
              nonce: row.nonce,
              ciphertext: row.ciphertext,
              keyId: row.keyId,
            });
            // Known to the redactor before it is handed to anything that could print it.
            redactor.add(name, value);
            values[name] = value;
            void markSecretUsed(db(), name).catch(() => {});
          }
          return values;
        },
      };
    },
    async resolveForConnector(names) {
      const { all } = keyRing();
      const values: Record<string, string> = {};
      for (const name of names) {
        const row = await getSecretRowByName(db(), name);
        if (row === null) {
          throw new VaultError(
            "value_invalid",
            `o segredo ${name} não existe no cofre (cadastre com: suup vault set ${name})`,
          );
        }
        const value = decrypt(all, name, {
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          keyId: row.keyId,
        });
        redactor.add(name, value);
        values[name] = value;
        void markSecretUsed(db(), name).catch(() => {});
      }
      return values;
    },
    async refresh(maxAgeMs = 0) {
      if (settings === undefined || !vault.status().ok) return;
      if (loading !== undefined) return loading;
      if (maxAgeMs > 0 && Date.now() - loadedAt < maxAgeMs) return;
      loading = reload().finally(() => {
        loading = undefined;
      });
      return loading;
    },
    async verify() {
      const { current, all } = keyRing();
      const result: VerifyResult = { total: 0, unreadable: [], onOldKey: 0 };
      for (const row of await listSecretRows(db())) {
        result.total += 1;
        try {
          decrypt(all, row.name, {
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            keyId: row.keyId,
          });
          if (row.keyId !== current.id) result.onOldKey += 1;
        } catch {
          result.unreadable.push(row.name);
        }
      }
      return result;
    },
    async rotate() {
      const { current, all } = keyRing();
      const result: RotateResult = { rotated: 0, alreadyCurrent: 0, failed: [] };
      for (const row of await listSecretRows(db())) {
        if (row.keyId === current.id) {
          result.alreadyCurrent += 1;
          continue;
        }
        try {
          const value = decrypt(all, row.name, {
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            keyId: row.keyId,
          });
          const sealed = encrypt(current, row.name, value);
          if (await replaceSecretCipher(db(), row, sealed)) result.rotated += 1;
          else result.failed.push(row.name);
        } catch {
          result.failed.push(row.name);
        }
      }
      return result;
    },
  };
  return vault;
}
