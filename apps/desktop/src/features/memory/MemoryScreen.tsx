import type { MemoryLayer } from "@suup/api";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { useUi } from "../../app/ui-store.js";
import { fold } from "../../data/botlist.js";
import { Dropdown } from "../../ui/dropdown.js";
import { MemoryItem } from "../../ui/memory-item.js";
import {
  Dialog,
  EmptyState,
  FieldLabel,
  FormRow,
  FormStack,
  MutedText,
  Pill,
  Tabs,
  TextField,
  Toggle,
} from "../../ui/primitives.js";
import { Screen, ScreenBody, ScreenHead } from "../../ui/screen.js";
import {
  authorLabel,
  dateLabel,
  EDITABLE_LAYERS,
  LAYER_LABEL,
  LAYER_TAB,
  scopeLabel,
} from "./labels.js";

const LAYERS: MemoryLayer[] = ["rule", "profile", "note", "journal"];

/** The whole memory, in its four layers: filter by bot, search, add, edit, forget, restore. */
export function MemoryScreen() {
  const { api, sync } = useServices();
  const memories = useData((s) => s.memories);
  const loaded = useData((s) => s.memoriesLoaded);
  const bots = useData((s) => s.bots);
  const botFilter = useUi((s) => s.memoryBot);
  const setBotFilter = useUi((s) => s.setMemoryBot);
  const [layer, setLayer] = useState<MemoryLayer>("rule");
  const [query, setQuery] = useState("");
  const [showForgotten, setShowForgotten] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void sync.loadMemories();
    return () => sync.unwatchMemories();
  }, [sync]);

  const botList = useMemo(() => sortedBots(bots), [bots]);
  const items = useMemo(() => {
    const q = fold(query.trim());
    return Object.values(memories)
      .filter((m) => m.layer === layer)
      .filter((m) => showForgotten || m.archivedAt === null)
      .filter((m) =>
        botFilter === "all"
          ? true
          : botFilter === "shared"
            ? m.scope === "shared"
            : m.botId === botFilter,
      )
      .filter((m) => q === "" || fold(m.text).includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [memories, layer, showForgotten, botFilter, query]);

  const counts = useMemo(() => {
    const c: Record<MemoryLayer, number> = { rule: 0, profile: 0, note: 0, journal: 0 };
    for (const m of Object.values(memories)) if (m.archivedAt === null) c[m.layer] += 1;
    return c;
  }, [memories]);

  return (
    <Screen data-testid="memory-screen">
      <ScreenHead
        title="Memória"
        subtitle="Tudo o que o Suup sabe e usa. Uma memória nova ou esquecida vale a partir da próxima execução."
        action={
          <Pill
            tone="primary"
            icon={<Plus size={16} aria-hidden="true" />}
            onClick={() => setAdding(true)}
          >
            Adicionar
          </Pill>
        }
      />
      <ScreenBody>
        <Tabs
          label="Camadas da memória"
          idPrefix="memory"
          value={layer}
          onChange={(id) => setLayer(id as MemoryLayer)}
          tabs={LAYERS.map((l) => ({ id: l, label: `${LAYER_TAB[l]} (${counts[l]})` }))}
        />
        <div className="flex flex-wrap items-center gap-3">
          <div className="max-w-search min-w-50 flex-1">
            <TextField
              label="Buscar na memória"
              hideLabel
              type="search"
              value={query}
              onChange={setQuery}
              placeholder="Buscar na memória…"
            />
          </div>
          <div className="min-w-45">
            <Dropdown
              variant="field"
              label="Filtrar por bot"
              value={botFilter}
              options={[
                { value: "all", label: "Todos os bots" },
                { value: "shared", label: "Compartilhadas" },
                ...botList.map((b) => ({ value: b.id, label: b.name })),
              ]}
              onChange={setBotFilter}
            />
          </div>
          <span className="inline-flex items-center gap-2 text-small">
            <Toggle
              checked={showForgotten}
              onChange={setShowForgotten}
              label="Mostrar esquecidas"
            />
            Mostrar esquecidas
          </span>
        </div>
        {!loaded ? (
          <MutedText as="p" size="inherit" role="status">
            Carregando…
          </MutedText>
        ) : items.length === 0 ? (
          <EmptyState
            title="Nada por aqui"
            text={
              query === ""
                ? "Nenhuma memória nesta camada com esse filtro."
                : "Nenhuma memória encontrada para essa busca."
            }
          />
        ) : (
          <ul className="flex max-w-memory-list flex-col gap-2" data-testid="memory-list">
            {items.map((m) => (
              <MemoryItem
                key={m.id}
                text={m.text}
                layerLabel={LAYER_LABEL[m.layer]}
                scopeLabel={scopeLabel(m, bots)}
                authorLabel={authorLabel(m)}
                dateLabel={dateLabel(m.updatedAt)}
                archived={m.archivedAt !== null}
                editable={EDITABLE_LAYERS.includes(m.layer)}
                onEdit={(text) => void sync.memoryCall(() => api.memories.edit(m.id, text))}
                onForget={() => void sync.memoryCall(() => api.memories.archive(m.id))}
                onRestore={() => void sync.memoryCall(() => api.memories.restore(m.id))}
              />
            ))}
          </ul>
        )}
      </ScreenBody>
      {adding && (
        <AddMemoryDialog
          initialLayer={layer === "journal" ? "rule" : layer}
          onClose={() => setAdding(false)}
        />
      )}
    </Screen>
  );
}

function AddMemoryDialog({
  initialLayer,
  onClose,
}: {
  initialLayer: MemoryLayer;
  onClose(): void;
}) {
  const { api, sync } = useServices();
  const bots = useData((s) => s.bots);
  const memoryBot = useUi((s) => s.memoryBot);
  const selected = useUi((s) => s.selectedBotId);
  const list = sortedBots(bots);
  const [layer, setLayer] = useState<"rule" | "profile" | "note">(
    initialLayer === "journal" ? "rule" : (initialLayer as "rule" | "profile" | "note"),
  );
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string>(
    memoryBot !== "all" && memoryBot !== "shared"
      ? memoryBot
      : layer === "note"
        ? (selected ?? "")
        : "shared",
  );
  const [busy, setBusy] = useState(false);
  const needsBot = layer === "note";
  const botId = layer === "profile" ? undefined : target === "shared" ? undefined : target;
  const valid = text.trim() !== "" && (!needsBot || (botId !== undefined && botId !== ""));
  const save = async () => {
    setBusy(true);
    const ok = await sync.memoryCall(() =>
      api.memories.add({ layer, text: text.trim(), ...(botId === undefined ? {} : { botId }) }),
    );
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      title="Adicionar à memória"
      onClose={onClose}
      footer={
        <>
          <Pill tone="ghost" onClick={onClose}>
            Cancelar
          </Pill>
          <Pill tone="primary" disabled={!valid || busy} onClick={() => void save()}>
            Salvar
          </Pill>
        </>
      }
    >
      <FormStack>
        <FormRow>
          <FieldLabel as="span">Camada</FieldLabel>
          <Dropdown
            variant="field"
            label="Camada"
            value={layer}
            options={[
              { value: "rule", label: "Regra" },
              { value: "profile", label: "Perfil (vale para todos os bots)" },
              { value: "note", label: "Nota de um bot" },
            ]}
            onChange={(next) => {
              setLayer(next);
              if (next === "note" && target === "shared") setTarget(selected ?? list[0]?.id ?? "");
            }}
          />
        </FormRow>
        {layer !== "profile" && (
          <FormRow>
            <FieldLabel as="span">Vale para</FieldLabel>
            <Dropdown
              variant="field"
              label="Vale para"
              value={target}
              options={[
                ...(layer === "rule" ? [{ value: "shared", label: "Todos os bots" }] : []),
                ...list.map((b) => ({ value: b.id, label: b.name })),
              ]}
              onChange={setTarget}
            />
          </FormRow>
        )}
        <TextField
          label="Texto"
          value={text}
          onChange={setText}
          multiline
          rows={4}
          autoFocus
          placeholder={
            layer === "rule"
              ? "Ex.: Responda sempre em português."
              : layer === "profile"
                ? "Ex.: Moro em São Paulo."
                : "Ex.: O deploy fica em tools/deploy.sh"
          }
        />
      </FormStack>
    </Dialog>
  );
}
