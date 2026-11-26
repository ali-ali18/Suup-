import type { Task } from "@suup/api";
import { CornerUpLeft } from "lucide-react";
import { useMemo } from "react";
import { useData } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { APPROVAL_STATE_TEXT, costText } from "../../data/task-text.js";
import { whenText } from "../../lib/routines.js";

/** One labelled line of the task's data. */
function Row({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <span className="text-small text-text-muted">{label}</span>
      <div className="text-body wrap-anywhere">{children}</div>
    </div>
  );
}

/**
 * The right panel while a task's own view is open (KOD-68, docs/DESIGN.md "Tarefas", PREVIEW):
 * the task's data instead of the bot's settings. When it started, the chat it came from (a link
 * back), its approvals (from the approvals the app already has, of the task's run) and its cost
 * (the run's, as the server counted it). Nothing here is invented: a line without data is absent.
 */
export function TaskPanel({ task, botName }: { task: Task; botName: string }) {
  const run = useData((s) => s.runs[task.runId]);
  const approvalsById = useData((s) => s.approvals);
  const openTask = useUi((s) => s.openTask);
  const approvals = useMemo(
    () =>
      Object.values(approvalsById)
        .filter((a) => a.runId === task.runId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [approvalsById, task.runId],
  );
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="flex flex-col gap-5" data-testid="task-panel">
      <Row label="Começou" testId="task-panel-started">
        {whenText(run?.startedAt ?? task.createdAt, zone)}
      </Row>
      <Row label="Veio da conversa" testId="task-panel-chat">
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-inherit underline underline-offset-3"
          data-testid="task-panel-chat-link"
          onClick={() => openTask(null)}
        >
          <CornerUpLeft size={14} aria-hidden="true" className="flex-none" />
          Conversa com {botName}
        </button>
      </Row>
      <Row label="Aprovações" testId="task-panel-approvals">
        {approvals.length === 0 ? (
          <span className="text-text-muted">Nenhuma</span>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {approvals.map((a) => (
              <li
                key={a.id}
                className="flex flex-col"
                data-testid="task-panel-approval"
                data-status={a.status}
              >
                <span className="wrap-anywhere">{a.summary}</span>
                <span className="text-small text-text-muted">{APPROVAL_STATE_TEXT[a.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </Row>
      {run !== undefined && (
        <Row label="Custo" testId="task-panel-cost">
          {costText(run.costUsd)}
        </Row>
      )}
    </div>
  );
}
