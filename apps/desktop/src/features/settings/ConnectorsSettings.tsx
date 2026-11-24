import { BadgeCheck, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { orderedConnectors, orderedSecrets } from "../../data/reducers.js";
import {
  bearerRow,
  buildCreateBody,
  type ConnectorForm,
  emptyForm,
  emptyRow,
  type FormErrors,
  HTTP_WARNING,
  type RefRow,
  STDIO_WARNING,
} from "../../lib/connector-form.js";
import { cx } from "../../lib/cx.js";
import { Dropdown, type DropdownOption } from "../../ui/dropdown.js";
import { Input } from "../../ui/input.js";
import {
  Dialog,
  FieldError,
  FieldHint,
  FieldLabel,
  FormRow,
  FormStack,
  fieldControlClass,
  IconButton,
  Notice,
  Pill,
  TextField,
} from "../../ui/primitives.js";
import { RadioChip, RadioGroup } from "../../ui/radio.js";
import { KIND_LABEL } from "../plugins/ConnectorManage.js";
import { EntryIcon } from "../plugins/EntryIcon.js";
import { type InstalledPlugin, installedPlugins, searchPlugins } from "../plugins/installed.js";
import { usePlugins } from "../plugins/use-plugins.js";
import { PaneBody, PaneHead, type SectionProps, SettingsEmpty } from "./parts.js";
import { useTask } from "./use-task.js";
import { SecretDialog } from "./VaultSettings.js";

const SOURCE_OPTIONS: readonly DropdownOption<RefRow["mode"]>[] = [
  { value: "text", label: "Texto" },
  { value: "secret", label: "Segredo do cofre" },
];
const secretOption = (name: string): DropdownOption => ({ value: name, label: name });
const SCOPE_OPTIONS: readonly DropdownOption<ConnectorForm["scope"]>[] = [
  { value: "read_only", label: "Somente leitura (só as ferramentas de leitura são oferecidas)" },
  { value: "read_write", label: "Leitura e escrita (as que escrevem pedem cartão)" },
];

// ------------------------------------------------------------- the form

function RefRows({
  rows,
  onChange,
  secrets,
  noun,
  onNewSecret,
  extra,
}: {
  rows: RefRow[];
  onChange(rows: RefRow[]): void;
  secrets: readonly string[];
  noun: "variável" | "cabeçalho";
  onNewSecret(): void;
  extra?: React.ReactNode;
}) {
  const set = (id: string, patch: Partial<RefRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <FormRow>
      {rows.map((row) => (
        <div key={row.id} className="cond-row cond-row--ref" data-testid="ref-row">
          <Input
            aria-label={`Nome d${noun === "variável" ? "a" : "o"} ${noun}`}
            placeholder={noun === "variável" ? "NOME_DA_VARIAVEL" : "Nome-do-cabecalho"}
            value={row.key}
            onValueChange={(key) => set(row.id, { key })}
          />
          <Dropdown
            variant="field"
            label={`De onde vem o valor d${noun === "variável" ? "a" : "o"} ${noun}`}
            value={row.mode}
            options={SOURCE_OPTIONS}
            onChange={(mode) => set(row.id, { mode })}
          />
          {row.mode === "text" ? (
            <Input
              aria-label="Valor (texto)"
              placeholder="valor"
              value={row.text}
              onValueChange={(text) => set(row.id, { text })}
            />
          ) : (
            <Dropdown
              variant="field"
              label="Segredo"
              value={row.secret}
              options={[{ value: "", label: "Escolha um segredo…" }, ...secrets.map(secretOption)]}
              onChange={(secret) => set(row.id, { secret })}
            />
          )}
          <IconButton
            label={`Remover ${noun}`}
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
          >
            <Trash2 size={16} aria-hidden="true" />
          </IconButton>
        </div>
      ))}
      <div className="flex gap-2">
        <Pill
          tone="secondary"
          icon={<Plus size={16} aria-hidden="true" />}
          onClick={() => onChange([...rows, emptyRow()])}
        >
          Adicionar {noun}
        </Pill>
        <Pill tone="secondary" onClick={onNewSecret} data-testid="connector-new-secret">
          Cadastrar um segredo novo
        </Pill>
        {extra}
      </div>
      <FieldHint>
        {noun === "variável"
          ? "Só estas variáveis chegam ao programa"
          : "Estes cabeçalhos vão em toda requisição"}
        . Um valor em <strong>texto</strong> fica visível para quem usa a API do servidor: para
        credenciais, escolha <strong>segredo do cofre</strong>.
      </FieldHint>
    </FormRow>
  );
}

function AddConnectorDialog({ onClose, onNewSecret }: { onClose(): void; onNewSecret(): void }) {
  const { sync, api } = useServices();
  const secretsByName = useData((s) => s.secrets);
  const secretNames = useMemo(
    () => orderedSecrets({ secrets: secretsByName }).map((s) => s.name),
    [secretsByName],
  );
  const [form, setForm] = useState<ConnectorForm>(() => emptyForm("stdio"));
  const [errors, setErrors] = useState<FormErrors>({});
  const task = useTask();
  const set = (patch: Partial<ConnectorForm>) => setForm((f) => ({ ...f, ...patch }));

  const create = async () => {
    const built = buildCreateBody(form, secretNames);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    const ok = await task.run(async () => {
      const result = await sync.connectorCall(() => api.connectors.create(built.body));
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    });
    if (ok) onClose();
  };

  return (
    <Dialog
      title="Adicionar conector"
      onClose={onClose}
      wide
      footer={
        <>
          <Pill tone="secondary" onClick={onClose} disabled={task.busy}>
            Cancelar
          </Pill>
          <Pill
            tone="primary"
            onClick={() => void create()}
            disabled={task.busy}
            data-testid="connector-create"
          >
            {task.busy ? "Adicionando…" : "Adicionar conector"}
          </Pill>
        </>
      }
    >
      <FormStack data-testid="connector-form">
        <Notice role="note" data-testid="connector-warning">
          <strong>
            {form.kind === "stdio"
              ? "Atenção: isto roda um programa"
              : "Atenção: isto fala com um servidor"}
          </strong>
          <p>{form.kind === "stdio" ? STDIO_WARNING : HTTP_WARNING}</p>
        </Notice>
        <FormRow>
          <FieldLabel as="span">Tipo</FieldLabel>
          <RadioGroup
            label="Tipo"
            value={form.kind}
            onValueChange={(next) => {
              for (const kind of ["stdio", "http"] as const) if (kind === next) set({ kind });
            }}
            className="flex gap-2"
          >
            {(["stdio", "http"] as const).map((kind) => (
              <RadioChip key={kind} value={kind} size="md" data-testid={`connector-kind-${kind}`}>
                {KIND_LABEL[kind]}
              </RadioChip>
            ))}
          </RadioGroup>
        </FormRow>
        <TextField
          label="Nome"
          value={form.name}
          onChange={(name) => set({ name })}
          placeholder="github"
          error={errors.name}
          hint="Letras minúsculas e números, separados por hífen."
          name="connector-name"
        />
        <TextField
          label="Descrição (opcional)"
          value={form.description}
          onChange={(description) => set({ description })}
        />
        {form.kind === "stdio" ? (
          <>
            <TextField
              label="Programa"
              value={form.command}
              onChange={(command) => set({ command })}
              placeholder="npx"
              error={errors.command}
              hint="Só o executável, sem espaços, no computador onde o servidor trabalha."
              name="connector-command"
            />
            <TextField
              label="Argumentos (um por linha)"
              value={form.argsText}
              onChange={(argsText) => set({ argsText })}
              multiline
              rows={4}
              error={errors.args}
              hint="Cada linha é um argumento, entregue ao programa sem passar por um shell."
              name="connector-args"
            />
            <FormRow>
              <FieldLabel as="span">Variáveis de ambiente</FieldLabel>
              <RefRows
                rows={form.env}
                onChange={(env) => set({ env })}
                secrets={secretNames}
                noun="variável"
                onNewSecret={onNewSecret}
              />
              {errors.env !== undefined && <FieldError>{errors.env}</FieldError>}
            </FormRow>
          </>
        ) : (
          <>
            <TextField
              label="Endereço (URL)"
              value={form.url}
              onChange={(url) => set({ url })}
              placeholder="https://servidor.exemplo.com/mcp"
              type="url"
              error={errors.url}
              name="connector-url"
            />
            <FormRow>
              <FieldLabel as="span">Cabeçalhos</FieldLabel>
              <RefRows
                rows={form.headers}
                onChange={(headers) => set({ headers })}
                secrets={secretNames}
                noun="cabeçalho"
                onNewSecret={onNewSecret}
                extra={
                  <Pill
                    tone="secondary"
                    disabled={secretNames.length === 0}
                    onClick={() =>
                      set({ headers: [...form.headers, bearerRow(secretNames[0] ?? "")] })
                    }
                  >
                    Authorization: Bearer (segredo)
                  </Pill>
                }
              />
              {errors.headers !== undefined && <FieldError>{errors.headers}</FieldError>}
            </FormRow>
          </>
        )}
        <FormRow>
          <FieldLabel htmlFor="connector-scope">Escopo</FieldLabel>
          <Dropdown
            id="connector-scope"
            variant="field"
            label="Escopo"
            value={form.scope}
            options={SCOPE_OPTIONS}
            onChange={(scope) => set({ scope })}
          />
        </FormRow>
        <TextField
          label="Tempo limite de cada chamada, em segundos (opcional)"
          value={form.timeoutSec}
          onChange={(timeoutSec) => set({ timeoutSec })}
          error={errors.timeout}
          hint="Em branco: o padrão do servidor (60 s)."
        />
        <FieldHint data-testid="connector-grant-hint">
          Nenhum bot recebe o conector ao criá-lo. Depois de “Testar”, você escolhe, bot a bot,
          quais ferramentas cada um pode usar.
        </FieldHint>
        {task.error !== undefined && (
          <FieldError data-testid="connector-error">{task.error}</FieldError>
        )}
      </FormStack>
    </Dialog>
  );
}

// ----------------------------------------------------------------- the section

/** The right end of an installed row: green "Conectado", the "Conectar" pill, or quiet words. */
function InstalledStatus({ plugin, onConnect }: { plugin: InstalledPlugin; onConnect(): void }) {
  const { status } = plugin;
  if (status.tone === "action") {
    return (
      <Pill
        tone="quiet"
        size="sm"
        aria-label={`${status.label} ${plugin.name}`}
        data-testid="installed-connect"
        onClick={onConnect}
      >
        {status.label}
      </Pill>
    );
  }
  return (
    <span
      className={cx(
        "flex-none text-small whitespace-nowrap",
        status.tone === "ok" ? "text-success-text" : "text-text-muted",
      )}
      data-testid="installed-state"
      data-tone={status.tone}
    >
      {status.label}
    </span>
  );
}

/**
 * The installed plugins, as in the reference the owner gave (24/11/2026): a two-column grid of rows
 * (the brand tile, the friendly name, one muted line, and where it stands on the right). Clicking one
 * opens ITS page, where everything about it is managed; at the end, "Mostrar todos" goes to the whole
 * gallery. A connector added by hand shows with the generic icon and its own name.
 */
function InstalledGrid({
  plugins,
  total,
}: {
  plugins: InstalledPlugin[];
  total: number | undefined;
}) {
  const openPlugin = useUi((s) => s.openPlugin);
  return (
    <>
      <ul
        className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0 narrow:grid-cols-1"
        data-testid="installed-list"
      >
        {plugins.map((p) => (
          <li
            key={`${p.kind}-${p.id}`}
            className="flex min-w-0 items-center gap-2 rounded-card pr-3 hover:bg-hover"
            data-testid="installed-item"
            data-plugin={p.id}
            data-kind={p.kind}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 rounded-card border-0 bg-transparent p-3 text-left text-text"
              onClick={() => openPlugin({ kind: p.kind, id: p.id, autoStart: false })}
            >
              <EntryIcon id={p.id} name={p.name} look={p.look} size="lg" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5 text-label font-label">
                  <span className="truncate">{p.name}</span>
                  {p.verified && (
                    <BadgeCheck
                      size={14}
                      className="flex-none text-text-muted"
                      aria-label="Da galeria do Suup"
                    />
                  )}
                </span>
                <span className="truncate text-small text-text-muted">{p.line}</span>
              </span>
            </button>
            <InstalledStatus
              plugin={p}
              onConnect={() => openPlugin({ kind: p.kind, id: p.id, autoStart: true })}
            />
          </li>
        ))}
      </ul>
      <ShowAll total={total} />
    </>
  );
}

/**
 * Configurações > Conectores is the "Instalado" list (owner, 24/11/2026): only what is installed,
 * each row opening the plugin's own page; nothing is switched or managed here. "Adicionar conector"
 * still makes a connector by hand.
 */
export function ConnectorsSettings({ title, titleId }: SectionProps) {
  const { sync } = useServices();
  const loaded = useData((s) => s.connectorsLoaded);
  const { items, search, loadError, connectorsByName } = usePlugins();
  const connectors = useMemo(
    () => orderedConnectors({ connectors: connectorsByName }),
    [connectorsByName],
  );
  const [adding, setAdding] = useState(false);
  const [newSecret, setNewSecret] = useState(false);

  useEffect(() => {
    void sync.loadConnectors();
    void sync.loadVault();
  }, [sync]);

  const plugins = useMemo(
    () => installedPlugins({ catalog: items ?? [], search, connectors }),
    [items, search, connectors],
  );
  const total = items === null ? undefined : items.length + searchPlugins(search).length;
  return (
    <>
      <PaneHead title={title} titleId={titleId}>
        <Pill tone="primary" size="sm" data-testid="connector-new" onClick={() => setAdding(true)}>
          Adicionar conector
        </Pill>
      </PaneHead>
      <PaneBody data-testid="connectors-card">
        {!loaded || (items === null && loadError === undefined) ? (
          <SettingsEmpty>Carregando…</SettingsEmpty>
        ) : plugins.length === 0 ? (
          <>
            <SettingsEmpty>
              Nenhum plugin instalado. Veja a galeria para conectar um serviço aos seus bots.
            </SettingsEmpty>
            <div className="flex justify-center">
              <ShowAll total={total} />
            </div>
          </>
        ) : (
          <section className="flex flex-col gap-2" aria-label="Instalado">
            <h3 className="px-2 text-small font-label text-text-muted">Instalado</h3>
            <InstalledGrid plugins={plugins} total={total} />
          </section>
        )}
      </PaneBody>
      {adding && (
        <AddConnectorDialog
          onClose={() => setAdding(false)}
          onNewSecret={() => setNewSecret(true)}
        />
      )}
      {newSecret && <SecretDialog existing={undefined} onClose={() => setNewSecret(false)} />}
    </>
  );
}

function ShowAll({ total }: { total: number | undefined }) {
  const openPlugin = useUi((s) => s.openPlugin);
  return (
    <Pill tone="quiet" size="sm" data-testid="installed-show-all" onClick={() => openPlugin(null)}>
      {total === undefined ? "Mostrar todos" : `Mostrar todos os ${total} plugins`}
    </Pill>
  );
}
