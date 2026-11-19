# Pesquisa: o bot acordar sozinho depois de um prazo, na mesma conversa

Data da pesquisa: 19/11/2026. Apoia a fase 4 (ver [pesquisas/README.md](README.md) e [PLANO.md](../PLANO.md), seções 4.9 e 4.14). Pesquisa sem código.

## Pergunta

Numa conversa, o bot começa algo lento (um CI, um deploy de ~20 minutos) e diz "volto a checar em 20 minutos". Depois ele acorda **sozinho**, na mesma conversa, lembrando o que estava fazendo, sem que o usuário crie uma rotina e sem que isso apareça no painel de rotinas. Como harnesses de agentes existentes implementam esse "retorno agendado" e quais limites e salvaguardas usam?

## Fontes

Todas lidas em 19/11/2026, salvo quando indicado.

Claude Code (Anthropic):

- Claude Code, "Run prompts on a schedule" (versão Markdown da página, `/docs/en/scheduled-tasks.md`): https://code.claude.com/docs/en/scheduled-tasks
- Claude Code, "Tools reference" (`/docs/en/tools-reference.md`; linhas de `ScheduleWakeup`, `Monitor` e limite de comandos em segundo plano): https://code.claude.com/docs/en/tools-reference
- Claude Code, "Hooks reference" (`/docs/en/hooks.md`; campos `session_crons` e `background_tasks` do evento Stop): https://code.claude.com/docs/en/hooks
- Claude Code, "Prompt caching" (`/docs/en/prompt-caching.md`; TTL de 5 minutos e 1 hora): https://code.claude.com/docs/en/prompt-caching
- Claude Code, "Errors" (`/docs/en/errors.md`; aviso de wakeup perdido após reinício): https://code.claude.com/docs/en/errors
- Claude Code, "Agent view" (`/docs/en/agent-view.md`; `/loop` em sessão de fundo): https://code.claude.com/docs/en/agent-view
- Claude Code, "Cloud scheduled tasks" (`/docs/en/routines.md`): https://code.claude.com/docs/en/routines (lida só para a tabela de intervalo mínimo, que está na página de agendamento)
- Documentação de Agent SDK, "Hosting" e "Agent loop" (`/docs/en/agent-sdk/hosting.md`, `/docs/en/agent-sdk/agent-loop.md`): lidas; nenhum termo de agendamento ou retorno temporal encontrado.

OpenAI:

- OpenAI, "Background mode" (Responses API): https://developers.openai.com/api/docs/guides/background (lida via curl; a mesma página responde em `platform.openai.com/docs/guides/background`, com o mesmo tamanho)

OpenClaw (lido no repositório, não no site `docs.openclaw.ai`, que está bloqueado):

- `docs/automation/cron-jobs.md`, `docs/automation/cron-jobs/how-it-works.md`, `.../schedules.md`, `.../payloads.md`, `.../managing-jobs.md`, `.../troubleshooting.md`: https://raw.githubusercontent.com/openclaw/openclaw/main/docs/automation/cron-jobs/how-it-works.md (e os demais arquivos da mesma pasta)

Hermes Agent (NousResearch):

- `README.md`: https://raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md
- `tools/cronjob_tools.py` (schema da ferramenta `cronjob`): https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/cronjob_tools.py
- `cron/jobs.py`: https://raw.githubusercontent.com/NousResearch/hermes-agent/main/cron/jobs.py
- `cron/scheduler.py`: https://raw.githubusercontent.com/NousResearch/hermes-agent/main/cron/scheduler.py (lido só nas constantes de tique)
- `website/docs/user-guide/features/cron.md`: https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/features/cron.md (o site da documentação, `hermes-agent.nousresearch.com`, está bloqueado)

Outros projetos (só README ou arquivo indicado):

- OpenMausBot, `README.md`: https://raw.githubusercontent.com/milind-soni/OpenMausBot/main/README.md
- DuskBot, `README.md`: https://raw.githubusercontent.com/DuskBotAI/duskbot/main/README.md
- LangGraph, `libs/sdk-py/langgraph_sdk/_async/cron.py` e `libs/langgraph/langgraph/types.py`: https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/langgraph/langgraph/types.py
- Agent Zero, `README.md`: https://raw.githubusercontent.com/agent0ai/agent-zero/main/README.md
- nightly-labs/openbot, `README.md`: https://raw.githubusercontent.com/nightly-labs/openbot/main/README.md (sem trecho de agendamento)

Não lidos ou não acessíveis: GitHub API e `gh` (o acesso aos repositórios não está habilitado nesta sessão, HTTP 403; `raw.githubusercontent.com` funcionou); `hermes-agent.nousresearch.com`, `docs.openclaw.ai`, `docs.letta.com`, `langchain-ai.github.io` (bloqueados, CONNECT 403 ou rejeição do proxy). Repositórios Letta, Eliza e o `nightly-labs/openbot` não foram estudados além do README.

Suup (contexto, arquivos do próprio repositório, lidos em 19/11/2026):

- `docs/PLANO.md`, seção 4.9 (Rotinas), 4.14 (Iniciativa) e tabela de fases.
- `docs/MEMORIA.md`, "O que entra em toda execução" (contexto lido uma vez por execução).
- `packages/db/src/run-control.ts` (pausar, retomar e cancelar execução; comentários nas linhas de `pauseRun`).
- `packages/core/src/loop/resume.ts` (`startOrResume` e `resumeFromWaiting`).
- `packages/db/src/runs.ts` (`claimNextRun`, linhas 150–155, com `FOR UPDATE SKIP LOCKED`).
- `packages/db/src/conversation-runs.ts` (`ACTIVE_RUN_STATUSES`, linhas 10–16).
- `packages/core/src/events.ts` (`runStatusSchema`, linhas 184–192).

## Fatos verificados

### 1. Claude Code

- **Mecanismo.** Há duas formas de acordar sozinho. Uma é `/loop` no modo "self-paced", em que o próprio modelo escolhe o intervalo: "After each iteration it picks a delay between one minute and one hour based on what it observed" (scheduled-tasks). A outra são tarefas de uma vez, criadas em linguagem natural: "Claude schedules a single-fire task that deletes itself after running" (scheduled-tasks, "Set a one-time reminder").
- **Ferramenta.** `ScheduleWakeup`: "Reschedules the next iteration of a self-paced /loop. Claude calls this at the end of each iteration to pick when the next one runs, between one minute and one hour out; you don't call it directly." Para encerrar: "Claude calls it with `stop: true`, which cancels the pending wakeup." (tools-reference, linha 49)
- **Padrão de segurança quando o modelo esquece de reagendar.** "If an iteration ends without either rescheduling or stopping, Claude Code schedules one fallback wakeup about 20 minutes later and ends the loop when that iteration doesn't reschedule either." (scheduled-tasks, "Stop a loop")
- **O que é entregue ao acordar.** Um wakeup é um prompt enviado à mesma sessão. O campo `session_crons` do evento Stop descreve cada wakeup, com `prompt` ("Prompt submitted when the cron fires, capped at 1000 characters"), e a origem é "sourced from `CronCreate`, `ScheduleWakeup`, and `/loop`" (hooks.md, Stop input). Não está documentado o formato exato do argumento de `ScheduleWakeup`, só o efeito.
- **Quando dispara.** "The scheduler checks every second for due tasks and enqueues them at low priority. A scheduled prompt fires between your turns, not while Claude is mid-response. If Claude is busy when a task comes due, the prompt waits until the current turn ends." (scheduled-tasks, "How session-scoped scheduled tasks run")
- **Limites.** Intervalo do `ScheduleWakeup`: um minuto a uma hora. Tarefas de sessão: "A session can hold up to 50 scheduled tasks at once." Tarefas recorrentes expiram: "Recurring tasks automatically expire 7 days after creation." Sem recuperação de disparos perdidos: "No catch-up for missed fires." (scheduled-tasks)
- **Dependência de processo.** "Tasks only fire while Claude Code is running and idle. Closing the terminal or letting the session exit stops them firing." E ao retomar: "A self-paced `/loop` isn't restored, so run `/loop` again to restart it." (scheduled-tasks, Limitations)
- **Reinício.** Se o processo morre com um wakeup pendente em sessão de fundo, o aviso é: "This session restarted 12m after its next /loop wakeup was due, so that wakeup will not fire. The loop stays stopped until Claude schedules it again: reply to continue it." O wakeup perdido não dispara atrasado. (errors.md, "This session restarted after its next /loop wakeup was due")
- **Visibilidade.** O wakeup aparece na lista de tarefas agendadas: "A dynamically scheduled loop appears in your scheduled task list like any other task, so you can list or cancel it the same way." Para o usuário parar: "press `Esc` on an empty prompt to stop it" (loop de intervalo fixo não para com Esc). (scheduled-tasks)
- **Status.** Em `claude agents`, um wakeup pendente conta como trabalho em andamento: "so does a pending session-scoped scheduled task, such as a `/loop` wakeup." (agent-view)
- **Cache.** "The cache stays warm for one cache TTL after Claude Code last sent a request in this conversation or Claude last responded." (prompt-caching). Na tabela de TTL, a conversa principal tem "One hour" com assinatura dentro do plano e "Five minutes" com chave de API ou créditos de uso (prompt-caching, "Which TTL each request gets"). Com TTL de 5 minutos, um wakeup de 20 minutos chega com o cache frio.
- **Parada de hook.** O evento Stop distingue "session is done" de "session is paused waiting for background work to wake it back up", e há um teto: "after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block and ends the turn." (hooks.md). É teto para hooks que continuam o turno, não para wakeups.
- **Monitor (alternativa sem agendamento).** "Every watch Claude starts has a deadline: 5 minutes by default, at most 30 minutes, and at most 10 minutes in a non-interactive run given a single prompt with `-p`." (tools-reference, "Monitor tool"). O Monitor observa um comando e devolve cada linha de saída; não é um timer.
- **Comando em segundo plano (alternativa).** `run_in_background`: "In a session that runs unattended, such as a run with the `-p` flag, an Agent SDK application, a CI job, or a cloud session, background Bash and PowerShell commands have a time limit." Sessão local "has no time limit on background commands" (tools-reference, "Background commands").
- **Agendamento em nuvem (fora do alvo).** Rotinas na nuvem e tarefas de desktop são duráveis e aparecem como tarefas agendadas. Intervalo mínimo nas rotinas na nuvem: "1 hour" (scheduled-tasks, tabela "Compare scheduling options"). O alvo do Suup é o oposto: fica fora dessa lista.

### 2. OpenAI (Responses API, background mode)

- Background mode é uma requisição assíncrona, não um timer do modelo: "Use background mode to run long-running Responses API requests asynchronously, including multi-step agent runs." E: "An agent run is the full workflow your application manages: it sends an initial request and can use the result to decide what to do next, such as running a tool and sending its output in a follow-up request." (guia de background)
- Quem acorda é a aplicação: a resposta chega por webhook ou por consulta: "As an alternative to webhooks, use the response ID to check the request's status with the retrieve endpoint. Keep polling while the status is `queued` or `in_progress`." (guia de background)
- Janelas de conclusão: `soonest` (padrão), `2h` e `8h`; "Background mode temporarily stores response data even when you set `store` to `false` or use Zero Data Retention." (guia de background)
- Cancelamento: `POST /v1/responses/{id}/cancel`; "Canceling twice is idempotent." (guia de background)
- Continuação: quando a resposta anterior expira, a aplicação precisa guardar a entrada original e o contexto completo para continuar em nova requisição (guia de background, seção de continuação).

### 3. Anthropic API e Agent SDK

- Nas páginas lidas do Agent SDK (hosting e loop do agente) não há termo de agendamento, retorno temporal ou sono. O Agent SDK não documenta um timer próprio nessas páginas (ver "O que não foi verificado").

### 4. OpenClaw (`openclaw/openclaw`, arquivos em `docs/automation/`)

É o caso mais próximo do pedido. Há um padrão explícito para "voltar a esta conversa depois":

- Texto de `payloads.md`, perto da linha 537: "To come back to this conversation later (for example, to recheck CI), add a one-shot `at` job with `payload: { kind: "agentTurn", message: "Instructions for your next turn" }` and `sessionTarget: "session:<your session key from Runtime>"`. It runs inside the existing conversation with the same history and saved workspace/worktree."
- Ao rearmar, a ferramenta `automations` com `action: "next_check"` e `in: "3m"` "rearm that same job. It does not create a new job or change its task, target, or permissions." (payloads.md, perto da linha 168)
- Ferramenta com escopo: "Scripts get only self-scoped `automations` actions (status, list, get, remove, runs, and next_check), with no add, update, run, or wake. To resume a conversation later, schedule an `agentTurn` instead." (payloads.md, perto da linha 442)
- Espera pela conversa: "A scheduled job targeting `session:<key>` waits for that conversation to be idle before it starts, regardless of how the job was created." (how-it-works.md, linhas 19–21)
- Armazenamento: "Job definitions, runtime state, and run history persist in OpenClaw's shared SQLite state database, so restarts do not lose schedules." (how-it-works.md, linha 17)
- Limite por execução: "isolated/detached agent-turn jobs are bounded by the scheduler's own 60-minute watchdog" (how-it-works.md, linha 26).
- Concorrência: "Up to eight jobs run at once." Pode chegar a 16 com memória livre de pelo menos 1 GiB (how-it-works.md, linha 29).
- Reinício: "A restart before adoption records one interrupted failure; it does not report success or replay the reminder." (how-it-works.md, linha 22). E: "Without a recorded terminal result, an active run becomes interrupted with delivery **Unknown**." (linha 59)
- Intervalo dinâmico (pacing): "Recurring jobs can set `pacing.min` and/or `pacing.max`". A proposta do agente "applies only to that currently running job and is measured from successful run completion. OpenClaw silently clamps it to the configured bounds." (schedules.md, "Dynamic cadence (pacing)", perto da linha 236)
- `/loop` no chat: "creates a recurring agent-turn job bound to that conversation ... or omit it to let the loop self-pace between 1 minute and 1 hour with `next_check`." (schedules.md, perto da linha 242)
- Visibilidade: "New jobs retain the original authenticated source privately ... other conversations cannot see them." (payloads.md e managing-jobs.md, perto da linha 119)
- Autoridade: "a one-use grant that expires after 60 seconds and remains bound to that exact active run" (managing-jobs.md, perto da linha 93), para operações de gerenciamento de automação feitas em um turno.
- Retomada em execução de conversa: quando uma execução é interrompida, "Restart recovery matches a recorded terminal result to the exact run identity and restores it without running the payload or delivery again." (how-it-works.md, perto da linha 59)
- Retentativas: "**One-shot retry**: transient errors (rate limit, overload, network, timeout, server error) retry up to three times after 30 seconds, 60 seconds, and 5 minutes" (`managing-jobs.md`, linha 293).

### 5. Hermes Agent (`NousResearch/hermes-agent`)

Tem ferramenta de agendamento para o próprio modelo, mas o disparo cria uma sessão nova, não volta à conversa:

- Ferramenta `cronjob` (`tools/cronjob_tools.py`, linha 1133): ações `create`, `list`, `update`, `pause`, `resume`, `remove`, `run` e `cancel`. Sobre `run`: "fires a job immediately in the BACKGROUND (returns a handle at once, outcome re-enters the conversation when done — do not wait or poll".
- Formas de agendar (linha 1160): "(2) explicit one-shot by duration — 'in 30m', 'in 2h' (fires ONCE that far from now; use this for 'remind me in N minutes' — do NOT hand-compute an absolute timestamp)".
- Sessão nova: "Jobs run in a fresh session with no current-chat context, so prompts must be self-contained, and the agent's FINAL RESPONSE is what gets delivered — cron runs are autonomous and cannot ask questions." (`tools/cronjob_tools.py`, linha 1135)
- Teto contra laço: "Cron-run sessions cannot recursively create more cron jobs. Hermes disables cron management tools inside cron executions to prevent runaway scheduling loops." (`website/docs/user-guide/features/cron.md`, linha 43)
- Armazenamento: "Cron job storage: ~/.hermes/cron/jobs.json" (`cron/jobs.py`, linhas 1–2 e 98–99). O tique do agendador: `TICKER_INTERVAL_SECONDS = 60` (linha 109). Trava entre processos: `fcntl` (linhas 19–21).
- Recuperação: "An interrupted execution or a prepared fire that cannot be found stays paused for operator review. Recovery never creates another admission for it." (cron.md, "Admission recovery")
- Janela de recuperação de atraso: "A missed cron occurrence is run late only inside a catch-up window: half the job's period, clamped to 2 minutes–2 hours." (cron.md, linha 249)
- Cancelamento: `cancel` "stop the job's current run" (cron.md, perto da linha 327).
- Não encontrado nas fontes lidas: limite de quantas tarefas pendentes um bot pode ter, e tamanho mínimo do intervalo para `in 30m` (ver "O que não foi verificado").

### 6. OpenMausBot e DuskBot (só README)

- OpenMausBot: "Tell a bot 'every weekday at 9, send me a summary of my inbox' ... and it sets the trigger up in that turn with its `trigger` tool (no confirmation; the chat shows a live card with Edit, Pause and Undo)." Os gatilhos ficam numa aba própria: "**Triggers**, first in the sidebar, lists every schedule and webhook". Regra contra acúmulo: "Interval schedules ... skip an occurrence when the previous run is still active, so slow work cannot build an unbounded queue." (README, linhas 427–438)
- DuskBot: "Ask once and it becomes a routine." E: "a missed run can still start up to 12 hours late" (README, linhas 109 e 122). Rotinas aparecem no painel lateral ("routines in the side panel", legenda da imagem). Não é retorno dentro da conversa.

### 7. LangGraph (SDK e `interrupt`)

- Agendamento de execuções em um thread: `crons.create_for_thread(thread_id, assistant_id, schedule="0 9 * * *", ...)`. "Schedules are interpreted in UTC unless a timezone is specified." E: "If not provided, the cron job will run indefinitely." (`libs/sdk-py/langgraph_sdk/_async/cron.py`, linhas 44–47 e 93–108). Nota: "The crons client functionality is not supported on all licenses." (linha 54)
- Pausa e retomada no grafo: `interrupt` exige checkpointer: "To use an `interrupt`, you must enable a checkpointer, as the feature relies on persisting the graph state." E: "The graph resumes from the start of the node, **re-executing** all logic." (`libs/langgraph/langgraph/types.py`, docstring de `interrupt`). Isso significa que a retomada refaz o nó, e o código do nó precisa ser idempotente.
- Não há, nas fontes lidas, um `sleep(20 min)` nativo do grafo: a espera de tempo é externa (cron do SDK ou do servidor).

### 8. Agent Zero (só README)

- "**Scheduled operations:** run recurring checks and monitoring tasks with project-scoped context and credentials." (README, linha 259). Não há detalhe de API de agendamento nas fontes lidas.

### 9. Segurança: o que foi encontrado

- **Teto de criação por execução.** Hermes: "Cron-run sessions cannot recursively create more cron jobs" (fato 5).
- **Escopo de ferramenta por origem.** OpenClaw: scripts não recebem `add`, `update`, `run` ou `wake` (fato 4).
- **Autoridade capturada.** OpenClaw guarda a fonte autenticada da criação em privado e só usa a autoridade da conversa de origem para continuar; grants de gerenciamento de uma operação expiram em 60 segundos (fato 4).
- **Concorrência e fila.** OpenClaw: no máximo 8 execuções simultâneas (16 com memória livre); execução de conversa espera a conversa ficar ociosa (fato 4).
- **Teto de tentativas.** OpenClaw: retentativa limitada a três vezes (fato 4).
- **Limite de tarefas.** Claude Code: 50 tarefas por sessão; expiração em 7 dias (fato 1).
- **Aviso visível.** Claude Code mostra o wakeup na lista de tarefas e permite parar com Esc (fato 1). OpenClaw lista as automações no Control UI, com histórico (`openclaw automations list`, fato 4).
- **Injeção.** Nenhuma das fontes lidas descreve uma defesa específica contra uma página web que manda o bot agendar a si mesmo. A mais próxima é a de OpenClaw (autoridade capturada) e o "não definido pelo conteúdo" de OpenMausBot e DuskBot, que não foram aprofundados. Ver "O que não foi verificado".

## Inferências

Rotuladas como inferência: são conclusões minhas a partir das fontes, não afirmações delas.

1. **Dois modelos de retorno existem.** Claude Code e OpenClaw (com `session:<key>`) mantêm o wakeup dentro da mesma conversa e do mesmo contexto. Hermes e os produtos de rotina (OpenMausBot, DuskBot) criam uma execução nova, separada da conversa. Para o pedido do dono (mesma conversa, sem rotina visível), o modelo de Claude Code e OpenClaw é o que serve.
2. **Espera mais longa que o cache deixa o custo subir.** Com TTL de 5 minutos, um wakeup de 20 minutos quase certamente reprocessa o contexto inteiro (inferência a partir da tabela de TTL). Por isso, o custo de um retorno é perto de um turno completo com o contexto todo, não só do novo passo.
3. **O teto de um minuto e uma hora de Claude Code e o de `/loop` do OpenClaw batem com o cenário pedido** (20 minutos cabem). Esperas de horas são outro caso e, pelo que as fontes mostram, o caminho delas é a rotina visível. Isso confirma a separação que o dono quer.
4. **Retomar a mesma execução é mais seguro que começar uma nova.** Claude Code e OpenClaw retomam a sessão ou o contexto gravado. Na execução nova, o plano e os resultados de ferramenta da execução original se perdem, a não ser que sejam repassados. No Suup o plano vive na execução, e não na conversa (MEMORIA, e a regra do dono).
5. **Um wakeup sem limite de quantos pode existir é o ponto de falha.** Claude Code limita a 50 tarefas e a 7 dias; Hermes proíbe agendar a partir de uma execução de agendamento. Nenhuma das fontes mostra um limite de "um wakeup pendente por execução". É uma escolha de projeto, e não um padrão verificado.
6. **Quando o usuário escreve durante a espera, o padrão das fontes é tratar a mensagem como resposta e reagendar só se o bot pedir.** OpenClaw espera a conversa ficar ociosa antes de disparar um `session:<key>`; Claude Code, quando o turno está ocupado, espera o fim do turno. Nenhum dos dois mostra cancelamento automático no envio de mensagem; são duas formas de ordenação.
7. **Visibilidade mínima para segurança.** Mesmo sem o painel de rotinas, o usuário precisa ver que há um retorno pendente e poder cancelá-lo. Claude Code mostra o wakeup na lista de tarefas (sem ser rotina) e OpenClaw lista o que está agendado. Isso indica que a visibilidade mínima é um indicador na conversa com um botão de parar.

## O que não foi verificado

- **Schema exato de `ScheduleWakeup`** (nomes de argumento além de `stop`). A página diz só o efeito; o formato do prompt aparece só no campo `session_crons`.
- **Claude Code `/loop` e a regra de 50 tarefas em sessões de fundo** (agent view): li as regras gerais, não testei o comportamento.
- **OpenAI Agents SDK** (ferramenta de agendamento, se existir): não consultado. Só a documentação de background mode da Responses API foi lida.
- **Anthropic Agent SDK** com agendamento ou retorno temporal: nas páginas lidas (hosting e agent loop) não há; não li todas as páginas do SDK.
- **Hermes: intervalo mínimo e teto de tarefas pendentes**: não encontrados no schema nem no `jobs.py` lido. Não li `cron/scheduler.py` inteiro.
- **OpenClaw: valores de `pacing.min` e `pacing.max` por padrão** (os limites configurados): não li a configuração de padrões.
- **OpenClaw, documentação do site** (`docs.openclaw.ai`): bloqueada; o conteúdo lido é a versão do repositório. Pode haver diferença.
- **LangGraph: agendamento em servidor (LangGraph Platform)**: li só o SDK. O comportamento da licença e do servidor não foi verificado.
- **Letta (sleep-time agents), Eliza e nightly-labs/openbot**: nenhum detalhe de API de agendamento lido. Letta e Eliza não foram acessíveis pelos caminhos tentados; openbot foi só checado no README, sem trecho de agendamento.
- **Mitigação de injeção de prompt contra um agendamento vindo de página web**: nenhuma das fontes lidas descreve a defesa específica. Não encontrei na documentação de Claude Code nem de OpenClaw uma regra do tipo "conteúdo externo não pode agendar".
- **Custo real de um retorno** (com cache frio ou quente): só a tabela de TTL foi lida, não há medição.
- **Comportamento de Claude Code quando o usuário escreve durante a espera**: a página diz que a tarefa espera o turno acabar; não li o caminho de cancelamento do wakeup pelo envio de mensagem.

## Implicação para o Suup

Todas as propostas abaixo são **inferências** a partir das fontes. Nenhuma foi testada no Suup. Os nomes são sugestões.

**Proposta de forma (inferência):** uma ferramenta de controle, como as de `plan` e `finish`, chamada `agendar_retorno`, com argumentos:

```text
agendar_retorno(
  em: "20m"            # duração, de 1 minuto a 60 minutos (padrão); sem regex: número inteiro em segundos
  nota: "CI do deploy; ao voltar, ver o status e avisar"   # até 500 caracteres, escrita pelo próprio bot
)
```

Sem `as` (horário absoluto) nesta versão: horário fixo passa a ser assunto de rotina, que é visível, como o dono quer.

| Decisão | Base | Tipo |
|---|---|---|
| **Estacionar a MESMA execução** num novo estado `waiting_timer` (com `wake_at` e a nota), em vez de iniciar uma execução nova | Claude Code e OpenClaw retomam o contexto (fatos 1 e 4); no Suup o plano e o log vivem na execução (MEMORIA; `run-control.ts`) | Inferência |
| **Estado novo `waiting_timer`** entra em `runStatusSchema` (`packages/core/src/events.ts`, linhas 184–192) e em `ACTIVE_RUN_STATUSES` (`packages/db/src/conversation-runs.ts`, linhas 10–16). Sem worker preso, como `waiting_user` | `run-control.ts` diz que execução esperando o usuário "is not using a worker" | Fato para o padrão; nome é inferência |
| **Um retorno pendente por execução**: uma coluna `wake_at` (e a nota) em `runs`, não uma tabela separada. Um segundo agendamento na mesma execução substitui ou é recusado | Claude Code: um `ScheduleWakeup` por iteração, com `stop` para cancelar (fato 1); a restrição de "um" é inferência | Inferência |
| **Intervalo: 1 minuto a 60 minutos**, padrão; acima disso, o bot deve pedir uma rotina visível | Claude Code: "between one minute and one hour" (fato 1); OpenClaw: "between 1 minute and 1 hour" no `/loop` (fato 4) | Fato para o intervalo; a regra de "acima disso, rotina" é inferência |
| **Teto de retornos por execução** (sugestão: 10 no total) e **teto diário por bot** para retornos | Claude Code limita a 50 tarefas por sessão (fato 1); Hermes proíbe agendar a partir de execução de agendamento (fato 5); a conta de 10 é inferência | Fato para o padrão; números são inferência |
| **Retorno só em execução iniciada pelo usuário** (`origin: user`). Execução de iniciativa (`proactive`, PLANO 4.14) e de rotina não podem agendar | PLANO 4.14 pede freios a trabalho por iniciativa própria; Hermes e OpenClaw restringem quem agenda (fatos 4 e 5) | Inferência |
| **Mensagem nova do usuário durante a espera** entra na execução (como `waiting_user` faz hoje), **cancela** o retorno pendente e a execução retoma com a mensagem e a nota. Se o bot quiser voltar a checar, reagenda naquele turno | resume.ts (`resumeFromWaiting`) já trata mensagem de inbox para `waiting_user`; o padrão de OpenClaw é a conversa ficar ociosa antes do disparo (fatos 4 e inferência 6) | Inferência |
| **Cancelamento**: `cancelRun` aceita `waiting_timer` direto, como já aceita `waiting_approval` (`run-control.ts`); o usuário também cancela pelo indicador na conversa | `run-control.ts`, comentário de `cancelRun` | Fato para o padrão; a UI é inferência |
| **Aprovações continuam valendo**: o retorno não aprova nada. Uma ação que pede aprovação continua indo para `waiting_approval` como hoje | Claude Code: aprovação vale por ação, e o wakeup não muda isso (fato 1, `ScheduleWakeup` não é aprovação); PLANO 4.14 (níveis de autonomia) | Inferência |
| **Contagem de custo**: cada disparo é um turno da mesma execução, com o mesmo orçamento de turnos. Espera fora do turno não custa token. Retorno conta como trabalho pedido, não como iniciativa própria | MEMORIA (contexto lido uma vez por execução); PLANO 4.14 (orçamento separado para iniciativa) | Inferência |
| **Cache**: documentar que uma espera acima de 5 minutos perde o cache na API com chave; a opção de TTL de 1 hora fica como ajuste de custo | prompt-caching: TTL de 5 minutos em chave de API e 1 hora em assinatura (fato 1) | Fato para o padrão; a decisão é inferência |
| **Disparo na retomada após queda**: o worker reivindica o retorno com lease, como `claimNextRun` faz hoje (`runs.ts` linha 150, `FOR UPDATE SKIP LOCKED`). Se o processo morre, o retorno **não** dispara atrasado em rajada: dispara uma vez, e a execução registra o atraso | errors.md: wakeup perdido não dispara atrasado (fato 1); OpenClaw: "does not report success or replay the reminder" (fato 4); Hermes: "Recovery never creates another admission" (fato 5) | Fato para o padrão; a regra de uma vez é inferência |
| **Visibilidade mínima** (não é rotina): (a) indicador na conversa "Volto às 14h20: <nota>" com botão **Cancelar**; (b) linha no log da execução (`wait_scheduled`, `wait_fired`, `wait_cancelled`); (c) nada no painel de rotinas | Claude Code mostra o wakeup na lista de tarefas e permite parar (fato 1); OpenClaw lista e permite remover (fato 4); o dono quer fora de rotinas, então o mínimo é o indicador e o botão | Fato para o padrão; a forma é inferência |
| **Injeção**: a nota é escrita pelo bot, mas se a execução leu conteúdo de fora, o retorno mostra essa origem no indicador, e o usuário vê antes de cancelar. Não há defesa específica nas fontes; o teto de retornos limita o dano | Nenhuma fonte lida descreve defesa específica (ver "O que não foi verificado"); o teto é fato 1 e 5 | Inferência, com lacuna |
| **Sem regex no harness**: `em` é número inteiro validado; horário absoluto, se vier depois, é parseado por biblioteca de data, e não por padrão de texto | CLAUDE.md, regra do dono sobre regex; `packages/core/test/no-regex.test.ts` | Fato para a regra do repositório |
| **Medir antes de liberar**: bateria com (a) pedidos de retorno legítimos de 1 a 60 min; (b) laço induzido por instrução de página externa; (c) mensagem do usuário durante a espera; (d) queda do worker durante a espera. Medir disparos, custo por disparo e cancelamentos | Anthropic e OpenClaw têm casos de crash e de mensagem durante a espera (fatos 1 e 4); a bateria é inferência | Inferência |

**Pontos em aberto para o dono decidir** (não respondidos pelas fontes):

1. O intervalo máximo de 60 minutos é suficiente, ou um CI pode levar mais? Se sim, o máximo pode subir para 4 horas, mas precisa de limite de custo.
2. Um retorno é "silencioso" (só o indicador) ou também manda mensagem quando dispara? Recomendo mandar mensagem só quando houver resultado a comunicar.
3. Qual o nome visível do retorno na interface: "retorno agendado", "volto às 14h20" ou outro?

## Decisão do dono (19/11/2026)

O dono rejeitou o indicador na conversa ("volto às 14h20" com botão Cancelar): é "meio anti-usuário". Fica assim:

- **Sem marcador próprio na interface.** O bot avisa na própria mensagem, numa bolha normal ("Disparei o deploy, volto em 20 minutos para conferir").
- **Parar é falar com ele.** Uma mensagem do usuário durante a espera chega à execução e cancela o retorno; o bot decide com o que o usuário disse. O cancelamento normal da execução também cancela o retorno.
- **Fora das rotinas e do painel.** O registro fica só no log da execução (`wait_scheduled`, `wait_fired`, `wait_cancelled`) e nos limites internos (tempo mínimo e máximo, um retorno pendente por execução, teto de remarcações, custo no orçamento).

As linhas da tabela acima que falam em indicador e botão ficam substituídas por esta decisão.
