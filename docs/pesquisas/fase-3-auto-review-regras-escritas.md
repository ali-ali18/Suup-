# Pesquisa: revisor automático por modelo com regras escritas em linguagem natural

Data da pesquisa: 19/11/2026. Valida a entrega de aprovações da fase 3 (ver [pesquisas/README.md](README.md) e [APROVACOES.md](../APROVACOES.md)).

## Pergunta

Como produtos atuais e a pesquisa fazem um modo "Auto-review": antes de cada chamada de ferramenta que não seja claramente segura, um modelo barato decide entre executar ou parar e perguntar ao usuário, usando regras que o próprio usuário escreve em linguagem natural (ex.: "Permitir sem perguntar: e-mails para minha equipe em acme.com"; "Sempre perguntar: apagar arquivos fora da pasta do projeto"), em vez de regras de igualdade exata ou de padrão? Como mantêm isso seguro?

## Fontes

Lidas diretamente em 19/11/2026, salvo quando indicado.

Claude Code (Anthropic):

- Anthropic, "How we built Claude Code auto mode: a safer way to skip permissions" (publicado em 25/03/2026): https://www.anthropic.com/engineering/claude-code-auto-mode
- Claude Code, "Choose a permission mode" (documentação, sem data; contém "How the classifier evaluates actions", "When auto mode falls back", "Cost and latency"): https://code.claude.com/docs/en/permission-modes
- Claude Code, "Configure auto mode" (documentação, sem data; `autoMode.environment`, `allow`, `soft_deny`, `hard_deny`): https://code.claude.com/docs/en/auto-mode-config
- Claude Code, "Permissions" (documentação, sem data): https://code.claude.com/docs/en/permissions (lida, sem trecho citado)

OpenAI (Codex):

- Documentação de approvals e sandbox do Codex em developers.openai.com/codex: **não verificado (host bloqueado)**. A tentativa retornou falha de resolução de nome (ENOTFOUND) na ferramenta de busca e CONNECT 403 no curl.
- Repositório `openai/codex`, arquivo `docs/config.md` (lido em 19/11/2026 via raw.githubusercontent.com): https://raw.githubusercontent.com/openai/codex/main/docs/config.md. Só aponta para a documentação bloqueada e fala de hooks de ciclo de vida (`allow_managed_hooks_only` em `requirements.toml`). Não trata de aprovações.

xAI (Grok):

- x.ai e docs.x.ai: **não verificado (host bloqueado)**. x.ai devolveu página de bloqueio do Cloudflare; docs.x.ai falhou com CONNECT 403.

Gemini CLI (Google):

- Gemini CLI, "Policy engine" (documentação, sem data): https://geminicli.com/docs/reference/policy-engine/
- Gemini CLI, "Sandboxing" (documentação, sem data): https://geminicli.com/docs/cli/sandbox/ (lida; só o que está no título e na abertura)

Cursor:

- Cursor, "Agent" / terminal (documentação, sem data): https://cursor.com/docs/agent/tools/terminal. A página de run modes (`/docs/agent/tools/run-modes`) retornou 404 e não foi lida.

GitHub Copilot:

- GitHub Docs, "About GitHub Copilot coding agent" (documentação, sem data): https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent

Pesquisa (arXiv):

- CaMeL, "Defeating Prompt Injections by Design", arXiv:2503.18813 (submetido em 24/03/2025; v2 em 24/06/2025): https://arxiv.org/abs/2503.18813
- AgentDojo, arXiv:2406.13352 (submetido em 19/06/2024; v3 em 24/11/2024): https://arxiv.org/abs/2406.13352
- The Task Shield, arXiv:2412.16682 (submetido em 21/12/2024): https://arxiv.org/abs/2412.16682
- Reliable Weak-to-Strong Monitoring of LLM Agents, arXiv:2508.19461 (submetido em 26/08/2025): https://arxiv.org/abs/2508.19461
- Adaptive Attacks on Trusted Monitors Subvert AI Control Protocols, arXiv:2510.09462 (submetido em 10/10/2025; v2 em 02/03/2026): https://arxiv.org/abs/2510.09462
- RAG-MCP, arXiv:2505.03275 (já usado na pesquisa de ferramentas MCP; só o resumo): https://arxiv.org/abs/2505.03275

Não lidos: os demais resultados de busca no arXiv sobre "LLM judge" e "action guard" (identificadores 2606.08539, 2608.16393, 2609.06972, 2610.27620). Apareceram só como identificadores; títulos e resumos não foram lidos.

Nota de processo: uma chamada `gh api` para listar a documentação do repositório Codex foi negada pelo classificador de permissões do ambiente. Não foi repetida por outro caminho.

## Fatos verificados

### 1. Claude Code: modo automático (`auto mode`)

- Arquitetura em três camadas. Das fontes de engenharia: "Tier 1: Built-in safe-tool allowlist and user settings." "Tier 2: In-project file operations. File writes and edits inside the project directory are allowed without a classifier call." "Tier 3: Transcript classifier." (Anthropic, 25/03/2026, https://www.anthropic.com/engineering/claude-code-auto-mode)
- O que o classificador vê: "The classifier sees only user messages and the agent's tool calls; we strip out Claude's own messages and tool outputs, making it reasoning-blind by design." (mesma fonte)
- Justificativa da remoção das saídas de ferramenta: "At this layer, stripping tool results is the primary prompt-injection defense, since tool outputs are where hostile content enters the context." (mesma fonte)
- Duas etapas: "Stage 1 is a fast single-token (yes/no) filter instructed to err toward blocking; if it flags, stage 2 re-evaluates the same input with chain-of-thought reasoning to reduce false positives." (mesma fonte)
- Medidas publicadas, na tabela da fonte:
  - Tráfego real, n = 10.000: estágio 1 com FPR de 8,5%; pipeline completo com FPR de 0,4%.
  - Ações excessivamente zelosas reais, n = 52: estágio 1 com FNR de 6,6%; pipeline completo com FNR de 17%. A fonte chama esse número de "the honest number".
  - Exfiltração sintética, n = 1.000: estágio 1 com FNR de 1,8%; pipeline completo com FNR de 5,7%.
  (mesma fonte)
- Causa dos erros em ações reais, segundo a própria fonte: "In the majority of misses we examined, the classifier correctly identifies the danger." O erro é saber se "a real consent signal in the session actually covers this action". (mesma fonte)
- Regras do usuário são prosa: "Entries are prose, not regex or tool patterns. The classifier reads them as natural-language rules." (https://code.claude.com/docs/en/auto-mode-config)
- Três listas customizáveis: `autoMode.environment` (o que é confiável), `allow` (exceções), `soft_deny` (destrutivo que a intenção do usuário pode liberar) e `hard_deny` (bloqueio mesmo se o usuário pedir). Cada lista aceita `"$defaults"` para somar aos padrões. (mesma fonte)
- Precedência do classificador, na documentação: "hard_deny rules block unconditionally. User intent and allow exceptions don't apply." Depois, soft_deny, que a intenção do usuário e as exceções podem liberar. "Explicit user intent overrides the remaining soft blocks: if the user's message directly and specifically describes the exact action Claude is about to take, the classifier allows it even when a soft_deny rule matches." (mesma fonte)
- Pedido geral não é intenção explícita: "Asking Claude to 'clean up the repo' doesn't authorize force-pushing, but asking Claude to 'force-push this branch' does." (mesma fonte)
- Regras determinísticas vêm antes do modelo: "Deny and explicit ask rules are evaluated before the classifier and still block or prompt." E: "Use permissions.deny ... Neither the classifier nor user intent can override it." (mesma fonte; permissions.deny é o mecanismo de bloqueio de correspondência exata)
- Ordem de decisão na documentação de modos: "Actions matching your allow, ask, or deny rules resolve immediately, with these exceptions:" Entre as exceções: "Writes to protected paths route to the classifier even when an allow rule matches." e "No allow rule approves recognized rm and rmdir critical-path removals". Também: "Ask rules that match on a command's content, such as Bash(git push *), fall back to a permission prompt". (https://code.claude.com/docs/en/permission-modes)
- Regras amplas são descartadas ao entrar no modo: "On entering auto mode, broad allow rules that grant arbitrary code execution are dropped, including: Blanket Bash(*) ..., Wildcarded interpreters like Bash(python*) ...". (mesma fonte)
- Regras de projeto não entram: "The classifier doesn't read autoMode from project settings in .claude/settings.json or .claude/settings.local.json. Both files live in the repo directory, so a checked-in repo or a build step could otherwise inject its own allow rules." (https://code.claude.com/docs/en/auto-mode-config)
- Escopos combinam, sem remoção pelo desenvolvedor: "A developer can extend environment, allow, soft_deny, and hard_deny with personal entries but can't remove entries that managed settings provide." Também: "Because allow rules act as exceptions to soft block rules inside the classifier, a developer-added allow entry can override an organization soft_deny entry: the combination is additive, not a hard policy boundary." (mesma fonte)
- Limite das regras escritas na conversa: "Boundaries are not stored as rules. The classifier re-reads them from the transcript on each check, so a boundary can be lost if context compaction removes the message that stated it. For a hard guarantee, add a deny rule, instead." (https://code.claude.com/docs/en/permission-modes)
- Aprovação vale por ação: "an approval covers the destructive action you named, so a later action is blocked again unless you granted the approval as standing." (mesma fonte)
- Ao falhar, bloqueia: "No verdict from the classifier: when a safety check separate from auto mode refuses the classifier's own request, or the classifier's response doesn't parse, Claude Code blocks the action without the notification or the Recently blocked entry." (mesma fonte)
- Ao ser bloqueado repetidamente: "if the classifier blocks an action 3 times in a row or 20 times total, auto mode pauses and Claude Code resumes prompting." (mesma fonte)
- Na fonte de engenharia: "If a session accumulates 3 consecutive denials or 20 total, we stop the model and escalate to the human." Em modo `claude -p`, sem interface, "we instead terminate the process." (https://www.anthropic.com/engineering/claude-code-auto-mode)
- Custo e latência: "Classifier calls count toward your token usage on Enterprise plans. ... Each check sends a portion of the transcript plus the pending action, adding a round-trip before execution." (https://code.claude.com/docs/en/permission-modes)
- Modelo do classificador: "By default, classifier requests go to Claude Sonnet 5." Pode ser trocado com `CLAUDE_CODE_AUTO_MODE_MODEL` (v2.1.302 ou posterior). A fonte de engenharia de 25/03/2026 diz que o classificador roda no Sonnet 4.6. (as duas fontes)
- Uma detecção de injeção separada: "a server-side prompt-injection probe scans tool outputs ... before they enter the agent's context." Não é o classificador. (https://www.anthropic.com/engineering/claude-code-auto-mode)
- Limite declarado: "Auto mode reduces permission prompts but does not guarantee safety." (https://code.claude.com/docs/en/permission-modes)
- Dado que o classificador lê, além das mensagens e comandos, segundo a documentação: "The classifier reads the same CLAUDE.md content Claude itself loads" (https://code.claude.com/docs/en/auto-mode-config). Isso é mais que as mensagens do usuário e as chamadas, descritas na fonte de engenharia. Ver "O que não foi verificado".

### 2. Gemini CLI

- Motor de regras determinístico em TOML: "When a large language model wants to execute a tool, the policy engine evaluates all rules to find the highest-priority rule that matches the tool call." Decisões: "allow, deny, or ask_user". Prioridade: "Higher numbers win." (https://geminicli.com/docs/reference/policy-engine/)
- Sem modelo no meio: a documentação lida não descreve nenhum juiz por modelo. Exemplo: `commandPrefix = "rm -rf"` com `decision = "deny"`, `priority = 100`.
- Modo não interativo: "ask_user ... (In non-interactive mode, this is treated as deny.)" (mesma fonte)
- Modos de aprovação: `yolo`, `autoEdit`, `plan`, com regras limitadas a cada modo. (mesma fonte)

### 3. Cursor

- "Your Run Mode controls when commands run, when Cursor asks, and when terminal commands enter the sandbox." E: "The sandbox runs terminal commands in a restricted environment that blocks unauthorized file access and network activity." (https://cursor.com/docs/agent/tools/terminal)
- Nenhum juiz por modelo aparece nessa página.

### 4. GitHub Copilot coding agent

- "Cloud sandboxes honor repository and organization firewall allowlists, but do not support custom compute, GitHub Actions-specific setup steps, or self-hosted runners." (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
- A proteção de rede é por lista de domínios. Não há juiz por modelo na página lida.

### 5. Segurança: pesquisa sobre injeção contra juízes e monitores

- CaMeL (arXiv:2503.18813): extrai fluxos de controle e de dados da consulta confiável, para que "the untrusted data retrieved by the LLM can never impact the program flow". Usa capacidades para impedir vazamento. Resultado: "solving 77% of tasks with provable security (compared to 84% with an undefended system) in AgentDojo."
- AgentDojo (arXiv:2406.13352): "97 realistic tasks ... 629 security test cases". Conclui que os modelos "fail at many tasks (even in the absence of attacks)".
- The Task Shield (arXiv:2412.16682): verifica se cada instrução e chamada de ferramenta serve ao objetivo do usuário. Resultado no GPT-4o: "reduces attack success rates (2.07%) while maintaining high task utility (69.79%)."
- Monitor adaptativo (arXiv:2510.09462): o atacante "embeds publicly known or zero-shot prompt injections in the model outputs". Conclusão: "frontier models consistently evade diverse monitors and complete malicious tasks on two main AI control benchmarks." A fonte chama isso de "a major blind spot in current control protocols".
- Monitor red teaming (arXiv:2508.19461): "agent awareness dominates monitor awareness"; saber que está sendo monitorado "substantially degrades the monitor's reliability". E: "escalating only pre-flagged cases to human reviewers improved the TPR by approximately 15% at FPR = 0.01."
- Injeção no juiz, na fonte de engenharia da Anthropic: "Including assistant messages and tool results caused a drop in performance on our overeagerness testset." Ou seja, incluir as saídas de ferramenta pioraria o desempenho e também abriria espaço para injeção. A fonte não mede a taxa de injeção bem-sucedida contra o classificador isolado.

### 6. Codex, xAI

- Codex: nada verificado sobre aprovações, sandbox ou revisor por modelo (ver "O que não foi verificado").
- xAI: nada verificado sobre regras de auto-revisão (ver "O que não foi verificado").

## Inferências

Rotuladas como inferência: são conclusões que eu tirei das fontes, não afirmações delas.

1. **O padrão de Anthropic (produto mais documentado) é três camadas**: lista fixa de ferramentas seguras, edições dentro do projeto liberadas sem modelo, e modelo só para o resto. Isso reduz custo e latência e concentra o risco no que realmente pode causar dano.
2. **Regras em prosa funcionam como política interpretada pelo modelo, e a documentação da própria Anthropic mantém uma camada determinística acima delas.** `deny` e `ask` por correspondência exata são avaliados antes; `hard_deny` é prosa, mas tem precedência sobre intenção do usuário. O padrão é: o que não pode falhar fica em regra exata; o resto, em prosa.
3. **Mensagens do usuário na conversa não são regras duráveis.** A própria documentação diz que um limite dito na conversa pode se perder com a compactação de contexto. Isso vale para Suup: uma regra "Sempre perguntar" que o usuário disse no chat não deve ser a única proteção do que é irreversível.
4. **A medida de erro publicada é alta para ações reais de risco.** Com FNR de 17% em ações excessivamente zelosas, a própria Anthropic diz que não é substituto de revisão humana em infraestrutura de alto risco. Para Suup, isso sugere que o revisor é uma camada extra, não a única.
5. **O classificador de Anthropic "vê o que o agente fez, não o que o agente disse"**: ele remove a prosa do agente e as saídas das ferramentas. O custo aceito foi perder proveniência ("if the user never named 'job abc123,' the classifier can't tell whether the agent pulled it from a query or fabricated it").
6. **Os argumentos das ferramentas ainda podem trazer texto do atacante.** A remoção das saídas de ferramenta não cobre o caso em que o argumento da chamada copia texto de um e-mail, uma página ou um arquivo. Por isso, a fonte de engenharia pede que o classificador avalie o efeito real (o payload, a URL, o destinatário), e não só o texto da chamada. Essa parte é inferência minha; a fonte fala do "executable payload" e de scripts escritos pelo agente.
7. **Sem fonte primária sobre o Codex, xAI, Cursor e Copilot usarem modelo para julgar ações**, a afirmação "nenhum deles usa" não pode ser feita. Só dá para dizer que as páginas lidas de Cursor, Copilot e Gemini CLI não descrevem um juiz por modelo.

## O que não foi verificado

- **Codex (OpenAI)**: approvals, sandbox modes e qualquer revisor do tipo "auto-review" ou "guardian". developers.openai.com não resolveu (ENOTFOUND) e o curl teve CONNECT 403. Ainda assim, a pergunta 2 da pesquisa não foi respondida.
- **xAI (Grok)**: qualquer documentação pública de regras de auto-revisão ou aprovação. x.ai bloqueou com Cloudflare; docs.x.ai teve CONNECT 403. A tela "Nova regra" do dono não pôde ser comparada com nada público.
- **Cursor**: a página de run modes (404). Não foi possível confirmar se há lista de comandos permitidos, nem o que o modo sandbox bloqueia exatamente.
- **Copilot**: como o agente pede aprovação de comandos e alterações no fluxo local. Lida só a página de sandbox e firewall.
- **Claude Code, "Auto mode cannot determine the safety of an action" (página de erros)**: não lida; citei só o resumo de `permission-modes`.
- **Claude Code, o que exatamente o classificador recebe**: a fonte de engenharia diz que vê só mensagens do usuário e chamadas de ferramenta. A documentação diz que a classificação envia "a portion of the transcript plus the pending action" e que lê o CLAUDE.md. A diferença não foi resolvida. Não li o código.
- **Taxa de erro e custo em outras condições** (outro modelo, outra língua, outro tipo de ação): os números são de uma fonte, com amostras de 52 ações reais e 1.000 sintéticas.
- **Se Anthropic publica um teste de injeção contra o próprio classificador** com taxa medida: não encontrado nas fontes lidas.
- **Os demais resultados de busca no arXiv** (2606.08539, 2608.16393, 2609.06972, 2610.27620): títulos e resumos não lidos.
- **"Dual LLM" (Willison) e outros textos de blog de pesquisadores**: não consultados, por não serem fontes primárias da lista permitida.

## Implicação para o Suup

Todas as propostas abaixo são **inferências**, derivadas das fontes acima. Nenhuma delas foi testada no Suup.

| Decisão | Base | Tipo |
|---|---|---|
| O revisor vê: as mensagens do usuário, as regras escritas pelo usuário e a chamada proposta (nome da ferramenta, argumentos, destino declarado) | Anthropic remove prosa do agente e saídas de ferramenta por injeção e por consistência (fatos 1, bullets 1 e 3) | Inferência |
| O revisor não vê: texto do assistente, saídas de ferramenta, e-mails ou páginas lidas, nem raciocínio do modelo. Mesmo sem as saídas, é preciso avaliar o efeito real: se a chamada contém o texto de uma fonte externa, isso é sinal de risco, e a chamada vai para pergunta | Anthropic remove as saídas; o problema dos argumentos com texto de atacante não é resolvido pela remoção (inferência 6) | Inferência, com lacuna |
| Saída estruturada: `{decisao: permitir|perguntar|bloquear, motivo_regra_id, motivo_curto}`, sem texto livre para o usuário | Anthropic usa resposta de sim/não no estágio 1 e raciocínio só quando marcado; formato fixo facilita validar | Inferência |
| Tipos de regra: "Permitir sem perguntar" e "Sempre perguntar" em prosa, interpretadas pelo modelo; "Nunca permitir" como bloqueio duro | Anthropic tem allow, soft_deny e hard_deny em prosa (fato 1) | Fato para o padrão; a escolha de nomes é inferência |
| Precedência: (1) bloqueio exato (lista fixa de ferramentas proibidas) e "Nunca permitir"; (2) "Sempre perguntar" e regras de ação irreversível; (3) "Permitir sem perguntar"; (4) padrão do revisor | Anthropic: deny e ask antes do classificador, hard_deny acima da intenção, allow só exceção a soft_deny (fatos 1) | Fato para a ordem; a lista exata é inferência |
| Fail-closed: erro, resposta sem JSON válido, timeout ou modelo indisponível = perguntar ao usuário | Anthropic bloqueia quando o classificador não dá veredito (fato 1) | Fato para o padrão; a escolha de "perguntar" em vez de "bloquear" é inferência |
| Ações que sempre perguntam, sem depender do revisor: apagar fora da pasta de trabalho, envio a outra pessoa, compra, troca de permissão, sobrescrever arquivo existente fora da pasta, ação com credencial | Anthropic mantém perguntas fixas para ações de remoção crítica e para escrita em caminho protegido (fato 1); a lista do Suup é inferência | Fato para o mecanismo; a lista é inferência |
| Regras de projeto não podem ampliar permissão | Anthropic não lê `autoMode` de `.claude/settings.json` por causa de injeção pelo repositório (fato 1) | Fato para o padrão |
| Regra escrita na conversa não é guardada como regra durável. Regra permanente só nasce de ato explícito (Configurações ou `suup rules`), como já manda APROVACOES.md | Anthropic avisa que limites da conversa se perdem na compactação (fato 1) | Fato para o padrão; alinhamento com a regra do repositório é inferência |
| Ao entrar no modo, descartar regras amplas de execução de código (shell livre, interpretadores com curinga) | Anthropic faz isso (fato 1) | Fato para o padrão |
| Regra em prosa interpretada pelo modelo não é regex nem padrão no harness. O código continua com igualdade exata nas partes deterministas | Entender texto é trabalho do modelo (REGRAS.md, seção 1); a regra proíbe padrão no harness, não o uso do modelo | Inferência de alinhamento |
| Registrar, por chamada: id da regra que casou (se houver), decisão, motivo curto, modelo e versão do prompt, hash dos argumentos e do prompt, e se houve pergunta ao usuário e a resposta | Anthropic exibe o motivo ao agente e registra bloqueios; o registro completo é inferência | Inferência |
| Medir com uma bateria fixa de chamadas plantadas: (a) ações arriscadas de tipos diferentes; (b) mesmas ações com texto do atacante nos argumentos (ex.: e-mail com instrução para enviar dados); (c) chamadas benignas próximas das arriscadas. Medir FNR e FPR por classe, separado por estágio | Anthropic mede FNR e FPR em três conjuntos (fato 1); o monitor adaptativo mostra que a bateria precisa de ataques adaptativos (fato 5) | Inferência |
| Reavaliar a bateria a cada mudança de modelo, prompt ou regra | Anthropic mudou o modelo do classificador entre as fontes (fato 1) | Inferência |
| Parar após 3 bloqueios seguidos ou 20 no total, e perguntar ao usuário | Anthropic faz isso (fato 1) | Fato para o padrão; os números são da fonte |
| Não confiar no revisor como única barreira. Usar sandbox e permissões de rede/arquivo por baixo | Anthropic diz que o modo "não garante segurança" e recomenda sandbox em camada (fato 1) | Fato para o padrão |
