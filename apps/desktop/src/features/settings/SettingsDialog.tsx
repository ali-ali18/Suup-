import { KeyRound, Plug, Settings, ShieldCheck } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { type SettingsTab, useUi } from "../../app/ui-store.js";
import { useModalFocus } from "../../ui/primitives.js";
import { ConnectorsSettings } from "./ConnectorsSettings.js";
import { GeneralSettings } from "./GeneralSettings.js";
import { PermissionsSettings } from "./PermissionsSettings.js";
import { VaultSettings } from "./VaultSettings.js";

const SECTIONS: readonly { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: "general", label: "Geral", icon: <Settings size={16} aria-hidden="true" /> },
  { id: "permissions", label: "Permissões", icon: <ShieldCheck size={16} aria-hidden="true" /> },
  { id: "vault", label: "Cofre", icon: <KeyRound size={16} aria-hidden="true" /> },
  { id: "connectors", label: "Conectores", icon: <Plug size={16} aria-hidden="true" /> },
];

/**
 * Settings: a modal dialog over whatever screen is open, with a narrow nav on the left and one
 * section on the right (docs/DESIGN.md §3c). Escape and the X close it and give the focus back.
 */
export function SettingsDialog() {
  const tab = useUi((s) => s.settingsTab);
  const setTab = useUi((s) => s.setSettingsTab);
  const close = useUi((s) => s.closeSettings);
  const connector = useUi((s) => s.settingsConnector);
  const setConnector = useUi((s) => s.setSettingsConnector);
  // Esc goes back one step: a connector's details return to the list; the second Esc closes.
  const { ref, onKeyDown } = useModalFocus(() =>
    tab === "connectors" && connector !== null ? setConnector(null) : close(),
  );
  const titleId = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const current = SECTIONS.find((s) => s.id === tab) ?? SECTIONS[0];
  // The ARIA tabs pattern, vertical: Up/Down move, Home/End jump.
  const move = (e: KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === "ArrowDown") next = (index + 1) % SECTIONS.length;
    else if (e.key === "ArrowUp") next = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = SECTIONS.length - 1;
    else return;
    e.preventDefault();
    const target = SECTIONS[next];
    if (target === undefined) return;
    setTab(target.id);
    refs.current[target.id]?.focus();
  };
  return createPortal(
    <div className="ui-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="sdialog"
        data-testid="settings-screen"
        onKeyDown={onKeyDown}
      >
        <div role="tablist" aria-orientation="vertical" aria-label="Seções" className="snav">
          {SECTIONS.map((section, i) => (
            <button
              key={section.id}
              ref={(el) => {
                refs.current[section.id] = el;
              }}
              type="button"
              role="tab"
              id={`settings-tab-${section.id}`}
              aria-selected={section.id === tab}
              aria-controls="settings-panel"
              tabIndex={section.id === tab ? 0 : -1}
              className="snav__item"
              onClick={() => setTab(section.id)}
              onKeyDown={(e) => move(e, i)}
            >
              {section.icon}
              {section.label}
            </button>
          ))}
        </div>
        <div
          className="spane"
          role="tabpanel"
          id="settings-panel"
          aria-labelledby={`settings-tab-${tab}`}
          data-testid={`settings-panel-${tab}`}
        >
          {tab === "general" && (
            <GeneralSettings title={current?.label} titleId={titleId} onClose={close} />
          )}
          {tab === "permissions" && (
            <PermissionsSettings title={current?.label} titleId={titleId} onClose={close} />
          )}
          {tab === "vault" && (
            <VaultSettings title={current?.label} titleId={titleId} onClose={close} />
          )}
          {tab === "connectors" && (
            <ConnectorsSettings title={current?.label} titleId={titleId} onClose={close} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
