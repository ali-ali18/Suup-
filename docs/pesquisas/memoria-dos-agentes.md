# Pesquisa: memória dos agentes (o que o modelo guarda, como busca, como é atacada)

Data da pesquisa: 19/11/2026. Serve à seção 4.6 do [PLANO.md](../PLANO.md) e ao desenho descrito em [MEMORIA.md](../MEMORIA.md). Ver também [pesquisas/README.md](README.md).

## Pergunta

Como os produtos atuais e a pesquisa tratam a memória de agentes de IA: o que fica sempre no contexto, o que é buscado, como a busca é feita (palavras ou vetores) e o que a pesquisa mede sobre isso; o que o modelo pode escrever sozinho e o que o usuário vê, aprova, corrige ou apaga; e quais são os ataques conhecidos contra memória, como injeção persistente vinda de conteúdo que o agente leu. A partir disso, o que muda no Suup.

## Desenho atual do Suup (lido no repositório)

Lido em 19/11/2026 em `docs/MEMORIA.md`, `docs/PLANO.md` (seção 4.6) e no código citado.

- **Quatro camadas.** Regra e perfil entram em toda execução, no prompt do sistema (`Standing rules from the user` e `What you know about the user`). Nota (por bot) e diário (por bot, escrito pelo sistema) são buscados com `recall`. O texto integral das conversas é buscado com `search_conversations`.
- **Busca.** PostgreSQL com `websearch_to_tsquery` (`packages/db/src/memories.ts`, perto da linha 266) e `unaccent` quando a extensão existe. **Não há embeddings.** A coluna `embedding_ready` existe, e a migração 0003 diz que o vetor "chega junto com o provedor de embeddings, numa migração própria" (`packages/db/migrations/0003_conversations_and_memory.sql`, linhas 110 a 113). O `PLANO.md` fala em busca por relevância com `pgvector`: a divergência é intencional no código, não foi confirmada como decisão.
- **Escrita pelo bot.** A ferramenta `remember` (`packages/tools/src/remember.ts`) grava `rule`, `profile` ou `note`, com risco declarado `write_reversible`. A descrição pede "Do NOT save secrets". **Não há verificação de segredo no código dessa ferramenta.**
- **Revisor por modelo.** Em modo `auto_review`, chamadas que não são `read` e que não são decididas antes pelas regras vão ao revisor de aprovações (condições em `packages/core/src/approvals/gate.ts`, perto das linhas 190 a 197). Não segui essa cadeia até o fim para o `remember` em particular. O revisor vê "the user's own messages, the user's written rules and the PROPOSED call, never a tool result" (`packages/core/src/approvals/model-reviewer.ts`, cabeçalho). Ou seja: uma escrita de memória pelo bot já passa, em princípio, por um modelo, mas esse modelo não vê de onde veio o conteúdo.
- **Regra do projeto.** Nada de regex para classificar texto no harness (`CLAUDE.md`, `docs/REGRAS.md`). O `CLAUDE.md` também diz que, na dúvida, pergunta ao dono.
- **Inconsistência encontrada.** A última seção de `docs/MEMORIA.md` ("O que o bot nunca deve guardar") diz que "A ferramenta `remember` recusa texto que pareça uma credencial". O código lido não tem essa recusa. As seções anteriores do mesmo arquivo dizem que a detecção por padrão foi removida. Fica para o dono decidir qual é o comportamento e corrigir o texto.

## Fontes

Todas lidas em 19/11/2026, salvo quando indicado. "Sem data" significa que a página não mostra data de publicação.

Anthropic (API, Claude Code, produto Claude):

- Memory tool (API): https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool (sem data)
- Context editing (API, beta): https://platform.claude.com/docs/en/build-with-claude/context-editing (sem data)
- Embeddings (API), página que diz que a Anthropic não oferece modelo próprio: https://platform.claude.com/docs/en/build-with-claude/embeddings (sem data)
- "Effective context engineering for AI agents" (engenharia, sem data na página): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- "Effective harnesses for long-running agents" (engenharia, sem data na página): https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- "Mitigating prompt injections in browser use" (pesquisa, sem data; cita Claude Opus 4.5): https://www.anthropic.com/research/prompt-injection-defenses
- Claude Code, "How Claude remembers your project" (CLAUDE.md e auto memory; sem data): https://code.claude.com/docs/en/memory
- Central de ajuda do Claude, "Use Claude's chat search and memory to build on previous context" (sem data; traz datas de 2026 sobre planos): https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- Claude Code, "How we built Claude Code auto mode" (publicado em 25/03/2026, citado na pesquisa anterior, não reaberto aqui): https://www.anthropic.com/engineering/claude-code-auto-mode

OpenAI:

- ChatGPT, páginas de ajuda sobre memória (help.openai.com, artigos 8590148 e 8983136): **não verificado (host bloqueado)**. A conexão retornou CONNECT 403. Tentativa feita em 19/11/2026.
- openai.com, página de anúncio de memória do ChatGPT: **não verificado (host bloqueado)**, mesma razão.
- OpenAI Agents SDK, JavaScript, "Sessions": https://openai.github.io/openai-agents-js/guides/sessions/ (sem data)
- OpenAI Agents SDK, Python, "Sessions": https://openai.github.io/openai-agents-python/sessions/ (sem data; a página de `openai.github.io` mostrou o título "Overview", mas o conteúdo é a documentação de sessões)

Outros produtos:

- Gemini CLI, "Provide context with GEMINI.md files" (raw do repositório): https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/gemini-md.md (sem data)
- Gemini CLI, "Memory files" (raw do repositório): https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/memory.md (sem data)
- Gemini CLI, "Manage context and memory" (tutorial, raw): https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/tutorials/memory-management.md (sem data)
- GitHub Copilot, "About GitHub Copilot Memory" (sem data na página): https://docs.github.com/en/copilot/concepts/agents/copilot-memory
- Cursor, "Rules" (sem data): https://cursor.com/docs/context/rules (a URL de memórias, https://cursor.com/docs/context/memories, devolveu o mesmo conteúdo de Rules; ver "Não verificado")
- OpenCode, "Instructions" (sem data): https://opencode.ai/docs/rules/

Pesquisa (arXiv; datas de submissão conforme a página `abs`):

- MemGPT, arXiv:2310.08560 (12/10/2023): https://arxiv.org/abs/2310.08560
- Generative Agents, arXiv:2304.03442 (07/04/2023): https://arxiv.org/abs/2304.03442
- Mem0, arXiv:2504.19413 (28/04/2025): https://arxiv.org/abs/2504.19413 (texto completo lido em https://arxiv.org/html/2504.19413)
- A-MEM, arXiv:2502.12110 (17/02/2025): https://arxiv.org/abs/2502.12110 (só resumo)
- LongMemEval, arXiv:2410.10813 (14/10/2024): https://arxiv.org/abs/2410.10813 (texto completo lido em https://arxiv.org/html/2410.10813)
- Zep, arXiv:2501.13956 (20/01/2025): https://arxiv.org/abs/2501.13956 (texto completo lido em https://arxiv.org/html/2501.13956)
- LoCoMo, arXiv:2402.17753 (27/02/2024): https://arxiv.org/abs/2402.17753 (só resumo)
- AgentPoison, arXiv:2407.12784 (17/07/2024): https://arxiv.org/abs/2407.12784 (só resumo)
- Agent Security Bench (ASB), arXiv:2410.02644 (03/10/2024): https://arxiv.org/abs/2410.02644 (só resumo)
- MINJA, "Memory Injection Attacks on LLM Agents via Query-Only Interaction", arXiv:2503.03704 (05/03/2025): https://arxiv.org/abs/2503.03704 (texto completo lido em https://arxiv.org/html/2503.03704)

## Fatos verificados

### 1. API da Anthropic: a ferramenta de memória

- A memória é um diretório de arquivos sob `/memories`, operado pelo cliente: "The memory tool operates client-side: Claude requests file operations, and your application runs them." (https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- Comandos documentados: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. O modelo pede a operação; a aplicação decide onde e como guardar.
- A própria API acrescenta instruções ao prompt do sistema quando a ferramenta está presente: "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE." (mesma página)
- Sobre informação sensível: "Claude usually refuses to write sensitive information to memory files. For stronger guarantees, add validation that strips sensitive data before your handler writes the file." (mesma página). A garantia fica com a aplicação, não com o modelo.
- Caminhos: "A malicious path such as /memories/../../secrets.env can reach files outside the /memories directory. Your implementation must validate every path in every command to prevent directory traversal attacks." (mesma página)
- Recomendações de segurança da própria página: limitar o tamanho dos arquivos, "Periodically delete memory files that haven't been accessed in a long time" (expiração) e validar tudo que a aplicação grava.
- Disponível "on all Claude 4 and later models" (mesma página).

### 2. API da Anthropic: edição de contexto e compactação

- Edição de contexto (beta, cabeçalho `context-management-2025-06-27`) é feita no servidor: "Context editing is applied server-side before the prompt reaches Claude. Your client application maintains the full, unmodified conversation history." (https://platform.claude.com/docs/en/build-with-claude/context-editing)
- Com a ferramenta de memória, a própria página descreve um aviso automático: "When your conversation context approaches the configured clearing threshold, Claude receives an automatic warning to preserve important information." (mesma página)
- A página diz que, para a maioria dos casos, "server-side compaction is the primary strategy for managing context in long-running conversations." (mesma página)

### 3. Engenharia da Anthropic: contexto e memória de longa duração

- Sobre recuperação: "Today, many AI-native applications employ some form of embedding-based pre-inference time retrieval to surface important context for the agent to reason over. As the field transitions to more agentic approaches, we increasingly see teams augmenting these retrieval systems with 'just in time' context strategies." (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Sobre o Claude Code: "CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep allow it to navigate its environment and retrieve files just-in-time" (mesma página). Ou seja, o modo híbrido: algo sempre no contexto, o resto buscado.
- Sobre notas: "Structured note-taking, or agentic memory, is a technique where the agent regularly writes notes persisted to memory outside of the context window." (mesma página)
- Em agentes que trabalham em sessões: "each new session begins with no memory of what came before." (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents). A solução descrita é um arquivo de progresso e o histórico do git, com uma funcionalidade por vez (mesma página).

### 4. Claude Code: memória e CLAUDE.md

- Onde entra: "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself." E: "there's no guarantee of strict compliance, especially for vague or conflicting instructions." (https://code.claude.com/docs/en/memory)
- Auto memory: "The first 200 lines of MEMORY.md, or the first 25KB, whichever comes first, are loaded at the start of every conversation." Os arquivos de tópico "don't load ... at startup". O modelo os lê quando precisa (mesma página).
- Limite e aviso: "If the file is over a limit, the write still succeeds, but Claude Code returns an error telling Claude to rewrite the index, because everything past the limit is dropped on the next load." (mesma página)
- O que não se guarda: "Claude skips anything it can derive from the codebase, such as architecture, file paths, or debugging fixes." E: "Claude doesn't save something every session." (mesma página)
- Quem vê e corrige: "Auto memory files are plain markdown you can edit or delete at any time." Há um comando `/memory` para isso (mesma página).
- Escopo: "Auto memory is machine-local." O diretório é por projeto, e worktrees do mesmo repositório compartilham (mesma página).
- Subagentes: "The main conversation's auto memory isn't loaded into subagents" (mesma página).

### 5. Aplicativo Claude: memória (ajuda oficial)

- Como guarda: "Claude saves memory as a set of individual topics as you chat, rather than summarizing conversations after they end." (https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
- Sensíveis fora por padrão: "By default, Claude does not store topics related to personal or sensitive subject matter, like your health, race, ethnicity, religious beliefs, politics, gender identity, and other similar areas." Quando o usuário liga a opção, "Each time Claude saves something on one of these topics, a notice appears above the message box so you can review it or update your settings." (mesma página)
- Nunca salvo: "Some information is never saved to memory, even if you ask. This includes government ID numbers, criminal history, financial account numbers, and immigration status." (mesma página)
- Projetos: "Each project has its own memory." Só a memória do projeto e a de chats fora de projetos entram (mesma página).
- Controle: "Pause memory" mantém a memória e não usa nem cria; "Reset memory" apaga tudo. Edita-se e apaga-se tópico por tópico: "Select any topic to read it, then use the edit icon to change it or select 'Delete' to remove it." (mesma página)
- Conversa apagada: "When a conversation is deleted, including under a retention period, memory entries generated from it aren't removed, but you can delete individual memories while memory is on." (mesma página)
- Administradores: "Owners can't view or edit a user's individual memories." (mesma página)
- Segurança: "We apply safeguards and conduct evaluations to memory to help keep users safe." A página não descreve os safeguards (mesma página).

### 6. Copilot (GitHub): memória de repositório e de usuário

Fonte: https://docs.github.com/en/copilot/concepts/agents/copilot-memory (sem data na página).

- Tipos: "repository facts" (ligados a um repositório) e "user-level preferences" (ligados a uma pessoa). "Copilot chooses whether a memory is a repository-level fact or a user-level preference. It bases that choice on who the memory applies to, rather than on who stated it."
- Origem e citação: "Copilot creates memories itself, as a byproduct of working with you." E: "When Copilot creates a memory as a result of something you said, your words are recorded as the citation for the memory."
- Quem pode criar: "Repository-level facts are only created when Copilot is working in a repository you have write access to".
- Não editável diretamente: "You cannot directly create or edit an individual memory in the settings on GitHub.com, but you can influence Copilot to create memories" (a edição fica para o Copilot, que pode importar em lote pela CLI).
- Validade contra o estado atual: "Copilot is instructed to check the citations provided with each memory before using it." Há votação interna; memórias "downvoted past a threshold are no longer used and will be deleted after a period of disuse."
- Validade no tempo: "The default expiry period is 90 days." Administradores podem configurar de 7 a 180 dias para fatos de repositório. Quando o Copilot usa a memória de novo, o prazo reinicia.
- Segredos e injeção: "Memories are checked for secrets, such as tokens, keys, or credentials. Memories in which a secret is detected are rejected and are not stored." E: "The system can reject memories that contain recognized model-control tokens, as a defense against prompt injection." E: "Copilot is instructed not to store sensitive personal information, confidential information, or anything shared in confidence." O método de detecção de segredo não é descrito na página.
- Escopo: "Repository facts are not pooled across an organization's repositories. Forking a repository does not copy its stored memories to the fork."
- Pull requests fechados: "Repository facts can be captured from pull requests that were closed without merging." Nota da própria página: o Copilot é instruído a checar esses fatos contra o código atual, "but this does not guarantee that it will recognize every outdated fact."

### 7. Gemini CLI

- Instruções em arquivos: "It loads various context files from several locations, concatenates the contents of all found files, and sends them to the model with every prompt." Os arquivos são `GEMINI.md`: global (`~/.gemini/GEMINI.md`), do projeto e de contexto sob demanda, "Just-in-time (JIT) context files" (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/gemini-md.md).
- Memória salva: "Gemini CLI persists durable facts, user preferences, and project details by editing Markdown memory files directly." E: "Storage: Edits Markdown files with `write_file` or `replace`." (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/memory.md). Ou seja, a escrita é uma edição de arquivo comum, não um comando dedicado. Não confirmei se existe uma ferramenta com outro nome, como `save_memory`.
- Comandos de conferência: `/memory show` e `/memory reload` (tutorial de memória, raw do repositório).
- A página de tutorial cita um "experimental Auto Memory feature to extract memory updates and reusable skills from your past sessions automatically", mas o link para `docs/auto-memory.md` devolveu 404 no raw do repositório. **Não verificado.**

### 8. OpenAI Agents SDK: sessões

- As sessões guardam o histórico, não um arquivo de memória: "Sessions give the Agents SDK a persistent memory layer." E: "Persists new user input and assistant output after each run completes." (https://openai.github.io/openai-agents-js/guides/sessions/)
- Sessão local: "MemorySession stores everything in local process memory, so it is reset when your process exits." (mesma página)
- Versão Python: `SQLiteSession` para guardar a conversa em arquivo (https://openai.github.io/openai-agents-python/sessions/).
- Ponto útil para o Suup: a SDK separa histórico (sessão) de memória de longo prazo. Não há, nas páginas lidas, uma camada de fatos do usuário com revisão.

### 9. Cursor e OpenCode

- Cursor, página de Rules: "Large language models don't retain memory between completions. Rules provide persistent, reusable context at the prompt level." (https://cursor.com/docs/context/rules). A página de memórias de Cursor **não foi verificada** (ver abaixo).
- OpenCode: "Add an AGENTS.md file to give OpenCode persistent project guidance." O arquivo é instrução do projeto, versionado, sem escrita automática de memória nas páginas lidas (https://opencode.ai/docs/rules/).

### 10. Pesquisa: MemGPT (arXiv:2310.08560)

- Propõe "virtual context management, a technique drawing inspiration from hierarchical memory systems in traditional operating systems". O modelo move dados entre contexto principal e armazenamento externo (busca de arquivo e registro de conversa), por chamadas de função (corpo do artigo, lido em https://arxiv.org/pdf/2310.08560).

### 11. Pesquisa: Generative Agents (arXiv:2304.03442)

- Recuperação por três fatores: "recency", "importance" e "relevance". A pontuação é uma combinação com pesos (todos iguais a 1 na implementação), depois de normalização para [0, 1] por escala mín-máx (corpo do artigo, lido em https://arxiv.org/pdf/2304.03442).
- Relevância por embeddings: "we calculate relevance as the cosine similarity between the memory's embedding vector and the query memory's embedding vector."
- Recência: "we treat recency as an exponential decay function over the number of sandbox game hours since the memory was last retrieved. Our decay factor is 0.995."
- Importância: o próprio modelo dá uma nota de 1 a 10 à memória.

### 12. Pesquisa: Mem0 (arXiv:2504.19413), texto completo

- Benchmark: LoCoMo, com dez conversas de cerca de 26.000 tokens cada (corpo do artigo).
- Resultado geral (J, avaliação por modelo, em %): "Mem0 reaches 67%—about a 10% relative improvement" sobre o melhor RAG (cerca de 61%). Mem0 com grafo: "over 68%". Contexto completo: "a full-context method that ingests a chunk of roughly 26,000 tokens still achieves the highest J score (approximately 73%)".
- Latência: contexto completo com p95 de cerca de 17 s; Mem0 com p95 de 1,44 s (corpo do artigo).
- Custo, como declarado pelos autores: "Mem0 attains a 91% lower p95 latency and saves more than 90% token cost" (resumo).
- Os números são dos próprios autores, em um benchmark de conversas. O artigo não compara, nesta leitura, com busca só por palavras.

### 13. Pesquisa: LongMemEval (arXiv:2410.10813): o dado mais direto sobre busca

- O benchmark tem 500 perguntas sobre históricos de chat, e avalia extração, raciocínio entre sessões, raciocínio temporal, atualização de conhecimento e abstenção. Resumo: "commercial chat assistants and long-context LLMs showing a 30% accuracy drop on memorizing information across sustained interactions" (resumo).
- Tabela 9 do artigo compara três recuperadores: BM25 (palavras), Contriever e Stella V5 1.5B (vetores). O texto diz: "Both dense retrieval embeddings have significantly higher performance than the BM25 sparse retrieval method. The trend is the same across most settings."
- Números de Recall@5, chave = valor, granularidade "session": BM25 0,634; Contriever 0,723; Stella 0,720. Com a chave expandida com fatos do usuário ("K = V + fact"): BM25 0,683; Contriever 0,762; Stella 0,732. (Tabela 9, texto completo.)
- **Mas a tendência não é uniforme.** No mesmo quadro, com chave expandida por fatos, NDCG@5: BM25 0,560; Contriever 0,632; Stella 0,520. O Stella, que tem o melhor Recall em algumas linhas, fica abaixo do BM25 em NDCG nessa configuração.
- Conclusão do próprio artigo: expandir a chave com fatos do usuário melhora em quase todas as configurações: "The recommended technique of performing key expansion with user fact consistently improves the performance over directly using the value as the key." Isso vale para todos os recuperadores testados, e é mais forte que a troca de palavras por vetores.

### 14. Pesquisa: Zep (arXiv:2501.13956), texto completo

- Zep faz busca híbrida: "Zep implements three search functions: cosine semantic similarity search, Okapi BM25 full-text search, and breadth-first search", e depois reordena (cita RRF e MMR; corpo do artigo).
- Resultados no LongMemEval_s, tabela do próprio artigo: contexto completo com gpt-4o-mini, 55,4% de acerto, média de 115k tokens de contexto, latência de 31,3 s; Zep com gpt-4o-mini, 63,8%, 1,6k tokens, 3,20 s.
- Os autores criticam o benchmark de recuperação que usaram antes: "The evaluation relies exclusively on single-turn, fact-retrieval questions that fail to assess complex memory understanding." (corpo do artigo). Os números são de um produto vendido pelos autores.

### 15. Ataques: envenenamento e injeção de memória

- **MINJA** (arXiv:2503.03704, 05/03/2025): o atacante injeta registros maliciosos "by only interacting with the agent via queries and output observations", sem acesso direto à memória (resumo). Resultado: "MINJA achieves a high average success rate of 98.2% for injecting malicious records into the memory, and a high average attack success rate of 76.8% in eliciting the malicious reasoning steps." (corpo do artigo). A conclusão do resumo: "With minimal requirements for execution, MINJA enables any user to influence agent memory."
- Defesas testadas pelo MINJA (corpo do artigo, seção 5.4): "Embedding-level memory sanitization, which attempts to identify malicious records post hoc (e.g., via embedding filtering), is conceptually feasible but fails in practice." Sobre detecção por prompt: "prompts that are precise lack generality, while general prompts may incur high false positives." E sobre decaimento temporal: "temporal decay of memory typically weakens all memory poisoning attacks by reducing the impact of earlier injected records, our attack remains effective".
- **AgentPoison** (arXiv:2407.12784, 17/07/2024): envenena a memória de longo prazo ou a base RAG com gatilho; "On each agent, AgentPoison achieves an average attack success rate higher than 80% with minimal impact on benign performance (less than 1%) with a poison rate less than 0.1%." (resumo).
- **ASB** (arXiv:2410.02644, 03/10/2024): o benchmark inclui "a memory poisoning attack", além de 10 ataques de injeção de prompt; a maior taxa média de sucesso registrada no resumo é "84.30%" (no original, com ponto decimal). O resumo diz que as defesas testadas têm "limited effectiveness".
- **Injeção de conteúdo** (Anthropic, pesquisa de navegação): "We scan all untrusted content that enters the model's context window, and flag potential prompt injections with classifiers." E: "A 1% attack success rate—while a significant improvement—still represents meaningful risk." (https://www.anthropic.com/research/prompt-injection-defenses). Esta página trata de navegação, não de memória, mas o princípio vale: conteúdo que entra no contexto é não confiável.
- **Desenho do revisor de ações da Anthropic** (lido na pesquisa anterior): o classificador não vê as saídas das ferramentas, porque "stripping tool results is the primary prompt-injection defense, since tool outputs are where hostile content enters the context" (https://www.anthropic.com/engineering/claude-code-auto-mode, citado em [fase-3-auto-review-regras-escritas.md](fase-3-auto-review-regras-escritas.md)).

### 16. Vetores: fornecedores de embeddings

- "Anthropic does not offer its own embedding model. One embeddings provider with a wide variety of models and capabilities is Voyage AI by MongoDB." (https://platform.claude.com/docs/en/build-with-claude/embeddings). Ou seja: para vetores, o Suup depende de um provedor externo, e o texto da memória sairia para ele.

### 17. Outros dados de pesquisa

- A-MEM (arXiv:2502.12110, resumo): organiza memórias como notas interligadas, com palavras-chave e tags, e atualiza notas antigas quando chega uma nova ("memory evolution"). Os números do artigo **não foram lidos**.
- LoCoMo (arXiv:2402.17753, resumo): "Employing strategies like long-context LLMs or RAG can offer improvements but these mo[dels]..." O resumo indica que os modelos têm dificuldade com conversas longas, e que contexto longo e RAG ajudam. Os números completos **não foram lidos**.

## Fatos sobre o que o produto faz com a memória que o modelo escreve

Resumo dos fatos acima, na pergunta 6 do pedido:

| Pergunta | O que os produtos documentam |
|---|---|
| Sempre visível ao usuário? | Claude app: sim, por tópico, com edição e exclusão. Copilot: sim, na página de configurações, mas sem edição direta (só exclusão). Claude Code: sim, arquivos em texto. Gemini CLI: sim, arquivos Markdown. API (memory tool): depende da aplicação. |
| Confirmação antes de guardar? | Claude app: não para a maioria; para temas sensíveis, há aviso depois de salvar ("a notice appears above the message box") e só se o usuário ligou a opção. Copilot: não; o Copilot cria sozinho. Gemini CLI: o usuário pede ("Remember that..."). Claude Code: a memória automática é gravada sem pergunta, mas o usuário pode editar. |
| Escopo por projeto ou bot? | Claude app: por projeto. Claude Code: por projeto, por máquina. Copilot: por repositório (fatos) e por pessoa (preferências); fatos não se espalham entre repositórios. Gemini CLI: arquivo global ou de projeto. |
| Expiração ou decaimento? | Copilot: 90 dias sem uso, configurável de 7 a 180 dias pela organização, reinicia quando a memória é usada. API da Anthropic: recomenda apagar arquivos não usados há muito tempo. Claude app: pode ser apagada por política de retenção da organização. |
| Consolidação ou resumo? | Claude app: guarda por tópicos "rather than summarizing conversations after they end". Claude Code: o índice é limitado a 200 linhas ou 25 KB, e o modelo é avisado para reescrevê-lo. API: a aplicação deve limitar o tamanho. |
| Segredos e dados sensíveis? | Copilot: verificação de segredo, com rejeição, e recusa de tokens de controle do modelo como defesa contra injeção. Claude app: temas sensíveis desligados por padrão; certas informações nunca são guardadas. API: "Claude usually refuses"; a aplicação deve validar. |

## Inferências

Cada item abaixo é inferência minha a partir dos fatos acima, não fato de fonte.

1. **Manter as quatro camadas, com um limite de tamanho explícito nas duas que entram sempre.** Regra e perfil vão para todo prompt. A Anthropic (API) e a Claude Code tratam o que entra sempre como um orçamento pequeno: a Claude Code mede 200 linhas ou 25 KB. Inferência: definir um teto de caracteres para regras e perfil somados, e avisar o bot (e o usuário) quando passar. Notas e diário podem crescer, porque são buscados.
2. **Busca: manter o PostgreSQL com palavras agora, medir antes de adicionar vetores.** O LongMemEval mostra vantagem de recuperadores vetoriais sobre BM25 no Recall, mas não em todas as configurações (NDCG do Stella abaixo do BM25 com chave expandida). O Zep usa busca híbrida (vetor, palavras e grafo) e reordena. Inferência: a melhor escolha provável é híbrida (palavras e vetores, fundidos por RRF), mas só depois de medir a falha real do FTS. Antes de `pgvector`, escolher um provedor de embeddings (a Anthropic não tem um) e decidir se o texto da memória pode sair para ele. A coluna `embedding_ready` já existe e não atrapalha.
3. **Expandir a chave com fatos, antes de vetores.** O LongMemEval mostra ganho consistente com a expansão da chave por fatos do usuário, em todos os recuperadores. Inferência: o Suup pode gravar, ao lado de cada nota, uma frase curta com o fato (que é o que o `remember` já faz com um texto de uma frase). Isso custa pouco e é verificável.
4. **Escritas do bot: quem revisa e o que o revisor vê.** O revisor atual (`model-reviewer.ts`), pelas condições lidas em `gate.ts`, pode receber escritas `write_reversible` em modo `auto_review`, mas vê só as mensagens do usuário e a chamada proposta, nunca o resultado de uma ferramenta. Isso impede que ele veja o conteúdo que causou a escrita, e também impede que ele perceba que a regra veio de uma página lida. Inferência: para `rule` e `profile`, a escrita deveria ficar **pendente** até o usuário confirmar, e só então entrar no prompt do sistema. Para `note`, o revisor modelo pode continuar decidindo. O revisor deveria receber o texto proposto, a camada, o escopo e um **sinal de proveniência** (esta execução leu conteúdo externo? qual ferramenta?), sem o conteúdo lido, que é a regra de Anthropic (tool outputs fora do revisor).
5. **Defesa contra envenenamento vindo de ferramentas: estrutura, não detecção.** O MINJA mostra que filtro por embedding falha, e detecção por prompt é imprecisa (muitos falsos positivos quando geral; não cobre quando específico). Inferência: as defesas que valem são estruturais: (a) memória escrita por execução que leu conteúdo externo não vira regra nem perfil sem confirmação; (b) toda memória guarda a origem (já guarda: execução, conversa e mensagem); (c) ao devolver a busca ao bot, o texto da memória vem marcado como dado, não como instrução; (d) uma memória escrita pelo bot com escopo compartilhado valerá para todos os bots, então o padrão para escrita do bot deve ser escopo do bot.
6. **Segredos: o projeto não deve usar padrão, mas pode usar o modelo.** As regras do projeto proíbem regex para classificar texto, mas permitem "o modelo". Inferência: a verificação de segredo nas escritas pode ser feita pelo revisor modelo (pergunta fechada: "isto é uma credencial, senha ou dado pessoal sensível?"), com comparação exata contra o cofre (já existe) como segunda camada. Isso também resolveria a inconsistência de `docs/MEMORIA.md`, que promete uma recusa que o código não tem. Não é possível garantir que um modelo pegue todo segredo; o Copilot também não descreve o método, e a Anthropic diz "usually".
7. **Expiração e consolidação.** Copilot (90 dias, reinício pelo uso) e a Anthropic (apagar o que não é usado) mostram que a validade deveria ser por uso, não por data de criação. Inferência: o diário poderia expirar (por exemplo, depois de N dias sem ser buscado), mas regras e perfil não expiram sem aviso ao usuário. Consolidação: quando as notas de um bot passarem de um limite, um passo de resumo (com o modelo) pode propor fundir entradas, e o usuário aprova. Isso evita o crescimento silencioso que a Claude Code trata com o limite de 200 linhas.
8. **Conteúdo de ferramenta no diário.** O diário guarda o resumo do `finish` escrito pelo bot. Se o bot resumiu uma página maliciosa, o diário leva a injeção para as próximas buscas. Inferência: o `recall` deve devolver o diário com rótulo de origem "registro de execução" e nunca como instrução; a mesma regra vale para notas.
9. **O que medir antes de mudar a busca.** Um conjunto pequeno de perguntas sobre o próprio histórico do Suup (sem dados pessoais no repositório, como manda o `CLAUDE.md`), com categorias: fato, atualização de fato, pergunta temporal, "não sei" (abstenção), e pergunta entre sessões. Métricas: Recall@5 e NDCG@5 da busca, e acerto da resposta final, por três configurações: FTS atual, híbrido e contexto completo. Um segundo conjunto para envenenamento: uma página com instrução escondida, medindo se o bot grava regra ou perfil e com que frequência. Medir também tokens por execução, para comparar com o contexto completo, que o Mem0 e o Zep mostram ser caro.

## O que não foi verificado

- **ChatGPT (memória salva e histórico de conversas):** `help.openai.com` e `openai.com` devolveram CONNECT 403 no proxy (**não verificado, host bloqueado**). Não há, nesta pesquisa, nenhuma fonte primária sobre a memória do ChatGPT.
- **Cursor, memórias:** `https://cursor.com/docs/context/memories` devolveu o conteúdo da página de Rules. A funcionalidade de memória de Cursor **não foi verificada**.
- **Gemini CLI, `save_memory`:** não confirmei o nome de uma ferramenta dedicada. A documentação lida fala em editar arquivos com `write_file` e `replace`. O "Auto Memory" experimental **não foi verificado** (o link `docs/auto-memory.md` devolveu 404).
- **Gemini CLI, página em github.com (visualização de arquivo):** retornou 403; usei o raw do mesmo arquivo em `raw.githubusercontent.com`.
- **Datas:** as páginas da Anthropic, do GitHub e da Cursor não mostram data de publicação. Consta apenas a data de leitura, 19/11/2026.
- **Números de Mem0 e Zep:** são dos próprios autores, em LoCoMo e LongMemEval_s. Não os reproduzi. O LoCoMo tem dez conversas no caso do Mem0; a amostra é pequena.
- **A-MEM e LoCoMo:** só o resumo foi lido. Os números completos **não foram verificados**.
- **Preço de embeddings:** o custo por token de um provedor de vetores (por exemplo, Voyage) **não foi verificado**. Não li a página de preços.
- **Comportamento das memórias de Claude Code em injeção:** a documentação não descreve defesa contra injeção no auto memory. **Não verificado.**
- **Copilot, método de detecção de segredo:** a página diz que há verificação, mas não diz como. **Não verificado.**
- **Suup, caminho de aprovação do `remember`:** li a declaração de risco (`write_reversible`) e o revisor, mas **não segui o caminho completo** de uma escrita de `remember` até a decisão do revisor, nem testei o modo `ask_all` ou regras de aprovação específicas.
- **Documentação de OpenCode e AGENTS.md:** li só a página de instruções. Não há menção a memória automática nela.

## Implicação para o Suup

Tudo abaixo é inferência, a ser confirmada pelo dono antes de virar tarefa.

| Decisão | Recomendação (inferência) | Base nesta pesquisa |
|---|---|---|
| Manter as quatro camadas? | Manter. Acrescentar teto de tamanho para regra e perfil somados, com aviso ao bot e ao usuário quando passar. | Claude Code: índice de 200 linhas ou 25 KB carregado sempre; API: limitar tamanho de arquivo. |
| Busca semântica agora? | Não agora. Medir primeiro (item 9). Se o Recall do FTS for baixo nas perguntas de "fato" e de "atualização", adicionar híbrido (palavras e vetores, fusão por RRF), não vetores puros. | LongMemEval: vetor > BM25 no Recall, mas não em NDCG com chave por fatos. Zep: híbrido. |
| Provedor de embeddings | Antes de `pgvector`, decidir o provedor e o que sai do banco. A Anthropic não tem modelo de embeddings. | Página de embeddings da Anthropic. |
| Expandir a chave com fatos | Gravar, junto de cada nota, uma frase curta com o fato. Custa pouco e é a técnica com ganho mais consistente. | LongMemEval, Tabela 9: "consistently improves". |
| Escrita do bot em `rule` e `profile` | Pendente até o usuário confirmar; só então entra no prompt do sistema. | Claude app: temas sensíveis com aviso; Copilot: rejeição e verificação de citação. Ataques: MINJA e AgentPoison escrevem na memória sem acesso direto. |
| Escrita do bot em `note` | Pode continuar automática, passando pelo revisor modelo. | Revisor atual já cobre `write_reversible` em `auto_review`. |
| O que o revisor de memória vê | Texto proposto, camada, escopo, mensagens do usuário, e um sinal de proveniência (a execução leu conteúdo externo? qual ferramenta?). Não o conteúdo lido. | Anthropic (auto mode): revisor sem saídas de ferramenta. |
| Defesa contra envenenamento por ferramenta | (a) Execução que leu conteúdo externo não grava regra ou perfil sem confirmação; (b) escrita do bot tem escopo do bot por padrão; (c) recall marca o texto como dado; (d) origem sempre gravada. Não confiar em detecção por prompt ou embedding. | MINJA: filtros por embedding falham; prompts de detecção são imprecisos; decaimento não basta. |
| Segredos nas escritas | Verificação pelo revisor modelo (pergunta fechada), e comparação exata com o cofre. Corrigir `docs/MEMORIA.md`, que promete uma recusa que o código não tem, na mesma mudança. Sem regex. | Copilot rejeita segredos; Anthropic: "usually refuses" e pede validação na aplicação; regra do projeto permite o modelo. |
| Expiração e consolidação | Diário: expirar por falta de uso. Regra e perfil: nunca expirar sem aviso. Notas: passo de consolidação proposto pelo modelo e aprovado pelo usuário quando passar do limite. | Copilot: 90 dias, reinício pelo uso; Claude Code: limite de índice; API: apagar o que não é usado. |
| Conteúdo de ferramenta no diário | O diário e as notas voltam no `recall` marcados como registro, nunca como instrução. | Anthropic (injeção): todo conteúdo que entra no contexto é não confiável. |
| O que medir | Conjunto de perguntas sobre o histórico do Suup, sem dados pessoais no repositório, com as categorias do item 9; e um conjunto de envenenamento. Medir Recall@5, NDCG@5, acerto e tokens. | LongMemEval (métricas e categorias); Mem0 e Zep (custo de contexto completo). |
| Edição pelo usuário | Manter. É o que a Claude app oferece por tópico; o Copilot não permite edição direta, e isso é um ponto fraco dele. | Claude app; Copilot (edição direta não disponível). |
