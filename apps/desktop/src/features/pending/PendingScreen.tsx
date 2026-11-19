import { KeyRound, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { pendingQuestions, questionMessageOf } from "../../app/selectors.js";
import { useUi } from "../../app/ui-store.js";
import { orderedEvents, orderedMessages, pendingApprovals } from "../../data/reducers.js";
import { openSecretRequest } from "../../data/secret-requests.js";
import { ActionList } from "../../ui/action-card.js";
import { Avatar } from "../../ui/avatar.js";
import { BotBubble } from "../../ui/message.js";
import { EmptyState, Pill } from "../../ui/primitives.js";
import { QuestionCard } from "../../ui/question-card.js";
import { ApprovalRow, SecretRequestRow } from "../chat/ApprovalRows.js";

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
    <div className="screen" data-testid="pending-screen">
      <header className="screen__head">
        <div>
          <h1 className="screen__title">Pendências</h1>
          <p className="muted small">O que está esperando por você, de todos os bots.</p>
        </div>
      </header>
      <div className="screen__body screen__body--narrow">
        <section aria-label="Perguntas" className="pending__section">
          <h2 className="section-label">Perguntas</h2>
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
                <div key={run.id} className="pending__item" data-testid="pending-question">
                  <p className="pending__bot small muted">
                    <Avatar avatar={bot.avatar} color={bot.color} seed={bot.id} size="sm" />{" "}
                    {bot.name}
                  </p>
                  {ask === undefined ? (
                    <p className="muted" role="status">
                      Carregando a pergunta…
                    </p>
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
                  <Pill tone="ghost" onClick={() => selectBot(bot.id)}>
                    Abrir a conversa
                  </Pill>
                </div>
              );
            })
          )}
        </section>
        <section aria-label="Aprovações" className="pending__section">
          <h2 className="section-label">Aprovações</h2>
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
                <div key={card.id} className="pending__item" data-testid="pending-approval">
                  <p className="pending__bot small muted">
                    <Avatar avatar={bot.avatar} color={bot.color} seed={bot.id} size="sm" />{" "}
                    {bot.name}
                  </p>
                  <ActionList>
                    <ApprovalRow
                      approval={card}
                      clicked={clicked}
                      onToggle={toggle}
                      autoFocus={index === 0}
                    />
                  </ActionList>
                  <Pill tone="ghost" onClick={() => selectBot(bot.id)}>
                    Abrir a conversa
                  </Pill>
                </div>
              );
            })
          )}
        </section>
        <section aria-label="Segredos" className="pending__section">
          <h2 className="section-label">Segredos</h2>
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
                <div key={request.callId} className="pending__item" data-testid="pending-secret">
                  <p className="pending__bot small muted">
                    <Avatar avatar={bot.avatar} color={bot.color} seed={bot.id} size="sm" />{" "}
                    {bot.name}
                  </p>
                  <ActionList>
                    <SecretRequestRow request={request} clicked={clicked} onToggle={toggle} />
                  </ActionList>
                  <Pill tone="ghost" onClick={() => selectBot(bot.id)}>
                    Abrir a conversa
                  </Pill>
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}
