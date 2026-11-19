import { describe, expect, it } from "vitest";
import { useUi } from "./ui-store.js";

describe("leaving a server", () => {
  it("closes what the person had open: nothing of it belongs to the next server", () => {
    const ui = useUi.getState();
    ui.openSettings("permissions");
    ui.openNewBot();
    ui.setPalette(true);
    ui.selectBot("bot-1");
    ui.leaveServer();
    const after = useUi.getState();
    expect(after.settingsOpen).toBe(false);
    expect(after.newBotOpen).toBe(false);
    expect(after.paletteOpen).toBe(false);
    expect(after.selectedBotId).toBeNull();
    expect(after.view).toBe("chat");
  });
});
