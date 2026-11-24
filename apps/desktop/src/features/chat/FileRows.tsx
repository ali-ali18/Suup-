import type { MessageAttachment } from "@suup/api";
import { useState } from "react";
import { useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { ActionList } from "../../ui/action-card.js";
import { type FileBusy, FileCard } from "../../ui/file-card.js";

/** What a failed open or save says: one friendly sentence (the detail goes to the console). */
export const FILE_FAILED = "Não deu para pegar o arquivo agora. Tenta de novo?";

/**
 * The files the bot handed over with a message, under it: one card each, wired to this device
 * (`platform.files`: the app saves with the system's window and opens with the system's program; the
 * browser downloads). Nothing is optimistic: the button spins until the device answers.
 */
export function FileRows({ files }: { files: readonly MessageAttachment[] }) {
  return (
    <ActionList data-testid="files">
      {files.map((file) => (
        <FileRow key={file.id} file={file} />
      ))}
    </ActionList>
  );
}

function FileRow({ file }: { file: MessageAttachment }) {
  const { api, platform, connection } = useServices();
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState<FileBusy>(null);
  const delivered = { url: api.files.url(file.id), token: connection.token, name: file.name };
  const run = async (which: "open" | "save") => {
    setBusy(which);
    try {
      if (which === "open") await platform.files.open?.(delivered);
      else await platform.files.save(delivered);
    } catch (error) {
      console.warn("[suup]", error);
      toast(FILE_FAILED, "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <FileCard
      file={file}
      canOpen={platform.files.open !== undefined}
      busy={busy}
      onOpen={() => void run("open")}
      onSave={() => void run("save")}
    />
  );
}
