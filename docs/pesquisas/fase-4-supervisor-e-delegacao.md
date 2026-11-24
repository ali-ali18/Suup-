# Pesquisa: bot supervisor, delegação entre bots e revisão noturna

Data da pesquisa: 21/11/2026. Valida o desenho do bot principal como supervisor na fase 4 (ver [PLANO.md](../PLANO.md), seções 4.5, 4.9 e 4.14; [MEMORIA.md](../MEMORIA.md); [APROVACOES.md](../APROVACOES.md); [RETORNO.md](../RETORNO.md)). Pesquisa anterior de referência: [fase-3-auto-review-regras-escritas.md](fase-3-auto-review-regras-escritas.md).

## Pergunta

O dono quer que o **Principal** seja um supervisor, como o "Grok Supervisor" do Grok Bot (marcado com uma estrela no avatar). Na versão dele, o supervisor recebe tarefas, passa para os outros bots, lembra o usuário de coisas, consulta os outros bots, lê a memória deles e revisa o trabalho. Os outros bots também conversam direto com o usuário e fazem o próprio trabalho.

Esclarecimento do dono, incluído nesta versão: o usuário fala com os outros bots diretamente, como sempre. O Principal sabe o que foi feito lá porque, cerca de uma vez por noite, revisa o que os outros bots fizeram (diários e atividade), guarda o que importa e lembra o usuário das coisas.

Perguntas desta pesquisa:

1. O que o "Grok Supervisor" faz, segundo as páginas públicas da xAI.
2. Como sistemas de orquestração (Anthropic, OpenAI, LangGraph, Claude Code, Hermes, OpenClaw, OpenBot) delegam tarefas: contrato da delegação, sync ou async, o que o delegado vê, como o resultado volta, falhas, limites de profundidade, custo, permissões e visibilidade de memória.
3. Como a revisão periódica e a "consolidação noturna" entre agentes funcionam: o que lê, o que escreve, como o lembrete chega, controles de custo e de janela de tempo.
4. Pesquisa sobre falhas de sistemas multiagente.

## Fontes

Todas lidas em 21/11/2026, salvo quando indicado.

xAI (Grok Bot):

- Página do produto: https://x.ai/bot (lida; 200)
- Anúncio "Introducing Grok Bot 1.0", publicado em 11/11/2026: https://x.ai/news/grok-bot-1-0 (lido; 200)
- Guia "Grok Bot 101": https://x.ai/bot/guides/grok-bot-101 (lido; 200)
- Guia "How I run post-sales with one chief of staff bot...": https://x.ai/bot/guides/grok-bot-for-post-sales (lido; 200). Relato de um usuário, não especificação.
- Guia "Grok Bot for PMs": https://x.ai/bot/guides/grok-bot-for-pms (lido; 200). Relato de um usuário.
- Lista de casos de uso: https://x.ai/bot/use-cases (lida; 200)
- Changelog do bot: https://x.ai/changelog/bot (403, bloqueado)
- Central de ajuda: https://help.x.ai/ (falha de conexão, bloqueado)
- Documentação para desenvolvedores, docs.x.ai: não tentada nesta pesquisa (na fase 3 retornou 403 do proxy)

Orquestração (Anthropic):

- "How we built our multi-agent research system", publicado em 13/06/2025 (metadado da página; a página foi atualizada em 09/10/2026): https://www.anthropic.com/engineering/multi-agent-research-system
- "Building effective agents", publicado em 19/12/2024 (metadado da página; atualizado em 09/10/2026; a própria página avisa que parte da ferramentaria mudou): https://www.anthropic.com/engineering/building-effective-agents
- Claude Code, "Create custom subagents" (markdown): https://code.claude.com/docs/en/sub-agents.md (lida)
- Claude Code, "Orchestrate teams of Claude Code sessions" (agent teams, experimental): https://code.claude.com/docs/en/agent-teams.md (lida)
- Claude Code, "Cross-session messaging": https://code.claude.com/docs/en/cross-session-messaging.md (baixada; não citada)
- Claude Platform, "Multiagent orchestration" (Managed Agents, beta): https://platform.claude.com/docs/en/managed-agents/multi-agent (lida)

Orquestração (OpenAI, LangChain, OpenBot):

- OpenAI Agents SDK, "Handoffs": https://openai.github.io/openai-agents-python/handoffs/ (lida)
- OpenAI Agents SDK, "Multi-agent": https://openai.github.io/openai-agents-python/multi_agent/ (lida)
- OpenAI Agents SDK, "Tools" (seção Agent.as_tool): https://openai.github.io/openai-agents-python/tools/ (lida)
- LangGraph Supervisor, README: https://raw.githubusercontent.com/langchain-ai/langgraph-supervisor-py/main/README.md (lido; diz que o padrão por ferramentas é o recomendado)
- OpenBot, README: https://raw.githubusercontent.com/nightly-labs/openbot/main/README.md (lido)

OpenClaw (documentação, pasta `docs/`, branch main, lida em 21/11/2026):

- Sub-agents: https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/subagents.md
- Nested sub-agents (profundidade e memória): https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/subagents/nesting.md
- Sub-agent tool policy: https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/subagents/tool-policy.md
- Sub-agent announce: https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/subagents/announce.md
- Sessões (`sessions_send`): https://raw.githubusercontent.com/openclaw/openclaw/main/docs/concepts/session-tool.md
- Dreaming (consolidação em segundo plano): https://raw.githubusercontent.com/openclaw/openclaw/main/docs/concepts/dreaming.md

Hermes Agent (clone local somente leitura em `/home/user/nousresearch/hermes-agent`, commit `152fe189`; não é a URL pública, e as linhas abaixo valem para esse commit):

- `tools/delegate_tool.py`, `tools/delegate_tool_config.py`, `tools/delegate_tool_toolsets.py`, `agent/background_review.py`, `cron/blueprint_catalog.py`.

Pesquisa (arXiv):

- Cemri et al., "Why Do Multi-Agent LLM Systems Fail?", arXiv:2503.13657, v3 de 26/10/2025 (lido o PDF, NeurIPS 2025 Datasets and Benchmarks): https://arxiv.org/abs/2503.13657
- Lin et al., "Sleep-time Compute: Beyond Inference Scaling at Test-time", arXiv:2504.13171, submetido em 17/04/2025 (lido o resumo): https://arxiv.org/abs/2504.13171

Não acessados: documentação do Letta (docs.letta.com retornou 403 do proxy; o repositório `letta-ai/letta` não tinha os caminhos tentados). Sem fonte primária do Letta nesta pesquisa.

## Fatos verificados

### 1. Grok Supervisor (xAI)

- **Não encontrado.** Nenhuma das páginas públicas lidas (`/bot`, `/news/grok-bot-1-0`, `/bot/guides`, `/bot/guides/grok-bot-101`, `/bot/guides/grok-bot-for-post-sales`, `/bot/guides/grok-bot-for-pms`, `/bot/use-cases`) menciona "supervisor" nem uma estrela no avatar. O HTML de `/bot` tem zero ocorrências de "supervisor". O que aparece é outro nome: um bot chamado "Chief of Staff" na lista de funções (`/bot`, e "Chief of Staff" em `/bot/use-cases`, sem descrição de estrela ou de hierarquia).
- O que as páginas dizem sobre o papel de coordenação, em texto:
  - Anúncio 1.0: "Bots can also join video calls... They keep track of decisions and learn more about the team's work". E: "It can also follow up on unfinished work, coordinate with other Bots, and bring people in when a decision requires their judgment." (https://x.ai/news/grok-bot-1-0)
  - Guia 101: "Other bots: Bots can message each other and trigger each other." E: "When it needs a judgment call, it can ask my Chief of Staff bot." (https://x.ai/bot/guides/grok-bot-101)
  - Guia de pós-venda (relato de usuário): "His name is Gus. Gus is my chief of staff, and he manages everyone else". E: "Most runs of my watches produce nothing, and that's by design. A routine that runs, looks, and decides I don't need to know is doing its job." (https://x.ai/bot/guides/grok-bot-for-post-sales)
  - Guia de PM (relato de usuário): "Chief of Staff: calendar, Slack, inbox. The only generalist. Stays quiet if nothing changed." E: "Named agents, separate memory... Chief of Staff should not be debugging computer-use evals. The eval agent is not archiving my mail." (https://x.ai/bot/guides/grok-bot-for-pms)
  - Mesmo guia: "EM is responsible for breaking down technical work, delegating and managing IC eng agents, and validating outputs against the goal."
- Permissões em canais compartilhados (anúncio 1.0): "Bots respect each person's permissions, ask before taking sensitive actions, and check whether information is appropriate to share in a public channel."
- Memória: "Manage what a Team Bot knows and see how your team uses it." (anúncio 1.0; sem detalhe de quem lê o quê).
- Não verificado: como o supervisor delega (contrato da chamada), se espera ou recebe depois, o que cada bot enxerga, e quais limites existem. As páginas são de marketing e relatos de usuário, não especificação.

### 2. Anthropic: orquestrador e subagentes

- Padrão: "Our Research system uses a multi-agent architecture with an orchestrator-worker pattern, where a lead agent coordinates the process while delegating to specialized subagents that operate in parallel." (MARS)
- Contrato da delegação: "Each subagent needs an objective, an output format, guidance on the tools and sources to use, and clear task boundaries. Without detailed task descriptions, agents duplicate work, leave gaps, or fail to find necessary information." (MARS). Caso real: "one subagent explored the 2021 automotive chip crisis while 2 others duplicated work".
- Escala por complexidade (MARS): "Simple fact-finding requires just 1 agent with 3-10 tool calls, direct comparisons might need 2-4 subagents with 10-15 calls each, and complex research might use more than 10 subagents". E o erro inicial: "spawning 50 subagents for simple queries".
- Síncrono: "Currently, our lead agents execute subagents synchronously, waiting for each set of subagents to complete before proceeding... the lead agent can't steer subagents, subagents can't coordinate". Assíncrono é tratado como trabalho futuro, com "challenges in result coordination, state consistency, and error propagation" (MARS).
- Custo: "agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats." (MARS). E: "token usage by itself explains 80% of the variance" no BrowseComp (MARS).
- Quando não usar: "some domains that require all agents to share the same context or involve many dependencies between agents are not a good fit for multi-agent systems today. For instance, most coding tasks involve fewer truly parallelizable tasks than research" (MARS).
- Resultado: "a multi-agent system with Claude Opus 4 as the lead agent and Claude Sonnet 4 subagents outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval." (MARS; eval interna, tarefa de pesquisa.)
- Saída do subagente: "Subagents call tools to store their work in external systems, then pass lightweight references back to the coordinator." (MARS)
- Padrão geral (BEA, 19/12/2024): orquestrador-trabalhadores é para tarefas em que "you can't predict the subtasks needed"; e "find the simplest solution possible, and only increasing complexity when needed".
- Claude Code, subagentes (https://code.claude.com/docs/en/sub-agents.md):
  - "Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions. It also sends its own requests, which count toward the same usage limits as your main conversation."
  - O resultado volta resumido: "the subagent does that work in its own context and returns only the summary."
  - Lista de ferramentas: "Inherits every tool available to subagents if omitted." (Inferência: o subagente recebe o que o pai escreveu na chamada, não o histórico da conversa; a página fala de "own context window", não descreve a montagem do prompt.)
  - Foreground bloqueia; background roda em paralelo: "Permission prompts are passed through to you" (foreground). Em background, "Claude Code surfaces the prompt in your main session and names the subagent that is asking." E o subagente em background tem menos ferramentas: "Don't rely on other built-in tools in a background subagent: Claude Code removes most of them."
  - Permissões: "Each inherits the parent conversation's permission rules" (built-ins). O modo do subagente é campo próprio (`permissionMode`), e subagentes de plugin não aceitam `hooks`, `mcpServers` ou `permissionMode`.
  - Profundidade: "By default, a subagent can spawn subagents of its own, up to three layers below the main conversation." Ao chegar no limite, "Claude Code withholds the Agent tool from every subagent except a fork".
  - Retomada: "Resumed subagents retain their full conversation history, including all previous tool calls, results, and reasoning." E `maxTurns`: "When the subagent reaches the limit, Claude Code returns its output marked as partial".
  - Memória própria do subagente: campo `memory` (escopos `user`, `project`, `local`), com diretório por agente: "The `memory` field gives the subagent a persistent directory that survives across conversations." O documento não diz se outros agentes podem ler esse diretório.
- Claude Code, agent teams (https://code.claude.com/docs/en/agent-teams.md, experimental, desativado por padrão):
  - "Teammates work independently, each in its own context window, and communicate directly with each other."
  - Custo: "Agent teams add coordination overhead and use significantly more tokens than a single session."
  - Limites: "No nested teams: teammates cannot spawn their own teammates. Only the lead can manage the team." E: "No per-teammate permission modes at spawn: teammates start with the permission mode described under Permissions."
  - Permissões: "Teammate permission prompts appear in the lead session, so approve them there yourself." E: "A teammate can't approve a permission prompt or supply consent on your behalf". Mensagens entre agentes são marcadas: "Claude Code tells the receiving agent the message came from another Claude session, not from you."
- Managed Agents, multiagente (https://platform.claude.com/docs/en/managed-agents/multi-agent, beta):
  - "With subagents, the agent itself determines what happens next. A subagent's thread stays available until you archive it, so the agent can send it follow-up messages."
  - Contexto isolado: "each agent runs in its own session thread, a context-isolated event stream with its own conversation history." E: "All agents share the same sandbox, filesystem, and vault credentials".
  - Um nível só: "One level: The agent can delegate to only one level of agents. Referencing another agent that has multiagent set fails the create or update request with a 400 validation error."
  - Limite: "Up to 20 agents" por lista.
  - Custo: "Keep runs to the tasks that need them, because every agent in a run uses tokens." Há orçamento por sessão: "Runs pause when the session reaches the budget".
  - Fluxos em segundo plano (workflows): "Context and results are passed programmatically from one agent to another... The agent can't send follow-up messages to a run's threads, and the server archives each one by the end of its run."

### 3. OpenAI Agents SDK: handoff e agente como ferramenta

- Handoff transfere a conversa: "When a handoff occurs, it's as though the new agent takes over the conversation, and gets to see the entire previous conversation history." (https://openai.github.io/openai-agents-python/handoffs/)
- Filtro de histórico: "An input filter is a function that receives the existing input via a HandoffInputData, and must return a new HandoffInputData." E o histórico aninhado é opt-in e beta: "Nested handoff history is available as an opt-in beta and is disabled by default while we stabilize it."
- Redação: "Nested handoff history changes how the transcript is represented; it does not redact sensitive data... Treat the receiving agent and its model provider as recipients of the forwarded history."
- Escolha de destino: "The handoff() helper always transfers control to the specific agent you passed in. If you have multiple possible destinations, register one handoff per destination and let the model choose among them."
- Argumentos validados: `input_type` "The SDK exposes that schema to the model as the handoff tool's parameters, validates the returned JSON locally, and passes the parsed value to on_handoff." E: "is_enabled is evaluated while the SDK prepares the available handoffs, before the model returns handoff arguments, so it cannot authorize values inside an argument-bearing handoff."
- Agente como ferramenta (https://openai.github.io/openai-agents-python/multi_agent/ e /tools/): "Use agents as tools when a specialist should help with a bounded subtask but should not take over the user-facing conversation." Em `Agent.as_tool()`: "The state options configure the nested agent run started by the tool call; the parent run's conversation state is not inherited automatically. To share client-managed history between the parent and nested runs, explicitly pass the same session to both." Aceita `max_turns`, `needs_approval` (pausa e retoma via `result.interruptions`) e `parameters` (esquema estruturado).
- Execução paralela: a página multi_agent cita `asyncio.gather` para tarefas independentes.
- Não verificado nesta leitura: limite padrão de profundidade e regra de bloqueio de volta (um agente não delegar de volta). A página de handoffs descreve o caso de um agente de triagem que passa para um especialista, mas não define essa regra.

### 4. LangGraph Supervisor

- O README diz: "We now recommend using the supervisor pattern directly via tools rather than this library for most use cases. The tool-calling approach gives you more control over context engineering".
- Por padrão a handoff passa o histórico inteiro: "by default `create_handoff_tool` passes **full** message history (all of the messages generated in the supervisor up to this point), as well as a tool message indicating successful handoff."
- Saída do trabalhador: `output_mode="full_history"` ou `"last_message"`.
- Sem resultado assíncrono no README: a delegação é sincrona dentro do grafo.

### 5. Hermes Agent (clone local, commit 152fe189)

- Modelo: `delegate_task`, com lista de tarefas (`tasks`), contexto por tarefa e `output_schema`. Docstring: "Spawns child AIAgent instances with a fresh conversation... The parent only ever sees the delegation call and the summary result, never the child's intermediate tool calls or reasoning." (`tools/delegate_tool.py:1-10`)
- Contexto do filho, no esquema da ferramenta: "Each child sees only its own context — repeat shared background in every task that needs it." (`tools/delegate_tool.py:881`)
- Validação de saída: `output_schema` com "parent validates with one bounded correction retry; result gains schema_valid, plus schema_errors on failure" (`tools/delegate_tool.py:883` e seguintes).
- Assíncrono por padrão: "top-level model calls run in the background while orchestrator children wait for their own workers" (`tools/delegate_tool.py:8`); o parâmetro `background` está "DEPRECATED, ignored: top-level delegations always run in the background" (`tools/delegate_tool.py:910`).
- Entrega do resultado: tarefas com o mesmo `group` voltam juntas numa mensagem quando todas terminam (`tools/delegate_tool.py`, esquema do campo `group`).
- Controles em execução: `action` = `list`, `steer` (manda correção a um filho sem parar), `stop` e `continue` (dá seguimento a um filho que terminou). (`tools/delegate_tool.py`, campo `action`.)
- Ferramentas bloqueadas para filhos (`tools/delegate_tool_toolsets.py:14-22`): "delegate_task" (sem delegação recursiva), "clarify", "memory" ("no writes to shared MEMORY.md"), "send_message" ("no cross-platform side effects"), "cronjob_manage".
- Profundidade: `MAX_DEPTH = 1  # flat by default` (`tools/delegate_tool_config.py:23`); o limite configurável é `delegation.max_spawn_depth`, e ao chegar no limite o erro é "Delegation depth limit reached" (`tools/delegate_tool.py:651-656`). "Each extra level multiplies API cost." (`tools/delegate_tool_config.py`, docstring de `_get_max_spawn_depth`, linha 197-199.)
- Concorrência: `_DEFAULT_MAX_CONCURRENT_CHILDREN = 10` (`tools/delegate_tool_config.py:19`). Tempo limite padrão para filhos: `DEFAULT_CHILD_TIMEOUT: Optional[float] = None`, sem limite (`tools/delegate_tool_config.py:29`).
- Aprovações de comando perigoso em filhos: "Auto-deny (safe default): returns 'deny' so the child sees a recoverable refusal." (`tools/delegate_tool_config.py:38-44`); aprovar exige `delegation.subagent_auto_approve: true`.
- Revisão em segundo plano (`agent/background_review.py:1-6`): "After every turn `AIAgent.run_conversation` may spawn a daemon thread that replays the conversation snapshot in a forked AIAgent and asks 'should any skill/memory be saved or updated?'. Writes go straight to the memory + skill stores". Ferramentas da revisão são por lista (`_review_tool_whitelist`, linhas 1212-1223): a revisão de skill "never gets the memory tool, so an unattended fork cannot act on the memory tool's 'consolidate now' hint and delete entries no one reviewed" (comentário em `agent/background_review.py`, perto da linha 1217).
- Tarefas agendadas com silêncio: os blueprints de cron mandam o modelo responder com `[SILENT]` quando não há nada a dizer (`cron/blueprint_catalog.py:139` e `:249`).
- Blueprint "Morning briefing" (categoria `daily`, `cron/blueprint_catalog.py:109-126`): "A short daily briefing: today's calendar, weather, and..." (texto completo no arquivo). "Workday start reminder": `schedule_template="{minute} {hour} * * 1-5"`, horário padrão `09:00` (`cron/blueprint_catalog.py:186-198`).

### 6. OpenClaw (documentação)

- Subagentes: "Sub-agents are background agent runs spawned from an existing agent run. Each one runs in its own session... and, by default, **announces** its result back to the requester for review." (`docs/tools/subagents.md`)
- Custo: "each sub-agent has its own context and token usage by default."
- Contexto: "When a child genuinely needs the requester's current transcript, spawn it with `context: "fork"`." (`docs/tools/subagents.md`)
- Limites padrão (`docs/tools/subagents/nesting.md`): "sub-agents can recursively delegate through depth `5`", com `maxSpawnDepth` (padrão 5, faixa 1-5), `maxChildrenPerAgent: 5` (padrão 5, faixa 1-20), `maxConcurrent: 8`, `runTimeoutSeconds: 900`.
- Permissões por tipo: "Hidden sub-agents always lose `gateway`, `agents_list`, `session_status`, `progress_card`, `cron`, `message`, `sessions_send`, and the `conversations_*` tools regardless of depth or role... ordinary `allow`/`alsoAllow` entries cannot override it." (`docs/tools/subagents/tool-policy.md`)
- Entrega: "The completed child's result is handed to the requester; delivery does not ask the child to generate a separate announcement." Falhas de entrega ficam como aviso: "a permanent refusal stops automatic dispatch and records a visible failure notice" (`docs/tools/subagents/announce.md`). Sem limite de tentativas: "There is no attempt limit, retry ladder or expiry" para recusas temporárias.
- Sessões entre si (`docs/concepts/session-tool.md`): `sessions_send` "runs another session on the same Gateway and optionally waits for the response. ... A peer's reply reaches the requester once, either inline or as a later inter-session input." Lista de permissão explícita: `agents.entries.<agentId>.tools.agentToAgent.send`, que "can authorize `sessions_send` to selected agents without exposing their sessions to list".
- Memória (`docs/tools/subagents/nesting.md`, "Memory audience inheritance"): o pai registra "the immediate parent key (`spawnedBy`), exact parent session id (`spawnedBySessionId`)"; "For memory access, OpenClaw validates every parent hop against the current parent". A memória que o filho lê é a de quem o criou, por cadeia de pais validada pelo host.
- Consolidação em segundo plano (dreaming), tratada na seção "Revisão noturna" abaixo.

### 7. OpenBot (README)

- "Shared desktop channel chats with one task owner, explicit delegation, shared history, and Stop, Resume, Reassign, Archive, and Restore controls." Também: "Agent-to-agent messages, replies, reactions, images, and managed file transfers." (linhas 29-30.) O README não descreve o contrato da delegação nem limites de profundidade.
- Permissões: "Agents run with `danger-full-access` and `approvalPolicy: never`. They can read and modify files..." (linha 17). Ou seja, o modo padrão de agente não tem aprovação. Diferente do Suup.
- Importação do Grok Bot: o README cita um "OpenBot export agent" no Grok Bot que exporta agentes, incluindo "instructions, avatar, skills, routines, and memories" (seção "Import agents from Grok Bot").

### 8. Revisão de falhas multiagente (arXiv:2503.13657, Cemri et al., v3)

- Taxonomia MAST: 14 modos em 3 categorias: "(i) system design issues, (ii) inter-agent misalignment, and (iii) task verification." Base: 1642 traces em 7 frameworks (o resumo fala em "1600+ annotated traces"), kappa = 0,88 em 150 traces analisados por humanos.
- Proporções por categoria (Figura 1, texto da figura): design do sistema 15,7%; desalinhamento entre agentes 32,3%; verificação de tarefa 23,5%.
- Modos citados no texto, com a porcentagem que o próprio texto dá: FM-1.1 Disobey Task Specification 11,8%; FM-2.6 Reasoning-Action Mismatch 13,2%; FM-2.3 Task Derailment 7,40%; FM-2.2 Fail to Ask for Clarification 6,80%; FM-3.1 Premature Termination 6,20%; FM-3.2 No or Incomplete Verification 8,20%; FM-3.3 Incorrect Verification 9,10%. A figura e o texto não batem em todos os valores; esta pesquisa usa os do texto.
- Insight 1: "MAS failure is not merely a function of challenges in the underlying model; a well-designed MAS can result in performance gain when using the same underlying model."
- Insight 2: "Solutions focused on context or communication protocols are often insufficient for FC2 failures, which demand deeper 'social reasoning' abilities from agents."
- Insight 3: "Multi-Level Verification is Needed. Current verifier implementations are often insufficient; sole reliance on final-stage, low-level checks is inadequate." E: "Systems with explicit verifiers like MetaGPT and ChatDev generally show fewer total failures."
- Sobre ganho: "Despite the increasing adoption of MAS, their performance gains often remain minimal compared to single-agent frameworks [18] or simple baselines like best-of-N sampling [19]." (introdução) e no resumo: "their performance gains on popular benchmarks are often minimal."

### 9. Sleep-time compute (arXiv:2504.13171, Lin et al., 17/04/2025; resumo)

- "sleep-time compute, which allows models to 'think' offline about contexts before queries are presented: by anticipating what queries users might ask and pre-computing useful quantities".
- Resultado: "sleep-time compute can reduce the amount of test-time compute needed to achieve the same accuracy by ~ 5x on Stateful GSM-Symbolic and Stateful AIME".
- Custo por consulta: com várias consultas sobre o mesmo contexto (Multi-Query GSM-Symbolic), "decrease the average cost per query by 2.5x".
- Escopo: tarefas de raciocínio sintéticas (GSM-Symbolic, AIME). Não é benchmark de agentes com ferramentas.

### 10. Consolidação noturna: OpenClaw "Dreaming"

Fonte: https://raw.githubusercontent.com/openclaw/openclaw/main/docs/concepts/dreaming.md (lida em 21/11/2026).

- Ativo por padrão: "Dreaming is enabled by default."
- Fases, em ordem (light, REM, deep), com efeito na escrita: light "Never writes to `MEMORY.md`"; REM "Never writes to `MEMORY.md`"; deep "Yes (`MEMORY.md`)". Durante o deep, "Passes gated owner and agent-derived candidates to a tool-free completion that chooses additions, merges, and supersessions against the current `MEMORY.md`."
- O que é lido: "Reads recent short-term recall state, daily memory files, and session transcripts when available."
- Quem entra na ingestão de transcrições: "Only interactive sessions are eligible. Cron, heartbeat, subagent, and unknown sessions stay out of durable candidate ingestion." E: "Transcript text is not secret-masked before ingestion."
- Poda antes de consolidar: "Before building the consolidation prompt, `memory-core` removes candidates whose indexed provenance is `untrusted` or `system`. This is a structural taint gate, not a score penalty."
- Transcrições: "Tool output, web content, and non-owner turns are excluded from the stored session path as well." (seção de backfill de sessões.)
- Portões de promoção: "Ranks candidates with weighted scoring and threshold gates (`minScore`, `minRecallCount`, `minUniqueQueries` must all pass)." Pesos: relevância 0,30; frequência 0,24; diversidade de consultas 0,15; recência 0,15; consolidação 0,10; riqueza conceitual 0,06.
- Escrita reversível: "Before the file changes, the previous `MEMORY.md` is stored in SQLite-backed plugin state. `DREAMS.md` receives added, merged, and superseded counts plus short diff-style highlights."
- Fallback: "Falls back to the previous append-only promotion path when the model is unavailable or the rewrite fails validation."
- Diário: "Each sweep with useful material combines its Light, REM, and successfully promoted Deep inputs into one short diary entry, including when nothing qualifies for durable promotion." O diário é "for human reading in the Dreams UI, not a promotion source."
- Agenda: "auto-manages one cron job for a full dreaming sweep"; `dreaming.frequency` padrão `0 3 * * *`; `dreaming.model` padrão "default model".
- Limites de execução: "Dreaming completions use the subagent queue at background priority and honor `agents.defaults.subagents.maxConcurrent`." O diário usa `agents.defaults.timeoutSeconds`, "the same 48-hour default".
- Fonte científica declarada: "Background consolidation is informed by sleep-time compute (arXiv:2504.13171)."

### 11. Revisão em segundo plano e tarefas agendadas no Hermes (clone local)

- Revisão após cada turno: ver fato 5 (`agent/background_review.py:1-6`).
- Limite de ferramentas da revisão: as ferramentas são por lista, "DISPATCH-side only" (`agent/background_review.py:1212-1223`).
- Silêncio como padrão de tarefa agendada: `[SILENT]` (`cron/blueprint_catalog.py:139, :249`).

### 12. Entrega de lembretes: o que as fontes dizem

- x.ai (guia de pós-venda, relato de usuário): "Gus... will ping me if anything urgent pops up." E: "one nudge reminds me to reach back out to an IT lead". Quase tudo o que o bot observa não vira mensagem: "Most runs of my watches produce nothing, and that's by design."
- Hermes: a regra de silêncio com `[SILENT]` é a forma de não enviar nada quando não há o que dizer.
- OpenClaw: o diário e a consolidação são "not a promotion source" e não chamam o usuário; o documento não descreve canal de lembrete.
- Não encontrado nas fontes lidas: horário fixo de "bom dia" como comportamento padrão do dreaming (é um blueprint de cron do Hermes, não do OpenClaw).

## Revisão noturna entre bots: síntese

Esta seção responde ao esclarecimento do dono: revisão periódica (perto de uma vez por noite) do que os outros bots fizeram, memorizar e lembrar o usuário.

**O que a revisão deve ler.** As fontes convergem em três limites:

- Só conversas interativas, nunca tarefas agendadas, heartbeat ou subagentes: "Only interactive sessions are eligible" (OpenClaw dreaming). O Suup já tem um equivalente: rotinas e execuções delegadas são origens diferentes (PLANO.md:56). Uma revisão do Principal que lê execuções de rotina dará ruído e risco de injeção.
- Sem saída bruta de ferramenta: "Tool output, web content, and non-owner turns are excluded from the stored session path" (OpenClaw dreaming). A Anthropic faz o mesmo no classificador do modo automático (fase 3). O Suup já aplica isso ao revisor de aprovações (APROVACOES.md:100: "O que ele nunca vê: texto do assistente, resultado de ferramenta...").
- Poda por proveniência antes do modelo: OpenClaw remove candidatos "whose indexed provenance is `untrusted` or `system`" antes da consolidação, como "a structural taint gate, not a score penalty".

Ponto de atenção: o diário do Suup (MEMORIA.md:45-47) grava o resumo que o próprio bot escreveu no `finish`. Esse texto pode ter sido influenciado por conteúdo externo lido numa ferramenta. Logo, a revisão deve tratar o resumo como dado, não como instrução, e preferir campos estruturados (resultado, origem, hora, id) antes do texto livre.

**O que a revisão escreve.** OpenClaw separa: fases de leitura (light e REM) não escrevem a memória durável; só a fase deep escreve, por decisão do modelo ("The model returns operation decisions, not replacement memory prose") com "Source: path#Lx-Ly" obrigatório, e guarda a versão anterior para desfazer. Para o Suup, o equivalente natural é: o Principal escreve só as próprias notas (ou um "resumo de equipe" próprio) e follow-ups, nunca memórias de outro bot. Isso preserva "o bot gerencia a memória sozinho" (MEMORIA.md:20) e "só aquele bot" para notas e diário (MEMORIA.md:11-12).

**Como o lembrete chega.** Três padrões verificados: (a) silêncio por padrão com `[SILENT]` (Hermes); (b) relatório diário fixo, como o "Morning briefing" e o "Workday start reminder" (Hermes, `cron/blueprint_catalog.py`); (c) "Stays quiet if nothing changed" e "Most runs... produce nothing" (x.ai, relatos). O Suup já prevê notify ou silent por rotina (PLANO.md:209). A pergunta em aberto é o canal: mensagem na conversa do Principal ou notificação. As fontes não dizem qual é melhor; é decisão do dono.

**Controles de custo e janela.** Verificado: horário fixo de execução (`0 3 * * *` no OpenClaw), modelo de revisão separado (`dreaming.model`), concorrência limitada pela fila de subagentes (`maxConcurrent`), e tempo limite da execução. Hermes: teto de filhos concorrentes (10) e profundidade 1 por padrão. Anthropic: "every agent in a run uses tokens". Sleep-time (arXiv:2504.13171) mostra que processar antes reduz custo por consulta em tarefas sintéticas, o que não prova ganho para o Suup.

**Limite conhecido.** OpenClaw admite que o transcrito "is not secret-masked before ingestion". O Suup não detecta segredo por padrão (MEMORIA.md:51, :229-231, por decisão de não usar regex). A revisão noturna lerá mais texto, então o risco de guardar segredo cresce. Isso precisa de decisão do dono; a fonte não oferece solução que o Suup possa adotar sem regex.

## Inferências

Rotuladas como inferência; não são afirmações das fontes.

1. **Principal como supervisor com um nível só.** Anthropic (Managed Agents) limita a um nível de delegação; Hermes e OpenClaw têm profundidade configurável (padrão 1 e 5). Inferência: para o Suup, profundidade 1 é o padrão mais seguro: o Principal delega, o delegado não delega de volta. Isso combina com o caso do dono.
2. **Delegação assíncrona com resultado de volta.** Hermes e OpenClaw entregam o resultado depois ("async-delegation completion", "announce"). Anthropic MARS aponta a execução síncrona como gargalo. Inferência: `delegate` deve criar uma execução em segundo plano e devolver o resultado como evento na conversa do Principal (o PLANO já prevê execuções em segundo plano, PLANO.md:371).
3. **Contexto do delegado.** Todas as fontes dão ao filho contexto próprio, não o histórico do pai (Claude Code "own context window"; Hermes "Each child sees only its own context"; Managed Agents "context-isolated"). O OpenAI handoff passa o histórico por padrão, e o LangGraph também. Inferência: para o Suup, o `delegate` deve enviar objetivo, critérios e contexto explícito, como MARS recomenda, e não o histórico completo.
4. **Permissões do delegado.** OpenBot roda com `approvalPolicy: never`; Hermes nega por padrão nos filhos; Claude Code exige que a aprovação em background passe pela sessão principal. Inferência: o delegado do Suup deve manter o próprio portão de aprovação (APROVACOES.md), e o cartão deve ir ao usuário, não ao Principal. Isso confirma o plano atual.
5. **Leitura de memória dos outros bots.** Nenhuma fonte dá uma API de "ler a memória de outro agente" com o mesmo formato. OpenClaw valida a cadeia de pais por host. Inferência: o Principal lê por uma ferramenta somente-leitura que recebe o bot alvo e devolve trechos já filtrados (resumo, data, id), com a mesma regra de proveniência do dreaming, e nunca escreve na memória alheia.
6. **Custo.** MARS: 15× o custo de um chat (sistema de pesquisa, tarefa que se paga); Anthropic também diz que o modelo de código tem menos paralelismo. Inferência: o `delegate` do Suup deve vir com teto de custo por delegação e a métrica de custo por execução já prevista (PLANO.md:294).
7. **Verificação do resultado.** MAST: falhas de verificação somam cerca de um quarto dos casos (23,5% na categoria). Inferência: o Principal revisar o resultado do delegado é a mesma função do revisor de `finish` do PLANO (PLANO.md:84), mas com evidência, não só o texto.

## O que não foi verificado

- **Grok Supervisor**: a estrela no avatar, o contrato de delegação, o que o supervisor enxerga e os limites não foram encontrados em fonte pública. Os guias de x.ai são de relatos de usuários.
- **changelog do x.ai bot** (403), **help.x.ai** (falha de conexão) e **docs.x.ai** (não tentada): podem conter a especificação. Não foram acessados.
- **Letta sleep-time agents** (produto): docs.letta.com bloqueado (403) e o repositório não tinha os caminhos tentados. Só o artigo arXiv foi lido.
- **Hermes "daily digest" fora do blueprint**: o clone local não foi estudado além da revisão em segundo plano e dos blueprints de cron. Não há outra fonte de "digest".
- **Dreaming do OpenClaw**: li a página de conceitos. Os arquivos de configuração e de código não foram lidos.
- **Anthropic / Claude Code, bloqueio de volta**: não encontrei regra que impeça um subagente de delegar de volta ao pai; a documentação fala de profundidade e de um nível em Managed Agents, não de ciclos.
- **OpenAI handoffs, limite padrão de `max_turns`** e regra de ciclo: não encontrados na leitura.
- **OpenBot**: só o README. Os documentos de canal e de delegação não foram lidos.
- **MAST**: li o texto principal e as tabelas. Não reli os apêndices de anotação do LLM-juiz.
- **Custo real** de um supervisor no Suup: não há medida; os números (4×, 15×) são de sistemas de pesquisa da Anthropic.

## Implicação para o Suup

Inferências, a menos que indicado. Nenhuma mudança de código ou de documentação foi feita nesta pesquisa; o que segue é para decisão do dono.

| Ponto | Proposta (inferência) | Base nesta pesquisa | Decisão do dono ou documento a mudar |
|---|---|---|---|
| Papel do Principal | Bot comum, marcado como principal (já existe `isDefault`, FRONTEND.md:31), com instruções de supervisor; ferramentas `delegate`, `message_bot` (PLANO.md:136) e leitura de memória dos outros | Anthropic MARS (orquestrador-trabalhador); Managed Agents (subagentes com thread própria) | Confirmar que o Principal ganha a leitura descrita abaixo |
| Contrato do `delegate` | Objetivo, critérios de pronto, formato de saída, contexto explícito e limites; sem histórico completo | MARS ("objective, an output format, ... clear task boundaries"); Hermes ("Each child sees only its own context"); `output_schema` do Hermes | PLANO.md:146 ganha campos. Nenhuma mudança de decisão |
| Execução do delegado | Execução com origem `delegated` (já prevista) em segundo plano, na conversa do delegado, com evento de volta na conversa do Principal (notificação e resumo) | Hermes e OpenClaw (entrega assíncrona); MARS (síncrono é gargalo) | Usar os mecanismos de execução e caixa já existentes (PLANO.md:56, 365-371) |
| Permissões do delegado | O delegado mantém as próprias ferramentas e aprovações; o cartão vai ao usuário. Nada de aprovação herdada do Principal | OpenBot (`approvalPolicy: never`, por contraste); Hermes (filhos negam por padrão); Claude Code (aprovação em background passa pela sessão) | Confirma APROVACOES.md. Sem mudança |
| Profundidade | Profundidade 1: delegado não delega de volta. Pode-se abrir depois com teto explícito | Managed Agents ("One level"); Hermes (padrão 1); OpenClaw (padrão 5, configurável) | Decisão do dono sobre o padrão |
| Concorrência e custo | Teto de delegações simultâneas por Principal, orçamento de tokens por delegação (já existe o orçamento diário de iniciativa, PLANO.md:334), métrica de custo por execução | Hermes (`max_concurrent_children`: 10); Managed Agents (orçamento por sessão); MARS (15× custo) | Escolher os números |
| Leitura de memória alheia | Ferramenta somente-leitura `team_status` / `recall_de_bot` do Principal sobre notas, diário e atividade recente dos outros bots; devolve trechos com data e origem | OpenClaw (validação de cadeia de pais e acesso por host); Hermes (memória por bot); Claude Code (memória por agente) | MEMORIA.md:11-12 e :20 dizem que notas e diário são "Só aquele bot". Mudar exige decisão do dono e atualização de MEMORIA.md |
| Escrita de memória alheia | Proibida. O Principal escreve só as próprias notas e follow-ups; mudanças em outro bot passam pelo dono daquele bot | OpenClaw (fase deep grava só com prova de origem; light e REM não gravam); Hermes (revisão só pela lista) | Confirmar. MEMORIA.md:20 continua válido |
| Revisão noturna | Rotina interna do Principal (já prevista como "Revisão periódica", PLANO.md:308), um horário fixo, modelo barato, janela de tempo e teto de custo | OpenClaw dreaming (`0 3 * * *`, modelo próprio, fila em segundo plano com `maxConcurrent`); arXiv:2504.13171 | Escolher horário e modelo |
| O que a revisão lê | Diário estruturado (resultado, origem, hora, id) e notas aprovadas; execuções de rotina e de delegação ficam de fora por padrão; nunca saída bruta de ferramenta | OpenClaw ("Only interactive sessions", "Tool output... excluded"); APROVACOES.md:100 | Decidir se rotinas entram |
| Resumo do `finish` no diário | Tratar como dado, não instrução; marcar como não confiável na leitura | MEMORIA.md:47 (resumo escrito pelo bot); OpenClaw (proveniência `untrusted` removida) | Decisão do dono se mudar o formato do diário |
| Segredo na revisão | Risco maior: a revisão lê mais texto. Sem detecção por padrão (MEMORIA.md:51), a proteção é estrutural: não ler ferramentas nem mensagens de terceiros | OpenClaw ("not secret-masked before ingestion") | Decisão do dono; nada de regex (CLAUDE.md) |
| Lembretes | Padrão silencioso: a revisão só fala quando há o que dizer (`[SILENT]`); um resumo fixo de manhã só se o dono pedir | Hermes (`[SILENT]`, morning briefing); x.ai ("Most runs... produce nothing") | Canal: mensagem na conversa do Principal ou notificação. Decisão do dono |
| Estrela no avatar | Badge visual no avatar do Principal. Não há fonte pública de Grok com estrela | Não encontrado na fonte da xAI | DESIGN.md diz que o avatar fica calmo (RETORNO.md:24). Mudança de aparência exige atualizar DESIGN.md no mesmo commit (CLAUDE.md) e decisão do dono |
| Medidas | Taxa de delegações concluídas sem reenvio; tokens e custo por delegação (multiplicador frente a um turno simples); aceitação de lembretes; recusas do revisor | MARS (taxa de sucesso e multiplicador de tokens); MAST (falhas de verificação e de desalinhamento) | PLANO.md:294 (métricas por modelo); incluir métricas por delegação |
| Falhas a testar | Delegado que reinicia a tarefa sem contexto; Principal que confia no resumo sem evidência; delegação em círculo (com profundidade 1 não ocorre); lembrete em excesso | MAST (FC2 e FC3: 32,3% e 23,5%); MARS (duplicação de trabalho) | PLANO.md:495 (avaliação) acrescenta esses casos |
