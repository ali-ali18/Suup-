import type { Bot } from "@suup/api";
import { KeyRound, ShieldCheck } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { pendingQuestions, questionMessageOf } from "../../app/selectors.js";
import { useUi } from "../../app/ui-store.js";
import { orderedEvents, orderedMessages, pendingApprovals } from "../../data/reducers.js";
import { openSecretRequest } from "../../data/secret-requests.js";
import { ActionList } from "../../ui/action-card.js";
import { Avatar } from "../../ui/avatar.js";
import { BotBubble } from "../../ui/message.js";
import { EmptyState, MutedText, Pill, SectionLabel } from "../../ui/primitives.js";
import { QuestionCard } from "../../ui/question-card.js";
import { Screen, ScreenBody, ScreenHead } from "../../ui/screen.js";
import { ApprovalRow, SecretRequestRow } from "../chat/ApprovalRows.js";

/** A block of the screen (the questions, the approvals, the secrets): a label, then its items. */
function PendingSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-3">
      <SectionLabel as="h2">{label}</SectionLabel>
      {children}
    </section>
  );
}

/** One thing that waits for you: whose it is, the card, and the way to the conversation. */
function PendingItem({
  bot,
  testId,
  onOpen,
  children,
}: {
  bot: Bot;
  testId: string;
  onOpen(): void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2" data-testid={testId}>
      <MutedText as="p" className="flex items-center gap-2">
        <Avatar
          avatar={bot.avatar}
          avatarStyle={bot.avatarStyle}
          color={bot.color}
          seed={bot.id}
          size="sm"
        />{" "}
        {bot.name}
      </MutedText>
      {children}
      <Pill tone="ghost" onClick={onOpen}>
        Abrir a conversa
      </Pill>
    </div>
  );
}

/**
 * What waits for you, across every bot: open questions, approval cards and secret requests. The
 * approval cards are the same ones the chat shows (a decision here is a decision there).
 */
export function PendingScreen() {
  const { sync } = useServices();
  const runs = useData((s) => s.runs);
  const bots = useData((s) => s.bots);
  const messages = useData((s) => s.messages);
  const events = useData((s) => s.events);
  const approvals = useData((s) => s.approvals);
  const selectBot = useUi((s) => s.selectBot);
  const waiting = useMemo(() => pendingQuestions({ runs, bots }), [runs, bots]);
  const cards = useMemo(() => pendingApprovals({ approvals, bots }), [approvals, bots]);
  const [clicked, setClicked] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (key: string) =>
      setClicked((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  // The cards are read again when the screen opens (the stream may have missed some while away).
  useEffect(() => {
    void sync.loadPendingApprovals();
  }, [sync]);

  // A run that waits for the user waits for a question (the bot's message) or a secret (an event of
  // the run): read both, to tell which it is.
  const key = waiting.map((r) => `${r.id}:${r.conversationId}`).join(",");
  useEffect(() => {
    for (const run of waiting) {
      if (run.conversationId !== null) void sync.loadNewestMessages(run.conversationId);
      void sync.loadRunEvents(run.id);
    }
  }, [key, sync]);

  const secrets = waiting.flatMap((run) => {
    const request = openSecretRequest(run, run.id, orderedEvents(events[run.id]));
    return request === undefined ? [] : [{ run, request }];
  });
  const secretRuns = new Set(secrets.map((s) => s.run.id));
  const pending = waiting.filter((run) => !secretRuns.has(run.id));

  return (
    <Screen data-testid="pending-screen">
      <ScreenHead title="Pendências" subtitle="O que está esperando por você, de todos os bots." />
      <ScreenBody limit="narrow">
        <PendingSection label="Perguntas">
          {pending.length === 0 ? (
            <EmptyState
              title="Nenhuma pergunta aberta"
              text="Quando um bot precisar de uma resposta sua, ela aparece aqui."
            />
          ) : (
            pending.map((run) => {
              const bot = bots[run.botId];
              const list =
                run.conversationId === null ? [] : orderedMessages(messages[run.conversationId]);
              const ask = questionMessageOf(list, run.id);
              if (bot === undefined) return null;
              return (
                <PendingItem
                  key={run.id}
                  bot={bot}
                  testId="pending-question"
                  onOpen={() => selectBot(bot.id)}
                >
                  {ask === undefined ? (
                    <MutedText as="p" size="inherit" role="status">
                      Carregando a pergunta…
                    </MutedText>
                  ) : ask.question?.questions.some((q) => q.options !== undefined) ? (
                    <QuestionCard
                      questions={ask.question.questions}
                      onSubmit={(text) =>
                        run.conversationId !== null && void sync.send(run.conversationId, text)
                      }
                    />
                  ) : (
                    <BotBubble data-testid="pending-text">
                      <p className="text-body wrap-anywhere whitespace-pre-wrap">{ask.text}</p>
                    </BotBubble>
                  )}
                </PendingItem>
              );
            })
          )}
        </PendingSection>
        <PendingSection label="Aprovações">
          {cards.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck size={16} />}
              title="Nenhuma aprovação"
              text="Quando um bot precisar da sua permissão para uma ação, o pedido aparece aqui, com o conteúdo exato que vai rodar."
            />
          ) : (
            cards.map((card, index) => {
              const bot = bots[card.botId];
              if (bot === undefined) return null;
              return (
                <PendingItem
                  key={card.id}
                  bot={bot}
                  testId="pending-approval"
                  onOpen={() => selectBot(bot.id)}
                >
                  <ActionList>
                    <ApprovalRow
                      approval={card}
                      clicked={clicked}
                      onToggle={toggle}
                      autoFocus={index === 0}
                    />
                  </ActionList>
                </PendingItem>
              );
            })
          )}
        </PendingSection>
        <PendingSection label="Segredos">
          {secrets.length === 0 ? (
            <EmptyState
              icon={<KeyRound size={16} />}
              title="Nenhum segredo pedido"
              text="Quando um bot precisar de uma credencial, o formulário seguro aparece aqui. O valor vai direto para o cofre."
            />
          ) : (
            secrets.map(({ run, request }) => {
              const bot = bots[run.botId];
              if (bot === undefined) return null;
              return (
                <PendingItem
                  key={request.callId}
                  bot={bot}
                  testId="pending-secret"
                  onOpen={() => selectBot(bot.id)}
                >
                  <ActionList>
                    <SecretRequestRow request={request} clicked={clicked} onToggle={toggle} />
                  </ActionList>
                </PendingItem>
              );
            })
          )}
        </PendingSection>
      </ScreenBody>
    </Screen>
  );
}
