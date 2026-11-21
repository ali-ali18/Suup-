import type { DecideTeamBody, TeamProposal } from "@suup/api";
import { LoaderCircle, Users } from "lucide-react";
import { useState } from "react";
import { avatarOf, effectiveColor, mascotValue } from "../lib/mascots.js";
import { ActionCard } from "./action-card.js";
import { Avatar } from "./avatar.js";
import { CheckInput } from "./choice.js";
import { DecisionCard } from "./decision-card.js";
import { Pill } from "./primitives.js";

export interface TeamCardProps {
  /** The message that carries the card: the seed of the mascots, so they never change. */
  seed: string;
  team: TeamProposal;
  botName: string;
  /** The line of a decided card opens to show who was created. */
  expanded: boolean;
  onToggle(): void;
  /** The server's answer to the decision; the card changes only when the message does. */
  onDecide(body: DecideTeamBody): Promise<{ ok: true } | { ok: false; message: string }>;
}

/** The mascot and colour a proposal shows, and a bot made from it is born with. */
function lookOf(seed: string, index: number) {
  const key = `${seed}:${index}`;
  const spec = avatarOf(null, key);
  return {
    key,
    avatar: spec.id === undefined ? null : mascotValue(spec.id),
    color: effectiveColor(null, key),
  };
}

/**
 * The main bot's team proposal (docs/DESIGN.md §3, "Proposta de equipe"): ONE decision card, the
 * same chrome as every card of the chat. Title and a light line, then one row per proposed bot (its
 * mascot, its name, one line of what it does, a tick), and the footer: "Agora não" as plain text and
 * "Criar selecionados" as the pill, off while nothing is ticked. Nothing is created without a tick,
 * and nothing is optimistic: the card becomes one line only when the server answers.
 */
export function TeamCard({ seed, team, botName, expanded, onToggle, onDecide }: TeamCardProps) {
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<"create" | "dismiss" | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  if (team.status !== "pending") {
    const made = team.created.map((c) => team.items[c.index]?.name).filter((n) => n !== undefined);
    return (
      <ActionCard
        testId="team-card"
        icon={<Users size={14} />}
        kind="Equipe"
        state={team.status === "created" ? "done" : "stopped"}
        stateLabel=""
        summary={
          team.status === "created"
            ? `${made.length === 1 ? "Criou 1 bot" : `Criou ${made.length} bots`}: ${made.join(", ")}`
            : "Agora não"
        }
        expanded={expanded}
        onToggle={onToggle}
      />
    );
  }

  const toggle = (index: number) =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const decide = async (kind: "create" | "dismiss") => {
    setBusy(kind);
    setError(undefined);
    const body: DecideTeamBody =
      kind === "dismiss"
        ? { dismiss: true }
        : {
            create: [...ticked]
              .sort((a, b) => a - b)
              .map((index) => {
                const look = lookOf(seed, index);
                return {
                  index,
                  ...(look.avatar === null ? {} : { avatar: look.avatar }),
                  color: look.color,
                };
              }),
          };
    const outcome = await onDecide(body);
    // Decided, the message changes and the card with it; a failure leaves the card as it was.
    if (!outcome.ok) setError(outcome.message);
    setBusy(null);
  };
  const waiting = busy !== null;
  return (
    <DecisionCard
      testId="team-card"
      groupLabel={`Proposta de equipe de ${botName}`}
      busy={waiting}
      icon={<Users size={14} />}
      category="Equipe"
      title="Montei uma equipe para você"
      lede="Marque os bots que quiser criar. Nada é criado sem a sua escolha."
      footerNote={error}
      footer={
        <>
          <Pill
            tone="quiet"
            className="min-w-24"
            disabled={waiting}
            data-testid="team-dismiss"
            onClick={() => void decide("dismiss")}
          >
            {busy === "dismiss" ? (
              <>
                <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                Dispensando…
              </>
            ) : (
              "Agora não"
            )}
          </Pill>
          <Pill
            tone="primary"
            className="min-w-36"
            disabled={waiting || ticked.size === 0}
            data-testid="team-create"
            onClick={() => void decide("create")}
          >
            {busy === "create" ? (
              <>
                <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                Criando…
              </>
            ) : (
              "Criar selecionados"
            )}
          </Pill>
        </>
      }
    >
      <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
        {team.items.map((item, index) => {
          const look = lookOf(seed, index);
          return (
            <li key={look.key}>
              <label className="flex cursor-pointer items-center gap-3 py-3" data-testid="team-row">
                <Avatar avatar={look.avatar} color={look.color} seed={look.key} size="md" still />
                <span className="flex min-w-0 flex-1 flex-col">
                  <strong className="text-body font-title wrap-anywhere">{item.name}</strong>
                  <span className="text-small wrap-anywhere text-text-muted">
                    {item.description}
                  </span>
                </span>
                <CheckInput
                  type="checkbox"
                  checked={ticked.has(index)}
                  disabled={waiting}
                  aria-label={`Criar ${item.name}`}
                  onChange={() => toggle(index)}
                />
              </label>
            </li>
          );
        })}
      </ul>
    </DecisionCard>
  );
}
