import { FileText, Image as ImageIcon, LayoutPanelTop } from "lucide-react";
import { useState } from "react";
import { EmptyState, Pill } from "./primitives.js";

export type LibraryKind = "page" | "media" | "file";
export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  title: string;
  subtitle?: string;
  /** ISO 8601. */
  createdAt: string;
}

export const LIBRARY_FILTERS = [
  { id: "all", label: "Todos" },
  { id: "page", label: "Páginas" },
  { id: "media", label: "Mídia" },
  { id: "file", label: "Arquivos" },
] as const;

export type LibraryGroupId = "today" | "week" | "older";
export const LIBRARY_GROUP_LABEL: Record<LibraryGroupId, string> = {
  today: "Hoje",
  week: "Esta semana",
  older: "Mais antigos",
};

/** Items grouped by how recent they are, newest first inside each group. */
export function groupByRecency(
  items: readonly LibraryItem[],
  now: Date,
): { id: LibraryGroupId; items: LibraryItem[] }[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = startOfToday - 6 * 86_400_000;
  const groups: Record<LibraryGroupId, LibraryItem[]> = { today: [], week: [], older: [] };
  for (const item of [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const t = new Date(item.createdAt).getTime();
    groups[t >= startOfToday ? "today" : t >= weekAgo ? "week" : "older"].push(item);
  }
  return (["today", "week", "older"] as const)
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, items: groups[id] }));
}

const ICON = { page: LayoutPanelTop, media: ImageIcon, file: FileText } as const;
const PAGE_SIZE = 5;

/**
 * The bot's library: filter chips and items grouped by time, "Mostrar mais" per group. It is ready
 * for data; today nothing produces any (phase 7), so it shows its honest empty state.
 */
export function LibraryList({
  items,
  now = new Date(),
}: {
  items: readonly LibraryItem[];
  now?: Date;
}) {
  const [filter, setFilter] = useState<(typeof LIBRARY_FILTERS)[number]["id"]>("all");
  const [shown, setShown] = useState<Record<string, number>>({});
  const visible = items.filter((i) => filter === "all" || i.kind === filter);
  const groups = groupByRecency(visible, now);
  return (
    <div className="ui-library">
      <div className="ui-library__filters" role="group" aria-label="Filtrar biblioteca">
        {LIBRARY_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`ui-tab${filter === f.id ? " ui-tab--active" : ""}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {groups.length === 0 ? (
        <EmptyState
          icon={<FileText size={16} />}
          title="Nada na biblioteca ainda"
          text="Os arquivos e as páginas que o bot criar vão aparecer aqui."
        />
      ) : (
        groups.map((group) => {
          const limit = shown[group.id] ?? PAGE_SIZE;
          return (
            <section
              key={group.id}
              className="ui-library__group"
              aria-label={LIBRARY_GROUP_LABEL[group.id]}
            >
              <p className="section-label">{LIBRARY_GROUP_LABEL[group.id]}</p>
              <ul className="ui-library__items">
                {group.items.slice(0, limit).map((item) => {
                  const Icon = ICON[item.kind];
                  return (
                    <li key={item.id} className="ui-library__item">
                      <span className="ui-icon-circle" aria-hidden="true">
                        <Icon size={16} />
                      </span>
                      <span className="ui-library__text">
                        <span className="ui-library__title">{item.title}</span>
                        {item.subtitle !== undefined && (
                          <span className="small muted">{item.subtitle}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {group.items.length > limit && (
                <Pill
                  tone="ghost"
                  onClick={() => setShown({ ...shown, [group.id]: limit + PAGE_SIZE })}
                >
                  Mostrar mais
                </Pill>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
