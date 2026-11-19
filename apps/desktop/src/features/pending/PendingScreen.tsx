import { ShieldCheck } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useData, useServices } from "../../app/context.js";
import { pendingQuestions, questionMessageOf } from "../../app/selectors.js";
import { useUi } from "../../app/ui-store.js";
import { orderedMessages } from "../../data/reducers.js";
import { Avatar } from "../../ui/avatar.js";
import { EmptyState, Pill } from "../../ui/primitives.js";
import { QuestionCard } from "../../ui/question-card.js";

/** What waits for you, across every bot: open questions now; approvals come in phase 3. */
export function PendingScreen() {
  const { sync } = useServices();
  const runs = useData((s) => s.runs);
  const bots = useData((s) => s.bots);
  const messages = useData((s) => s.messages);
  const selectBot = useUi((s) => s.selectBot);
  const pending = useMemo(() => pendingQuestions({ runs, bots }), [runs, bots]);

  // The question is the bot's message: make sure we have each conversation's latest messages.
  const key = pending.map((r) => r.conversationId).join(",");
  useEffect(() => {
    for (const run of pending)
      if (run.conversationId !== null) void sync.loadNewestMessages(run.conversationId);
  }, [key, sync]);

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
                    <div
                      className="ui-bubble ui-bubble--bot pending__bubble"
                      data-testid="pending-text"
                    >
                      <p className="ui-bubble__text wrap">{ask.text}</p>
                    </div>
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
          <EmptyState
            icon={<ShieldCheck size={16} />}
            title="Nenhuma aprovação"
            text="Quando um bot precisar da sua permissão para uma ação, o pedido vai aparecer aqui. Esse recurso chega em uma fase futura."
          />
        </section>
      </div>
    </div>
  );
}
