import type { Approval, ApprovalRule } from "@suup/api";
import { useCallback, useMemo } from "react";
import { useData, useServices } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { useUi } from "../../app/ui-store.js";
import { STATUS_LABEL } from "../../data/approval-text.js";
import type { SecretRequestItem } from "../../data/secret-requests.js";
import { answerSecretRequest } from "../../lib/secret-form.js";
import { ApprovalCard } from "../../ui/approval-card.js";
import { SecretRequestCard } from "../../ui/secret-request-card.js";

/**
 * Whether a decided card is open: its own choice (a click) flips what the setting says by default.
 * The set holds the keys that were clicked.
 */
export const resolvedOpen = (
  clicked: ReadonlySet<string>,
  key: string,
  setting: "collapsed" | "open",
): boolean => clicked.has(key) !== (setting === "open");

/** An approval card wired to the app: the bot's name, the settings, the decision through `Sync`. */
export function ApprovalRow({
  approval,
  clicked,
  onToggle,
  autoFocus,
}: {
  approval: Approval;
  clicked: ReadonlySet<string>;
  onToggle(key: string): void;
  autoFocus?: boolean;
}) {
  const { sync } = useServices();
  const bot = useData((s) => s.bots[approval.botId]);
  const connectorsByName = useData((s) => s.connectors);
  const connectors = useMemo(() => Object.values(connectorsByName), [connectorsByName]);
  const rule: ApprovalRule | undefined = useData((s) =>
    approval.ruleId === null ? undefined : s.rules[approval.ruleId],
  );
  const settings = useSettings((s) => s.settings);
  const toast = useUi((s) => s.toast);
  const key = `approval-${approval.id}`;
  const onDecide = useCallback(
    (body: Parameters<typeof sync.decideApproval>[1]) => sync.decideApproval(approval.id, body),
    [sync, approval.id],
  );
  return (
    <ApprovalCard
      approval={approval}
      botName={bot?.name ?? "O bot"}
      connectors={connectors}
      rule={rule}
      expanded={resolvedOpen(clicked, key, settings.approvalResolved)}
      onToggle={() => onToggle(key)}
      defaultScope={settings.alwaysScope}
      collapseLong={settings.approvalLong === "collapse"}
      {...(autoFocus === undefined ? {} : { autoFocus })}
      onDecide={onDecide}
      onDecidedElsewhere={(card) =>
        toast(
          card === undefined
            ? "Este pedido já tinha sido decidido em outro lugar."
            : `Este pedido já tinha sido decidido em outro lugar: ${(STATUS_LABEL[card.status] ?? card.status).toLowerCase()}.`,
        )
      }
    />
  );
}

/** The secure form of a secret request wired to the app: the value goes to the answer endpoint, nowhere else. */
export function SecretRequestRow({
  request,
  clicked,
  onToggle,
  autoFocus,
}: {
  request: SecretRequestItem;
  clicked: ReadonlySet<string>;
  onToggle(key: string): void;
  autoFocus?: boolean;
}) {
  const { api, sync } = useServices();
  const run = useData((s) => s.runs[request.runId]);
  const bot = useData((s) => (run === undefined ? undefined : s.bots[run.botId]));
  const resolved = useSettings((s) => s.settings.approvalResolved);
  const key = `secret-${request.callId}`;
  // The run goes on by itself; read it again so this screen does not wait for the next frame.
  const refresh = useCallback(() => {
    void sync.loadRun(request.runId);
    void sync.loadRunEvents(request.runId);
  }, [sync, request.runId]);
  return (
    <SecretRequestCard
      name={request.name}
      reason={request.reason}
      botName={bot?.name ?? "O bot"}
      state={request.state}
      expanded={resolvedOpen(clicked, key, resolved)}
      onToggle={() => onToggle(key)}
      {...(autoFocus === undefined ? {} : { autoFocus })}
      onSubmit={async (value) => {
        const outcome = await answerSecretRequest(api.vault, request.runId, { value });
        if (outcome.ok || outcome.conflict) refresh();
        return outcome;
      }}
      onDecline={async () => {
        const outcome = await answerSecretRequest(api.vault, request.runId, { declined: true });
        if (outcome.ok || outcome.conflict) refresh();
        return outcome;
      }}
    />
  );
}
