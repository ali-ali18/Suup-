import type { MessageAttachment } from "@suup/api";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FILE_ICON, FILE_KIND_LABEL, FileCard, fileSizeText } from "./file-card.js";

const pdf: MessageAttachment = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "historia_pucpr.pdf",
  mime: "application/pdf",
  size: 3006,
  kind: "pdf",
};

describe("FileCard: a file the bot handed over", () => {
  it("one row: the name, what it is in plain words and the size; never the MIME type", () => {
    render(<FileCard file={pdf} canOpen busy={null} onOpen={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByTestId("file-name").textContent).toBe("historia_pucpr.pdf");
    expect(screen.getByTestId("file-meta").textContent).toBe("PDF · 3 KB");
    expect(screen.getByTestId("file-card").textContent).not.toContain("application/pdf");
    expect(screen.getByRole("group", { name: "Arquivo: historia_pucpr.pdf" })).toBeTruthy();
  });

  it("the app: Salvar (text) and Abrir (the pill); the browser: only Baixar", () => {
    const onOpen = vi.fn();
    const onSave = vi.fn();
    const { unmount } = render(
      <FileCard file={pdf} canOpen busy={null} onOpen={onOpen} onSave={onSave} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Baixar" })).toBeNull();
    unmount();
    render(<FileCard file={pdf} canOpen={false} busy={null} onOpen={onOpen} onSave={onSave} />);
    expect(screen.queryByRole("button", { name: "Abrir" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Baixar" }));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("while one works, both are off and the one working says so", () => {
    const onOpen = vi.fn();
    render(<FileCard file={pdf} canOpen busy="open" onOpen={onOpen} onSave={vi.fn()} />);
    const open = screen.getByRole("button", { name: "Abrir" }) as HTMLButtonElement;
    // the one working is off but keeps the focus (Base UI `focusableWhenDisabled`): aria-disabled, not `disabled`
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(open.hasAttribute("data-disabled")).toBe(true);
    expect(open.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(open);
    expect(onOpen).not.toHaveBeenCalled();
    // the other one is plainly disabled
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("every kind has its icon and its words (exact tables)", () => {
    for (const kind of Object.keys(FILE_KIND_LABEL)) {
      expect(FILE_ICON[kind as MessageAttachment["kind"]], kind).toBeDefined();
    }
    expect(Object.keys(FILE_ICON).sort()).toEqual(Object.keys(FILE_KIND_LABEL).sort());
  });

  it("sizes in pt-BR", () => {
    expect(fileSizeText(800)).toBe("800 bytes");
    expect(fileSizeText(3006)).toBe("3 KB");
    expect(fileSizeText(1.25 * 1024 * 1024)).toBe("1,3 MB");
  });
});
