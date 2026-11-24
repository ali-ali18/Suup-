import type { MessageAttachment } from "@suup/api";
import {
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  LoaderCircle,
  type LucideIcon,
  Presentation,
} from "lucide-react";
import { CARD_CHROME } from "./decision-card.js";
import { IconBox } from "./icon-box.js";
import { Pill } from "./primitives.js";

type Kind = MessageAttachment["kind"];

/** The icon of a file, by the kind the server declared (exact table; docs/DESIGN.md §3, "Arquivo"). */
export const FILE_ICON: Record<Kind, LucideIcon> = {
  pdf: FileText,
  image: FileImage,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  text: FileText,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  other: File,
};

/** What the file is, in plain words (never the MIME type: docs/DESIGN.md §1, "Amigável"). */
export const FILE_KIND_LABEL: Record<Kind, string> = {
  pdf: "PDF",
  image: "Imagem",
  document: "Documento",
  spreadsheet: "Planilha",
  presentation: "Apresentação",
  text: "Texto",
  archive: "Arquivo compactado",
  audio: "Áudio",
  video: "Vídeo",
  other: "Arquivo",
};

/** "800 bytes", "3 KB", "1,2 MB": the size in pt-BR. */
export function fileSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

export type FileBusy = "open" | "save" | null;

/**
 * A file the bot handed over, under its message (docs/DESIGN.md §3, "Arquivo entregue"): the
 * chrome of every chat card, one row: the icon of its kind in the small square, the name in bold,
 * what it is and its size muted, and at the right "Salvar" as plain text and "Abrir" as the pill
 * (the app), or only "Baixar" (the browser, which cannot hand a file to another program). While a
 * button works it is off with the small spinner, the width unchanged.
 */
export function FileCard({
  file,
  canOpen,
  busy,
  onOpen,
  onSave,
}: {
  file: MessageAttachment;
  /** This device can open the file with the system's own program (the app; not the browser). */
  canOpen: boolean;
  busy: FileBusy;
  onOpen(): void;
  onSave(): void;
}) {
  const Icon = FILE_ICON[file.kind] ?? File;
  const spinner = <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />;
  return (
    <div
      className={CARD_CHROME}
      data-testid="file-card"
      data-kind={file.kind}
      role="group"
      aria-label={`Arquivo: ${file.name}`}
    >
      <div className="flex w-full min-w-0 items-center gap-3 px-4 py-3">
        <IconBox>
          <Icon size={14} />
        </IconBox>
        <span className="flex min-w-0 flex-1 flex-col">
          <strong className="truncate text-label font-title" data-testid="file-name">
            {file.name}
          </strong>
          <span className="truncate text-small text-text-muted" data-testid="file-meta">
            {FILE_KIND_LABEL[file.kind] ?? "Arquivo"} · {fileSizeText(file.size)}
          </span>
        </span>
        <span className="inline-flex flex-none items-center gap-2">
          {canOpen ? (
            <>
              <Pill
                tone="quiet"
                size="sm"
                disabled={busy !== null}
                aria-busy={busy === "save"}
                onClick={onSave}
                icon={busy === "save" ? spinner : undefined}
              >
                Salvar
              </Pill>
              <Pill
                tone="primary"
                size="sm"
                disabled={busy !== null}
                aria-busy={busy === "open"}
                onClick={onOpen}
                icon={busy === "open" ? spinner : undefined}
              >
                Abrir
              </Pill>
            </>
          ) : (
            <Pill
              tone="primary"
              size="sm"
              disabled={busy !== null}
              aria-busy={busy === "save"}
              onClick={onSave}
              icon={busy === "save" ? spinner : undefined}
            >
              Baixar
            </Pill>
          )}
        </span>
      </div>
    </div>
  );
}
