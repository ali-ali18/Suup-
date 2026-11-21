# Pesquisa: recepção inicial (primeira execução e perguntas de perfil)

Data da pesquisa: 21/11/2026. Todas as fontes web foram lidas em 21/11/2026, salvo quando indicado. Valida o desenho da recepção inicial do Suup (o Principal cumprimenta, faz poucas perguntas uma de cada vez, salva o que a pessoa disser, propõe 2 a 3 bots e sugere próximos passos; pode ser pulada e refeita em Configurações). Ver [pesquisas/README.md](README.md).

## Pergunta

1. Como estes produtos e agentes fazem a primeira execução: xAI Grok Bot, ChatGPT, app do Claude, Claude Code, GitHub Copilot, Cursor, Hermes Agent, OpenClaw, OpenMausBot, OpenBot e dusk bot? Quantas perguntas fazem, se a conversa é no chat ou num formulário, o que é salvo e onde, e se dá para pular e refazer?
2. O que a pesquisa (arXiv) diz sobre elicitação de preferências e personalização em assistentes: quantas perguntas antes de o usuário desistir, uma por vez ou formulário, múltipla escolha ou texto livre?
3. Que cuidados de privacidade e segurança valem para perguntar dados pessoais, mostrar o que foi salvo e onde editar, não pedir segredos no chat e não criar contas ou conexões sem consentimento?

## Fontes

Produtos (documentação e páginas oficiais, lidas diretamente):

- Claude Code, "How Claude remembers your project" (documentação, sem data; contém `/init`, CLAUDE_CODE_NEW_INIT e auto memory): https://code.claude.com/docs/en/memory (lida em 21/11/2026; o HTML foi convertido em texto e as citações vêm dele).
- Claude (Anthropic), "Use Claude's chat search and memory to build on previous context" (central de ajuda, sem data): https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- Cursor, "Rules" (documentação, sem data): https://cursor.com/docs/context/rules
- GitHub Docs, "Adding repository custom instructions" (documentação, sem data; só o título de uma seção foi confirmado): https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
- xAI, página do Grok Bot (marketing, sem data): https://x.ai/bot. Não é documentação de produto; traz demonstrações de interface e um texto de FAQ (ver "O que não foi verificado").

Open-source (lidas no repositório oficial, via raw.githubusercontent.com):

- OpenClaw, "Agent bootstrapping" (`docs/start/bootstrapping.md`, branch `main`): https://raw.githubusercontent.com/openclaw/openclaw/main/docs/start/bootstrapping.md
- OpenClaw, template `BOOTSTRAP.md`: https://raw.githubusercontent.com/openclaw/openclaw/main/docs/reference/templates/BOOTSTRAP.md
- OpenClaw, template `USER.md`: https://raw.githubusercontent.com/openclaw/openclaw/main/docs/reference/templates/USER.md
- OpenClaw, template `IDENTITY.md`: https://raw.githubusercontent.com/openclaw/openclaw/main/docs/reference/templates/IDENTITY.md
- OpenClaw, "Onboarding (macOS app)" (`docs/start/onboarding.md`): https://raw.githubusercontent.com/openclaw/openclaw/main/docs/start/onboarding.md
- OpenClaw, "Onboarding overview" (`docs/start/onboarding-overview.md`): https://raw.githubusercontent.com/openclaw/openclaw/main/docs/start/onboarding-overview.md (baixada; não citada)
- OpenMausBot, README: https://raw.githubusercontent.com/milind-soni/OpenMausBot/HEAD/README.md
- OpenBot (nightly-labs), README: https://raw.githubusercontent.com/nightly-labs/openbot/HEAD/README.md
- dusk bot (DuskBotAI), README: https://raw.githubusercontent.com/DuskBotAI/duskbot/HEAD/README.md
- Hermes Agent: clone local `/home/user/nousresearch/hermes-agent` (somente leitura). Arquivos citados abaixo. Origem remota não conferida por este clone.

Pesquisa (arXiv; resumos lidos em https://arxiv.org/abs/ID, em 21/11/2026):

- arXiv:2610.24411, "Ask Less, Ask Better: Allocating User Attention in Proactive LLM Agents with Interruption Budgets" (submetido em 17/10/2026): https://arxiv.org/abs/2610.24411
- arXiv:2611.01087, "Is That Clear? The Impacts of Clarifying Questions on Human-LLM Interaction" (submetido em 31/10/2026): https://arxiv.org/abs/2611.01087
- arXiv:2310.11589, "Eliciting Human Preferences with Language Models" (GATE; submetido em 17/10/2023): https://arxiv.org/abs/2310.11589
- arXiv:2510.12015, "Asking Clarifying Questions for Preference Elicitation With Large Language Models" (submetido em 13/10/2025): https://arxiv.org/abs/2510.12015
- arXiv:2606.30660, "Improving Survey Participation in Low-Literacy Populations Through Value-Sensitive Conversational AI" (submetido em 16/06/2026): https://arxiv.org/abs/2606.30660 (só o resumo)
- arXiv:2607.06765, "When and How to Ask: Dynamic Preference Elicitation Strategies for Conversational Recommendation" (submetido em 07/07/2026): https://arxiv.org/abs/2607.06765 (só o resumo)
- arXiv:2309.05127, "Learning Personalized User Preference from Cold Start in Multi-turn Conversations" (submetido em 10/09/2023): https://arxiv.org/abs/2309.05127 (só o resumo)
- arXiv:2304.11406, "LaMP: When Large Language Models Meet Personalization" (submetido em 22/04/2023): https://arxiv.org/abs/2304.11406 (só o resumo; contexto, não usado nos fatos)

Busca: listagens de arXiv em https://arxiv.org/search/ (termos: "preference elicitation large language model", "eliciting human preferences language models", "cold start personalization assistant", "asking clarifying questions user LLM", "interactive preference elicitation dialogue", "conversational survey completion rate"). A API `export.arxiv.org` foi bloqueada pelo proxy (403).

## Fatos verificados

### 1. Como cada produto faz a primeira execução

**Hermes Agent (app desktop; o mais completo lido, código local).**

- A primeira execução é uma conversa no próprio chat, com um turno oculto de abertura. `gateway/session_onboarding.py:1-10`: "First-run onboarding on the session authority: ``onboarding.start`` and ``onboarding.skip``." O registro da execução fica na configuração da sessão (`agent/onboarding_record.py:2`: "``sessions.model_config`` (no schema change ...)").
- Os passos (beats), nesta ordem: nome, tema, layout, conectores, plugins, tour e "the first thing you build for them". `agent/onboarding_text.py:119`: "The beats, in order: their name, the theme (accent colour; light or dark only if they ask), the layout, connectors, plugins, a tour, then the first thing you build for them." Em código: `session_rules/onboarding_flow.py:174-186` (`BEATS`). Nenhum passo pergunta sobre a rotina ou o trabalho da pessoa.
- Perfil implícito: o modelo forma "a coarse read" em sete dimensões (experiência com IA, profundidade técnica, trabalho criativo etc.), e isso não é perguntado. `agent/onboarding_text.py:143`: "Use it to choose suggestions and words; never say it out loud." As dimensões estão em `agent/onboarding_text.py:85` (`PROFILE_DIMENSIONS`).
- Um cartão por vez, com opções próprias. `agent/onboarding_text.py:123`: "The card asks its own question and shows its own options: never ask it yourself, never list the options in text." Tempo limite do cartão: `session_rules/onboarding_flow.py:19`: `CARD_TIMEOUT_S = 300`.
- Se a pessoa escreve outra coisa com um cartão aberto, o cartão fecha sem resposta e a mensagem é respondida. `agent/onboarding_text.py:125` (trecho: "If they write a message while a card waits, the card closes unanswered and their message comes as their next turn").
- Pular: por botão ("Skip setup") ou em palavras, mas sem perguntar de novo. `agent/onboarding_text.py:127`: "If they skip a beat in words, call setup_beat(beat=<that beat>, skip=true), take the default, and never ask it again in the same form." Botão: `gateway/session_onboarding.py:294-296`: "Skip setup: end the chat's run and close the card that waits."
- Refazer: `hermes_cli/onboarding_run.py:1-7`: a flag `onboarding.run` fica no `config.yaml` raiz; "``true`` re-runs it once; ``false`` means done." Ver também `gateway/session_onboarding.py:111` (`request.rerun`).
- Regras de ação: `agent/onboarding_text.py:141`: "Ask before sending, deleting or scheduling anything. Never turn off a security setting." E `agent/onboarding_text.py:129`: "Never personal files, documents, browser data or messages without a specific ask."
- Estilo de fala: `agent/onboarding_text.py:131`: "One or two short, plain sentences per message". Sem travessão e sem ponto de exclamação (mesma linha).
- Memória de usuário: o modelo grava em USER.md (memória de perfil) por ferramenta `memory`, com `target='user'`. `agent/background_review.py:448`: "USER.md (memory tool, target='user'): who the user is — persona, preferences, communication and work style, ..."

**OpenClaw (documentação oficial, branch main).**

- É um ritual de nascimento (birth sequence) que roda uma vez, no primeiro turno real. `docs/start/bootstrapping.md`: "Bootstrapping is the first-run ritual that seeds a new agent workspace and walks the agent through picking an identity. It runs once, right after onboarding, on the agent's first real turn."
- Quatro passos no template: nome, uma linha de "vibe", avatar (opcional) e recomendações. `docs/reference/templates/BOOTSTRAP.md`: "Complete these four beats, skipping avatar generation when unavailable. Do not turn them into a questionnaire or a long biography."
- O pedido do usuário vem antes. Mesmo arquivo: "The user's request always comes first." E: "This file is a ritual, not a gate."
- Espera entre passos. Mesmo arquivo: "Wait for their answer before moving on." Não sugere nome para o agente: "Do not choose, invent, or suggest a name for yourself."
- Pergunta de escolha entre dois valores, com pedido de texto: "minimal set or maximum convenience?" (recomendações de apps; `BOOTSTRAP.md`, seção 4). A escolha de avatar é numerada em 2x2 e termina com "Ask the user to pick one or skip."
- Salva em dois lugares: `IDENTITY.md` e `SOUL.md`, e por comando de configuração. `docs/start/bootstrapping.md`: "Persists the agreed identity twice: into IDENTITY.md and SOUL.md ... and via openclaw agents set-identity".
- Apaga o ritual ao terminar: "Deletes BOOTSTRAP.md once the workspace looks configured, so the ritual only runs once." Pular: `openclaw onboard --skip-bootstrap`.
- USER.md é o perfil durável, com diretivas: "Store stable user preferences and profile facts as directives that can guide future sessions." Limite: "It loads every session with a separate 4,000-character budget." O template recomenda começar cada diretiva com um imperativo, "such as Always, Never, or Prefer".
- Importação de memória é uma etapa opcional e à escolha do usuário. `docs/start/onboarding.md` (linha 141): "Import memory (optional): choose files during guided setup or later in Settings → Import Memory."

**Claude Code (documentação, code.claude.com/docs/en/memory).**

- `/init` cria um CLAUDE.md a partir do código. Texto: "Run /init to generate a starting CLAUDE.md automatically. Claude analyzes your codebase and creates a file with build commands, test instructions, and project conventions it discovers."
- O modo de inicialização interativo (variável `CLAUDE_CODE_NEW_INIT=1`) faz perguntas e apresenta proposta antes de gravar. Texto: "fills in gaps via follow-up questions, and presents a reviewable proposal before writing any files."
- Memória automática: "Auto memory: notes Claude writes itself based on your corrections and preferences". Só as primeiras "200 lines or 25KB of MEMORY.md" carregam no início da sessão. "Auto memory is machine-local."

**Claude (app; central de ajuda, support.claude.com).**

- Não há questionário de primeira execução na página lida. A página trata de busca em conversas e memória.
- Lista do que não é salvo, mesmo que a pessoa peça: "Some information is never saved to memory, even if you ask. This includes government ID numbers, criminal history, financial account numbers, and immigration status. Claude will let you know when it can't save something for this reason."
- Temas sensíveis só entram com opt-in explícito, por configuração ou por um aviso único no chat. "Each time Claude saves something on one of these topics, a notice appears above the message box so you can review it or update your settings."
- Controle do usuário: "they can view and delete individual entries, or turn sensitive topics off to stop saving new ones." Essa frase é sobre contas de organização. A regra de temas sensíveis vale para as contas lidas na página.

**Cursor (documentação de regras, cursor.com/docs/context/rules).**

- Não há fluxo de primeira execução com perguntas na página lida. Tipos de regra: "Project Rules Stored in .cursor/rules, version-controlled and scoped to your codebase." e "User Rules Global to your Cursor environment. Used by Agent (Chat)."

**GitHub Copilot (documentação, docs.github.com).**

- A página lida tem uma seção "Asking Copilot cloud agent to generate a copilot-instructions.md file". O texto dessa seção não foi extraído (ver "O que não foi verificado"). A navegação da documentação lista "Copilot Memory" como recurso separado. Não foi lido o fluxo de primeira execução.

**xAI Grok Bot (x.ai/bot).**

- A página descreve o produto como equipe de bots: "Bots sign in to your tools, work with your entire team, and come back with finished work." Não descreve nenhuma pergunta de primeira execução.
- A página mostra uma demonstração de interface com "Saved to memory" e um cartão "Suggestion from Account Manager" com botões "Update" e "Not now". Isso é ilustração de marketing, não fluxo verificado.

**OpenMausBot (README).**

- Primeira execução é uma configuração técnica, não um perfil: "First launch guides you with arrow-key choices: choose AI access, sign in or paste a hidden API key, choose a model, and optionally connect a phone."
- Custo e consentimento: "API setup asks before a potentially billable test message."
- Chaves em texto puro: "API keys from openmausbot setup and the server are saved as plaintext, not encrypted, in private config.json (0600 on Unix)." Com o app empacotado, a chave fica no sistema operacional.

**OpenBot (README).**

- Há uma etapa de "onboarding" para baixar um runtime do provedor: "OpenBot can download a supported provider runtime when you select Download in onboarding". Não há lista de perguntas no README.

**dusk bot (README; capturas de tela).**

- "Welcome. No account needed." e "Pick your AI. Sign in to the one you use." (legendas das capturas da seção "First run and your account"). Conta só para o serviço em nuvem.
- Memória: "Every bot keeps notes on how you like things and who's who. Every note is yours to read and edit." (tabela "What bots can do").
- Perguntas como cartão: "Questions as cards. Quill asks which subject line to send." e "Ask before the risky stuff: Real questions and risky steps come to you as a card you answer in one tap."
- Dados: "Bots, chats, routines, memory, files | ~/.duskbot on the bot computer" e "What you say to a bot | Straight from the bot computer to your AI provider, not through us". Telemetria: "on until you turn off 'help improve dusk bot' (first screen or Settings)".

### 2. Pesquisa sobre perguntas e preferências

- Número de perguntas: "limiting agents to one to three questions reduces user-attention cost by 36-73% while keeping 86-94% of the task reward they earn with unlimited questions." (arXiv:2610.24411; oito LLMs, quatro domínios de atendimento ao cliente; não é onboarding.)
- Pergunta com memória: "reviewing each question against the memory of users' earlier answers cuts attention cost by another 13% with little reward loss and yields more valuable questions." (mesmo artigo.)
- Custo medido por anotadores: "human annotators agreed with the cost on which conversation required more effort 75% of the time." (mesmo artigo.)
- Efeito de perguntar no comportamento: "CQs increased perceived understanding and satisfaction, yet participants spent less time reviewing and evaluating responses and accepted more responses unchanged, including erroneous ones." (arXiv:2611.01087; N=180; seis cenários de decisão.) É um alerta: perguntas aumentam a confiança e reduzem a revisão.
- Pergunta aberta funciona melhor que formulário de texto: "LMs prompted to perform GATE (e.g., by generating open-ended questions or synthesizing informative edge cases) elicit responses that are often more informative than user-written prompts or labels. Users report that interactive task elicitation requires less effort than prompting or example labeling" (arXiv:2310.11589; três domínios; estudo pré-registrado segundo o resumo).
- Perguntas em sequência para preferências: arXiv:2510.12015 propõe treinar um modelo para fazer perguntas sequenciais que revelem preferências. O resumo não traz número de usuários nem taxa de desistência.
- Pergunta em momentos diferentes: arXiv:2607.06765 diz que "attribute-based inquiries are effective in early stages, while item-based strategies become superior as preferences refine." (recomendação de produtos; não é onboarding.)
- Formulário conversacional: arXiv:2606.30660 diz que "convAI significantly improves survey completion rates relative to traditional modalities" (n=315, mulheres de baixa escolaridade na Índia). O resumo lido não traz o número da taxa.
- Não encontrado nos resumos lidos: taxa de desistência por número de perguntas em primeira execução; comparação direta de múltipla escolha contra texto livre em onboarding de assistente.

### 3. Privacidade e consentimento (fatos dos produtos)

- Dados que não entram na memória, mesmo se pedidos (Claude): ver fonte acima.
- Ação só com pedido específico: "Never personal files, documents, browser data or messages without a specific ask." (Hermes, `agent/onboarding_text.py:129`).
- Ação com consentimento: "Ask before sending, deleting or scheduling anything." (Hermes, `agent/onboarding_text.py:141`).
- Segredo fora do chat (Suup): `docs/COFRE.md:73` diz que o segredo é pedido por formulário seguro, e `docs/COFRE.md:81`: "se você digitar o valor no chat em vez de usar o formulário, ele vira uma mensagem comum".
- Usuário vê e edita a memória: dusk bot, "Every note is yours to read and edit."; Claude, "they can view and delete individual entries".
- Segredos em texto puro em produtos de código aberto: OpenMausBot (ver fatos de primeira execução). Isto é um contraexemplo para o cofre do Suup, não um modelo a seguir.

### 4. Estado do Suup (para comparação)

- A pergunta de escolha já existe como cartão: `docs/DESIGN.md:42` diz que todo cartão do chat ("aprovação, segredo, ação do bot, pergunta, 'precisa de você'") usa a mesma moldura.
- A pergunta objetiva é a ferramenta `escalate`: `docs/PLANO.md:77`: "Faz uma pergunta objetiva ao usuário e pausa".
- Propor bot sem criar: `docs/FRONTEND.md:41`: "propor um bot a partir de uma descrição (`draft`: devolve nome, descrição e personalidade para a pessoa revisar; não cria nada)".
- Memória ativa na hora, sem confirmação: `docs/MEMORIA.md` (seção "As quatro camadas", linhas 9-10): regra e perfil são "ativa na hora, sem pedir a sua confirmação"; e na seção "Estados": "O bot gerencia a memória sozinho; você só vê, se quiser."
- Regra escrita pelo usuário: `docs/DESIGN.md:116` (diálogo "Adicionar regra" com exemplos e contador de caracteres).
- Regra permanente só por ato explícito: `docs/DESIGN.md:59`: "Regra permanente nunca sai do cartão comum: só de um ato explícito do usuário".
- O app só mostra o que o backend oferece: `docs/FRONTEND.md`, e `CLAUDE.md` do repositório ("O app só desenha o que o backend oferece").

## Inferências

Rotuladas: são conclusões minhas a partir das fontes, não afirmações delas.

1. **Os produtos lidos separam duas coisas: o que o agente precisa para trabalhar (nome, tema, conexões, ferramentas) e o que ele sabe sobre a pessoa (perfil).** Hermes e OpenClaw perguntam o primeiro tipo; o perfil de uso vem de observação ou de arquivo importado. Para o Suup, as perguntas de perfil são poucas e explícitas, o que é uma escolha de produto, não de técnica.
2. **Ritual com fim claro funciona melhor que questionário.** OpenClaw diz "Do not turn them into a questionnaire" e apaga o arquivo do ritual ao fim. Hermes tem tempo limite de cartão e aceita mensagem livre a qualquer momento. Isso sugere que a recepção deve ter poucos passos, com saída fácil.
3. **O limite de 1 a 3 perguntas (arXiv:2610.24411) é a referência mais forte que encontrei, mas é de atendimento ao cliente.** Transferir o número para a recepção é inferência.
4. **As perguntas podem reduzir a revisão do que o assistente faz (arXiv:2611.01087).** Para o Suup, o resumo final deve mostrar o que foi salvo e onde editar; sem isso, a pessoa pode aceitar uma memória errada sem ler.
5. **Salvar sem confirmação é o padrão do Suup (MEMORIA.md).** Como a recepção salva perfil e regra de uma vez, a melhor proteção é mostrar o resumo do que foi salvo com um link para a Memória, e não pedir confirmação de cada item.
6. **Lista fixa de temas que não se pergunta.** O Claude não guarda números de documento, antecedentes criminais, contas financeiras e situação migratória. O Suup, pela sua regra de cofre, também não pede senha nem chave no chat. Essa lista é inferência a partir da prática do Claude e da regra do Suup.
7. **Nenhum produto lido mostra uma etapa de "propor equipe de bots".** A proposta de bots é inferência a partir do `draft` do Suup (que já não cria nada) e do cartão de decisão.

## O que não foi verificado

- **ChatGPT (OpenAI)**: help.openai.com e openai.com retornaram CONNECT 403 pelo proxy. Não li a pergunta "What would you like ChatGPT to know about you?" nem o fluxo de memória.
- **App do Claude, primeira execução e "preferências"**: lida só a central de memória e busca. Não li uma página de onboarding nem a importação de memória. A central não traz a palavra "import" no sentido de importação.
- **xAI Grok Bot, primeira execução**: a página x.ai/bot não descreve perguntas nem configuração. docs.x.ai retornou CONNECT 403. Há uma ressalva de integridade: o texto de FAQ da página menciona "the same Cursor SSO, auth, and privacy mode you already trust", o que não combina com um produto da xAI. Não usei esse texto como fato sobre privacidade.
- **GitHub Copilot**: não li o texto da seção de geração de copilot-instructions.md nem o fluxo de Copilot Memory.
- **Cursor**: não há fluxo de primeira execução com perguntas na página lida. Não li a página de comando de geração de regras, se houver.
- **OpenBot e dusk bot**: lidos só os READMEs. O fluxo de perguntas nas capturas de tela não foi lido (as imagens não foram baixadas). Não sei quantas perguntas fazem.
- **OpenMausBot**: lido o README. O código de primeira execução não foi lido (a API do GitHub negou acesso aos três repositórios de terceiros e não os anexei à sessão; o raw foi usado para o README).
- **Hermes**: lido o código de onboarding do clone local. Não rodei o app; a ordem dos passos e as regras são as do código e do prompt, não de um teste.
- **OpenClaw**: lidos os documentos da branch `main` na data da leitura. Não sei a versão em uso por nenhum usuário, nem se o comportamento do template mudou.
- **Taxa de desistência por número de perguntas**: não encontrada em estudo lido. Nenhum resumo lido traz número de desistência em primeira execução.
- **Múltipla escolha contra texto livre em onboarding**: não encontrado em estudo lido.
- **Arquivos completos dos artigos arXiv**: li só os resumos. Os números acima são os do resumo.
- **Itens de arXiv não lidos**: 2606.30660 e 2607.06765 tiveram só o resumo lido; o número de taxa de conclusão de 2606.30660 não estava no trecho lido.
- **Textos de blog e de terceiros**: não consultados.

## Implicação para o Suup

Todas as linhas abaixo são **inferências** a partir das fontes; nenhuma foi testada no Suup.

| Decisão | Base | Tipo |
|---|---|---|
| Quem começa: o Principal, na primeira abertura de uma conversa vazia, com a saudação fixa escrita pelo app (sem modelo) e a primeira pergunta em seguida | Hermes usa saudação fixa antes do modelo (`agent/onboarding_text.py:21`); OpenClaw começa no primeiro turno real | Fato para o padrão; a escolha é inferência |
| Número de perguntas: três obrigatórias (como chamar, o que faz, estilo de resposta) e duas opcionais (ferramentas/contas e equipe), com "pular" em toda pergunta | Faixa de 1 a 3 perguntas em arXiv:2610.24411; OpenClaw e Hermes têm saída por pular (fatos 1) | Fato para a faixa (outro contexto); a divisão é inferência |
| Ordem: nome, o que você faz, primeira ajuda, ferramentas e contas, estilo, depois a proposta de equipe e os próximos passos | Hermes e OpenClaw perguntam nome primeiro e tratam o resto em seguida | Inferência |
| Formato: nome e "o que você faz" em texto livre; estilo e ferramentas em opções (cartão `escalate` com opções e campo de texto para "outro") | GATE: pergunta aberta dá respostas mais informativas (arXiv:2310.11589); Hermes usa cartão com opções (`agent/onboarding_text.py:123`); `docs/PLANO.md:77` | Fato para o padrão; a escolha por pergunta é inferência |
| Ferramentas e contas: mostrar só as que o backend tem (lista do conector disponível); nunca pedir senha ou chave no chat; conexão só depois de um clique do usuário | `docs/COFRE.md:73, 81`; Hermes: "Ask before sending, deleting or scheduling anything" (`agent/onboarding_text.py:141`); FRONTEND.md ("só o que o backend tem") | Fato para a regra; a lista é inferência |
| O que é salvo: nome e "o que você faz" como perfil; estilo de resposta como regra (ordem permanente); primeira ajuda e projeto como nota do Principal; ferramentas como perfil (só o nome do serviço, nunca credencial) | `docs/MEMORIA.md` (camadas: regra e perfil entram em todo prompt; nota é buscada) | Inferência sobre o tipo de cada item |
| Como salvar: pelo mesmo `remember` que o bot já usa, sem confirmação, com um resumo no fim: "Salvei: ... Ver ou editar em Memória" | Memória ativa na hora (`docs/MEMORIA.md`); Claude: lista do que não se salva (fato 3) | Fato para o mecanismo; o resumo é inferência |
| Não guardar: documento, conta bancária, antecedentes, situação migratória, senha e chave | Lista do Claude (fato 3); regra do cofre do Suup | Fato para o padrão (outro produto); a lista é inferência |
| Propostas de bots: um cartão com 2 ou 3 bots (nome, personalidade, mascote), gerados pela ação `draft`; botões "Criar estes" (pílula) e "Agora não" (texto); nada é criado sem o clique | `docs/FRONTEND.md:41` (`draft` não cria nada); `docs/DESIGN.md:42` (cartão de pergunta com a mesma moldura); OpenClaw pede "minimal set or maximum convenience?" e só instala o escolhido | Fato para o `draft`; o cartão é inferência |
| Próximos passos: três sugestões em cartão (conectar e-mail, conectar um serviço, criar uma rotina), cada uma só abre a tela correspondente ao clicar; nenhuma ação automática | Hermes e OpenMausBot pedem confirmação antes de ação com custo ou envio (fato 1) | Fato para o padrão; a lista é inferência |
| Pular e refazer: botão "Pular apresentação" em qualquer passo; a flag `onboarding.done` no config; refazer em Configurações > Geral > "Refazer apresentação" | Hermes: `hermes_cli/onboarding_run.py:1-7` (flag no config raiz, "re-runs it once"); `gateway/session_onboarding.py:294-296` | Fato para o padrão; o nome do botão é inferência |
| Escrita de mensagem livre durante uma pergunta: a pergunta fecha sem resposta e a mensagem é respondida, e a pergunta volta depois, uma linha | Hermes (`agent/onboarding_text.py:125`) | Fato para o padrão |
| Fim: uma mensagem curta do Principal com a primeira tarefa sugerida; a recepção não volta sozinha, a não ser por Configurações | Hermes encerra quando não resta passo (`session_rules/onboarding_flow.py:223`: `next_beat(record) or "done"`) e grava a flag de execução; OpenClaw apaga o ritual ao fim | Fato para o padrão; o texto final é inferência |
| Medir: taxa de conclusão (quem chegou à proposta / quem começou), taxa de pulo por pergunta, tempo até a primeira tarefa real, percentual de equipes aceitas, memórias editadas ou apagadas em 7 dias (sinal de salvo errado) | arXiv:2611.01087 (CQs aumentam confiança e reduzem revisão: medir também o que foi editado) | Inferência |
