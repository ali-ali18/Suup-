import type { Secret } from "@suup/api";
import { KeyRound, Search, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { orderedConnectors, orderedSecrets } from "../../data/reducers.js";
import { nameProblem, writeSecret } from "../../lib/secret-form.js";
import { CheckInput } from "../../ui/choice.js";
import {
  BulletList,
  Dialog,
  FieldError,
  FieldLabel,
  FormRow,
  MutedText,
  Notice,
  Pill,
  TextField,
  Toggle,
} from "../../ui/primitives.js";
import { SecretInput, type SecretInputHandle } from "../../ui/secret-input.js";
import { formatWhen } from "./formatting.js";
import {
  PaneBody,
  PaneHead,
  RowAction,
  RowControl,
  type SectionProps,
  SettingsEmpty,
  SettingsFold,
  SettingsGroup,
  SettingsHint,
  SettingsRow,
} from "./parts.js";
import { useTask } from "./use-task.js";

/**
 * Create or replace a secret. Write-only: the value goes from the field to the server and the field
 * is cleared at once; the screen keeps the name and the metadata the server answers, never the value.
 */
export function SecretDialog({
  existing,
  onClose,
  onSaved,
}: {
  /** The name of the secret being replaced; `undefined`: a new one. */
  existing: string | undefined;
  onClose(): void;
  onSaved?(secret: Secret): void;
}) {
  const { api, sync } = useServices();
  const bots = useData((s) => s.bots);
  const vault = useData((s) => s.vault);
  const field = useRef<SecretInputHandle>(null);
  const [name, setName] = useState(existing ?? "");
  const [description, setDescription] = useState("");
  const [grants, setGrants] = useState<string[]>([]);
  const [problem, setProblem] = useState<{ field: "name" | "value"; text: string } | undefined>(
    undefined,
  );
  const task = useTask();
  const blocked = vault !== null && !vault.ok;

  const save = async () => {
    setProblem(undefined);
    // The name is checked first, while the value is still in the field (nothing to retype).
    const nameError = existing === undefined ? nameProblem(name) : undefined;
    if (nameError !== undefined) {
      setProblem({ field: "name", text: nameError });
      return;
    }
    const value = field.current?.take() ?? "";
    field.current?.clear();
    let saved: Secret | undefined;
    const ok = await task.run(async () => {
      const outcome = await writeSecret(api.vault, name, {
        value,
        ...(description.trim() === "" ? {} : { description: description.trim() }),
        ...(existing === undefined ? { grantBotIds: grants } : {}),
      });
      if (!outcome.ok) return { ok: false, message: outcome.message };
      saved = outcome.result;
      sync.mergeSecretNow(outcome.result);
      return { ok: true };
    });
    if (ok && saved !== undefined) {
      onSaved?.(saved);
      onClose();
    }
  };

  return (
    <Dialog
      title={existing === undefined ? "Novo segredo" : `Trocar o valor de ${existing}`}
      onClose={onClose}
      footer={
        <>
          <Pill tone="secondary" onClick={onClose} disabled={task.busy}>
            Cancelar
          </Pill>
          <Pill
            tone="primary"
            onClick={() => void save()}
            disabled={task.busy || blocked}
            data-testid="secret-write"
          >
            {task.busy ? "Guardando…" : "Guardar"}
          </Pill>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        autoComplete="off"
        data-testid="secret-write-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {blocked && (
          <Notice role="alert">
            O servidor não consegue guardar segredos agora: {vault.reason}
          </Notice>
        )}
        {existing === undefined ? (
          <TextField
            label="Nome"
            value={name}
            onChange={(v) => setName(v.toUpperCase())}
            placeholder="GITHUB_TOKEN"
            error={problem?.field === "name" ? problem.text : undefined}
            hint="Letras maiúsculas, números e sublinhado. O bot escreve {{secret:NOME}} onde o valor deve entrar."
            name="secret-name"
            autoFocus
          />
        ) : (
          <MutedText as="p">
            O valor atual não pode ser mostrado, nem por aqui nem pela API. Quem já pode usar o
            segredo continua podendo.
          </MutedText>
        )}
        <SecretInput
          ref={field}
          label="Valor"
          disabled={task.busy}
          error={problem?.field === "value" ? problem.text : task.error}
          hint="De 8 a 16 384 caracteres. Fica cifrado no servidor e nunca volta para esta tela."
          onEnter={() => void save()}
          autoFocus={existing !== undefined}
        />
        <TextField
          label="Para que serve (opcional)"
          value={description}
          onChange={setDescription}
          hint="Os bots que podem usá-lo veem esta descrição."
        />
        {existing === undefined && sortedBots(bots).length > 0 && (
          <FormRow as="fieldset">
            <FieldLabel as="legend" className="mb-1 p-0">
              Quem pode usar já na criação
            </FieldLabel>
            {sortedBots(bots).map((b) => (
              <label key={b.id} className="flex items-center gap-2">
                <CheckInput
                  type="checkbox"
                  checked={grants.includes(b.id)}
                  onChange={(e) =>
                    setGrants(
                      e.target.checked ? [...grants, b.id] : grants.filter((g) => g !== b.id),
                    )
                  }
                />
                <span>{b.name}</span>
              </label>
            ))}
          </FormRow>
        )}
      </form>
    </Dialog>
  );
}

/** The vault: secret names and who may use them. Values can be written and replaced, never read. */
export function VaultSettings({ title, titleId, onClose }: SectionProps) {
  const { sync, api } = useServices();
  const bots = useData((s) => s.bots);
  const secretsByName = useData((s) => s.secrets);
  const loaded = useData((s) => s.secretsLoaded);
  const vault = useData((s) => s.vault);
  const connectorsByName = useData((s) => s.connectors);
  const secrets = useMemo(() => orderedSecrets({ secrets: secretsByName }), [secretsByName]);
  const connectors = useMemo(
    () => orderedConnectors({ connectors: connectorsByName }),
    [connectorsByName],
  );
  const botList = useMemo(() => sortedBots(bots), [bots]);
  const [dialog, setDialog] = useState<{ existing: string | undefined } | null>(null);
  const [deleting, setDeleting] = useState<Secret | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const grant = useTask();
  const removal = useTask();

  useEffect(() => {
    void sync.loadVault();
    void sync.loadConnectors();
  }, [sync]);

  const blocked = vault !== null && !vault.ok;
  // The filter is an exact substring over the names and descriptions already loaded (case folded).
  const needle = query.trim().toLowerCase();
  const shown =
    needle === ""
      ? secrets
      : secrets.filter(
          (s) =>
            s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle),
        );
  return (
    <>
      <PaneHead title={title} titleId={titleId} onClose={onClose}>
        <Pill
          tone="primary"
          size="sm"
          disabled={blocked}
          data-testid="secret-new"
          onClick={() => setDialog({ existing: undefined })}
        >
          Novo item
        </Pill>
      </PaneHead>
      <PaneBody data-testid="vault-list-card">
        {vault !== null && !vault.ok && (
          <Notice role="status" data-testid="vault-missing">
            <strong>
              {vault.configured
                ? "O cofre não tem a chave"
                : "Este servidor não tem cofre configurado"}
            </strong>
            <p>{vault.reason}.</p>
            <p>
              Sem o cofre não dá para guardar segredos nem para um bot pedir um. Para ligar: gere
              uma chave (<code>suup vault key generate</code>), ponha na variável de ambiente do
              servidor e do worker, e inclua a seção <code>vault</code> no arquivo de configuração
              (veja <code>docs/COFRE.md</code>).
            </p>
          </Notice>
        )}
        <SettingsHint data-testid="vault-status">
          O valor só se escreve ou se troca: nunca é mostrado. Os bots usam o segredo pelo nome.
          {vault?.ok === true && vault.keyEnv !== null && (
            <span className="sr-only" data-testid="vault-ok">
              {" "}
              A chave está na variável {vault.keyEnv} do servidor.
            </span>
          )}
        </SettingsHint>
        {secrets.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-3">
            <label className="flex h-9 items-center gap-2 rounded-pill border border-border-strong px-4 text-text-muted focus-within:outline-2 focus-within:outline-focus">
              <Search size={16} aria-hidden="true" />
              <input
                className="min-w-0 flex-1 border-0 bg-transparent text-label text-text focus-visible:outline-none"
                type="search"
                aria-label="Pesquisar no cofre"
                placeholder="Pesquisar no cofre"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
              />
            </label>
          </div>
        )}
        {!loaded ? (
          <SettingsEmpty>Carregando…</SettingsEmpty>
        ) : secrets.length === 0 ? (
          <SettingsEmpty data-testid="vault-empty">
            Nada guardado ainda. Adicione uma credencial com Novo item, ou espere um bot pedir: o
            formulário seguro aparece na conversa.
          </SettingsEmpty>
        ) : shown.length === 0 ? (
          <SettingsEmpty>Nenhum item com “{query.trim()}”.</SettingsEmpty>
        ) : (
          <SettingsGroup>
            {shown.map((secret) => {
              const usedBy = connectors.filter((c) => c.secretNames.includes(secret.name));
              const expanded = open === secret.name;
              return (
                <div key={secret.name} data-testid="secret-row" data-name={secret.name}>
                  <SettingsRow
                    icon={KeyRound}
                    title={secret.name}
                    description={[
                      secret.description !== "" ? secret.description : undefined,
                      secret.lastUsedAt === null
                        ? "Nunca usado"
                        : `Usado em ${formatWhen(secret.lastUsedAt)}`,
                      secret.grantedBotIds.length === 0
                        ? "nenhum bot pode usar"
                        : `${secret.grantedBotIds.length} ${secret.grantedBotIds.length === 1 ? "bot pode usar" : "bots podem usar"}`,
                      usedBy.length > 0
                        ? `usado pelo conector ${usedBy.map((c) => c.name).join(", ")}`
                        : undefined,
                    ]
                      .filter((part) => part !== undefined)
                      .join(" · ")}
                    control={
                      <RowAction
                        aria-expanded={expanded}
                        data-testid="secret-grants-toggle"
                        onClick={() => setOpen(expanded ? null : secret.name)}
                      >
                        Gerenciar
                      </RowAction>
                    }
                  />
                  {expanded && (
                    <SettingsFold>
                      <SettingsGroup label="Quem pode usar" icon={Users} testId="secret-grants">
                        {botList.length === 0 && <SettingsRow title="Nenhum bot" />}
                        {botList.map((b) => {
                          const on = secret.grantedBotIds.includes(b.id);
                          return (
                            <SettingsRow
                              key={b.id}
                              title={b.name}
                              control={
                                <Toggle
                                  checked={on}
                                  disabled={grant.busy}
                                  label={`${b.name} pode usar ${secret.name}`}
                                  onChange={(next) =>
                                    void grant.run(() =>
                                      sync.secretCall(() =>
                                        next
                                          ? api.vault.grant(secret.name, b.id)
                                          : api.vault.revoke(secret.name, b.id),
                                      ),
                                    )
                                  }
                                />
                              }
                            />
                          );
                        })}
                      </SettingsGroup>
                      {grant.error !== undefined && <FieldError>{grant.error}</FieldError>}
                      <SettingsHint>A mudança vale a partir da próxima execução.</SettingsHint>
                      <RowControl end>
                        <RowAction
                          disabled={blocked}
                          data-testid="secret-replace"
                          onClick={() => setDialog({ existing: secret.name })}
                        >
                          Trocar o valor
                        </RowAction>
                        <RowAction
                          danger
                          data-testid="secret-delete"
                          onClick={() => setDeleting(secret)}
                        >
                          Apagar
                        </RowAction>
                      </RowControl>
                    </SettingsFold>
                  )}
                </div>
              );
            })}
          </SettingsGroup>
        )}
      </PaneBody>
      {dialog !== null && (
        <SecretDialog existing={dialog.existing} onClose={() => setDialog(null)} />
      )}
      {deleting !== null && (
        <Dialog
          title={`Apagar ${deleting.name}?`}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Pill tone="secondary" onClick={() => setDeleting(null)} disabled={removal.busy}>
                Cancelar
              </Pill>
              <Pill
                tone="danger"
                disabled={removal.busy}
                data-testid="secret-delete-confirm"
                onClick={() =>
                  void removal
                    .run(() => sync.deleteSecret(deleting.name))
                    .then((ok) => ok && setDeleting(null))
                }
              >
                {removal.busy ? "Apagando…" : "Apagar o segredo"}
              </Pill>
            </>
          }
        >
          <p>
            O valor some do cofre e não dá para recuperá-lo. Quem usa{" "}
            <strong>{deleting.name}</strong> deixa de funcionar:
          </p>
          <BulletList>
            <li>
              os bots que usam o marcador <code>{`{{secret:${deleting.name}}}`}</code>
            </li>
            {connectors.some((c) => c.secretNames.includes(deleting.name)) && (
              <li>
                os conectores{" "}
                {connectors
                  .filter((c) => c.secretNames.includes(deleting.name))
                  .map((c) => c.name)
                  .join(", ")}
                , que citam este segredo.
              </li>
            )}
          </BulletList>
          {removal.error !== undefined && <FieldError>{removal.error}</FieldError>}
        </Dialog>
      )}
    </>
  );
}
