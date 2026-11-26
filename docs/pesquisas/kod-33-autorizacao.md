# Pesquisa: como produtos de agente pedem (e dispensam) autorização

Data da leitura de todas as fontes: 26/11/2026. Todas as fontes abaixo foram lidas pelo HTML ou texto retornado por `curl -sL` (ou WebFetch, quando funcionou). Resultados de busca não foram usados como fonte.

## Fontes

### Lidas (fonte primária)

| # | URL | Conteúdo usado | Lida em |
|---|-----|----------------|---------|
| 1 | https://code.claude.com/docs/en/permissions | Sistema de permissões: tabela de "não perguntar de novo", regras allow/ask/deny e precedência, regras salvas por repositório, comandos somente leitura, sub-comandos de comandos compostos | 26/11/2026 |
| 2 | https://code.claude.com/docs/en/permission-modes | Modos default, acceptEdits, plan, auto, dontAsk, bypassPermissions; "ações que nenhum modo aprova"; ordem de decisão do modo auto; boundaries e aprovações ditas na conversa; limites de bloqueio (3 seguidos / 20 no total); contagem de 2 minutos para remoções críticas | 26/11/2026 |
| 3 | https://code.claude.com/docs/en/auto-mode | Configuração do classificador do modo auto: `autoMode.environment`, `allow`, `soft_deny`, `hard_deny`, precedência em quatro níveis, intenção explícita do usuário | 26/11/2026 |
| 4 | https://code.claude.com/docs/en/sandboxing | Sandbox do Bash: domínios de rede aprovados por host, auto-allow, retry fora do sandbox | 26/11/2026 |
| 5 | https://code.claude.com/docs/en/security | Resumo das salvaguardas contra prompt injection e modos | 26/11/2026 |
| 6 | https://www.anthropic.com/engineering/claude-code-auto-mode ("How we built Claude Code auto mode", página indica publicação em 25/03/2026) | Arquitetura em camadas, classificador sem texto do assistente e sem resultados de ferramentas, taxas de erro medidas (FPR 0,4%; FNR 17% em ações excessivamente zelosas), exemplos de bloqueio, aprovação "parece consentimento" | 26/11/2026 |
| 7 | https://platform.claude.com/docs/en/agents-and-tools | Lida. Não contém orientação sobre aprovação; usada só para confirmar que não há nada relevante | 26/11/2026 |
| 8 | https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks ("Mitigate jailbreaks and prompt injections") | Orientação sobre prompt injection indireta: conteúdo não confiável só em blocos de resultado de ferramenta, rotulado, política no system prompt | 26/11/2026 |
| 9 | https://openai.github.io/openai-agents-python/human_in_the_loop/ | `needs_approval`, pausa e retomada por `RunState`, `always_approve` / `always_reject`, escopo das decisões persistentes | 26/11/2026 |
| 10 | https://openai.github.io/openai-agents-python/guardrails/ | Guardrails de entrada e saída, tripwire. Não trata de aprovação humana | 26/11/2026 |
| 11 | https://platform.openai.com/docs/guides/agent-builder-safety (mesmo conteúdo em https://developers.openai.com/api/docs/guides/agent-builder-safety) | "Keep tool approvals on", dados não confiáveis não dirigem o comportamento do agente, injeção de prompt | 26/11/2026 |
| 12 | https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/protocol.rs | Código-fonte: enum `AskForApproval` (untrusted, on-request, granular, never), `SandboxPolicy`, enum `ReviewDecision` (Approved, ApprovedForSession, ApprovedExecpolicyAmendment, NetworkPolicyAmendment, Denied, Abort, TimedOut) | 26/11/2026 |
| 13 | https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/sandboxing.rs | Código-fonte: `with_cached_approval`, cache de "aprovado para a sessão" | 26/11/2026 |
| 14 | https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/exec_policy.rs | Código-fonte: regra de emenda do execpolicy derivada do comando | 26/11/2026 |
| 15 | https://raw.githubusercontent.com/openai/codex/main/codex-rs/execpolicy/README.md | Regras `prefix_rule` com `allow`, `prompt`, `forbidden`; decisão mais restritiva vence | 26/11/2026 |
| 16 | https://raw.githubusercontent.com/openai/codex/main/codex-rs/shell-command/src/command_safety/is_dangerous_command.rs | Código-fonte: classificador de comandos perigosos (rm com opção de força, desempacotamento de wrappers) | 26/11/2026 |
| 17 | https://raw.githubusercontent.com/openai/codex/main/docs/sandbox.md, `config.md`, `exec.md`, `execpolicy.md` | Lidos. São apenas ponteiros para a documentação em developers.openai.com/codex, que está bloqueada (ver abaixo) | 26/11/2026 |

Observação sobre a fonte 7: a URL https://docs.claude.com/en/docs/claude-code/iam agora devolve a página "Authentication", e não a de permissões. Por isso não a usei como fonte de permissões.

### Não lidas

Bloqueadas pelo proxy (403 em `learn.chatgpt.com`, para onde `developers.openai.com/codex/*` redireciona). Não tentei contornar o bloqueio:

- https://developers.openai.com/codex/security (redireciona para https://learn.chatgpt.com/docs/security)
- https://developers.openai.com/codex/agent-approvals-security
- https://developers.openai.com/codex/config-basic, `/config-advanced`, `/config-reference`
- https://developers.openai.com/codex/exec-policy
- https://developers.openai.com/codex/noninteractive
- https://developers.openai.com/codex/cli/reference
- https://developers.openai.com/codex/guides/agents-md

Não encontradas no caminho indicado (HTTP 404), por isso não foram lidas:

- https://raw.githubusercontent.com/openai/codex/main/codex-rs/shell-command/src/command_safety/is_safe_command.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/runtimes/shell.rs

## O que cada produto faz

### 1. Claude Code

**Modos de permissão** (fonte 2):

- `default` (manual): leituras dentro do diretório de trabalho e um conjunto somente leitura de comandos (ls, cat, echo, grep, find, git status...) rodam sem perguntar. Edições e comandos perguntam.
- `acceptEdits`: edita arquivos e roda mkdir, touch, rm, mv, cp, sed sem perguntar, apenas dentro do diretório de trabalho. Caminhos protegidos, `rm` de caminhos críticos e outros comandos ainda perguntam.
- `plan`: só leitura. Comandos passam pelo classificador quando o modo auto está disponível.
- `auto`: tudo passa por verificações; um classificador de modelo revisa as ações que não são aprovadas antes pelas regras. Disponível em planos e provedores específicos; o padrão de sessão terminal passou a ser `auto` na versão 2.1.283 em diante.
- `dontAsk`: o que pediria aprovação é negado. Usado em CI com allowlist exata.
- `bypassPermissions`: nada pergunta, exceto as regras que nenhum modo aprova (ver seção 5). Regras `deny` valem mesmo aqui.

**Ordem de decisão no modo auto** (fonte 2, "How the classifier evaluates actions"):

1. Regras allow/ask/deny resolvem antes. Exceções: escritas em caminhos protegidos e remoções críticas de `rm`/`rmdir` sempre vão para o classificador ou para o prompt.
2. Leituras, buscas e edições dentro do projeto são aprovadas sem classificador (fonte 6, "Tier 2").
3. Todo o resto vai ao classificador. Ele vê só as mensagens do usuário e as chamadas de ferramenta. Texto do assistente e resultados de ferramenta são removidos de propósito (fonte 6: "We strip assistant text so the agent can't talk the classifier into making a bad call").
4. Se o classificador bloquear, a razão volta ao agente, que deve buscar outro caminho. Se houver 3 bloqueios seguidos ou 20 no total na sessão, o modo auto pausa e volta a perguntar. Esses limites não são configuráveis.

**Regras allow / ask / deny** (fonte 1):

- A ordem é deny, depois ask, depois allow. O primeiro que casa decide. Especificidade não muda a ordem: um `deny` amplo como `Bash(aws *)` bloqueia até `Bash(aws s3 ls)`.
- Um `deny` que nomeia a ferramenta inteira a remove do contexto do modelo.
- Hooks PreToolUse não contornam `deny` nem `ask`.
- No modo auto, regras allow amplas que dão execução arbitrária são descartadas ao entrar (`Bash(*)`, `Bash(python*)`, `Bash(timeout *)`, `Bash(* --version)`). Regras estreitas como `Bash(npm test)` continuam valendo.

**"Não perguntar de novo" (grant por sessão ou permanente)** (fontes 1 e 2):

- Edições de arquivo: valem até o fim da sessão.
- Bash (por comando): "Permanently per repository and command". Salvo em `.claude/settings.local.json` na raiz do repositório e aplicado em outras sessões desse repositório.
- WebFetch: permanente por repositório e domínio.
- Em comando composto, é salvo uma regra por sub-comando que precisou de aprovação (até 5).
- Prefixo de comando: `Bash(git log *)` casa `git log`. Wildcard no meio não casa o comando sem argumentos.
- Quando a aprovação é só "uma vez", o prompt não oferece "não perguntar de novo", porque a regra salva cobriria mais do que o que foi mostrado.

**Aprovação por texto na conversa** (fonte 2, "Approvals you state in conversation"): o classificador lê a aprovação dita pelo usuário e pode liberar um bloqueio. Regras:

- A aprovação precisa nomear a ação e o que a torna perigosa. "Você pode dar force-push" pode não bastar; "pode dar force-push nesse branch" basta (fonte 3: "General requests don't count as explicit intent... asking Claude to 'force-push this branch' does").
- A aprovação cobre uma ação. Uma ação seguinte igual é bloqueada de novo, a não ser que a aprovação tenha sido dada como permanente.
- Um limite declarado pelo usuário ("não faça push") é sinal de bloqueio e continua valendo até ele mesmo retirar.
- Algumas proibições não são liberadas por aprovação de texto (as de `hard_deny`).

**Como decide o que é perigoso** (fontes 2, 3, 6): o classificador usa uma lista de bloqueios padrão. Entre eles: download e execução de código (`curl | bash`), envio de dados sensíveis para fora, deploy e migração de produção, exclusão em massa em armazenamento de nuvem, concessão de IAM ou de permissão de repositório, alteração de infraestrutura compartilhada, destruição irreversível de arquivos que existiam antes da sessão, force push, `git reset --hard`, `git checkout -- .`, `git clean -fd`, `git stash drop`. Ele também avalia o efeito real do comando, e não só o texto: se o agente grava um script e o executa, o script é avaliado; cadeias com `&&` são uma ação só.

Dados medidos pela Anthropic (fonte 6): 93% dos prompts manuais são aceitos, o que motivou o modo auto. No conjunto de 52 ações excessivamente zelosas reais, o classificador deixou passar 17% (FNR). Na pilha final, o falso positivo caiu para 0,4% (FPR) com o segundo estágio de raciocínio. O texto da fonte diz que a falha típica é o classificador achar "evidência de aprovação" sem verificar se ela cobre o alcance da ação: "Clean up the PR" não cobre force-push.

**Sandbox** (fonte 4): o Bash roda em um sandbox do sistema operacional. Rede passa por proxy que checa cada host contra `allowedDomains`. Na primeira vez que um comando precisa de um domínio novo, o Claude Code pergunta. No modo auto-allow, comandos rodando dentro do sandbox são aprovados sem prompt. Uma regra allow que casa o comando também aprova a repetição fora do sandbox, e isso precisa ser fechado com `strict sandbox mode` se for indesejado.

### 2. OpenAI Codex CLI

Fontes 12 a 16. A documentação oficial (developers.openai.com/codex) não pôde ser lida; o que segue vem do código.

**Políticas de aprovação** (`AskForApproval`, fonte 12):

- `untrusted` (`UnlessTrusted`): comandos pedem aprovação, a não ser que uma regra do execpolicy permita.
- `on-request` (`OnRequest`, padrão): o modelo decide quando perguntar. Pelo código, `on-failure` é apenas um alias serde de `OnRequest`.
- `granular`: um flag por categoria: `sandbox_approval`, `rules`, `skill_approval`, `request_permissions`, `mcp_elicitations`. Um flag `false` rejeita a categoria sem mostrar ao usuário.
- `never`: nunca pede; a falha volta ao modelo.

**Modos de sandbox** (`SandboxPolicy`, fonte 12): `ReadOnly` (rede desligada por padrão), `WorkspaceWrite` (escreve no diretório atual e em pastas extras declaradas), `DangerFullAccess`, `ExternalSandbox` (já está em um sandbox externo; acesso total ao disco, rede conforme configuração).

**Decisões do usuário** (`ReviewDecision`, fonte 12):

- `Approved`: executa uma vez.
- `ApprovedForSession`: guarda a decisão em um cache da sessão. A fonte 13 mostra que, se todas as chaves do pedido já estão em `ApprovedForSession`, a execução segue sem perguntar. As chaves são fornecidas por quem chama a função; não consegui confirmar a chave exata usada para shell, porque o arquivo do runtime de shell retornou 404.
- `ApprovedExecpolicyAmendment`: aprova e grava uma regra `prefix_rule` para comandos futuros parecidos (fonte 14 mostra que a emenda usa o prefixo exato de argv, por exemplo `["prog1", "--option1", "arg1"]`, e não só o nome do programa). Não gera emenda se alguma regra `prompt` do execpolicy ainda se aplicar.
- `ApprovedMcpPolicyAmendment`: grava a aprovação de uma ferramenta MCP para chamadas futuras, inclusive em outras sessões.
- `NetworkPolicyAmendment`: grava permitir ou negar um host específico para o futuro.
- `Denied`, `Abort`, `TimedOut`.

**Execpolicy** (fonte 15): regras `prefix_rule` com decisão `allow`, `prompt` ou `forbidden`. Os tokens casam em ordem; alternativas são listas. Quando mais de uma regra casa, a decisão mais restritiva vale (`forbidden` > `prompt` > `allow`). Comando sem regra passa por heurística.

**Classificação perigosa** (fonte 16): o classificador conhecido reconhece `rm` com opção de força e outras regras. Ele desembrulha `sudo`, `env`, `trap` e o conteúdo de `sh -c` e falha fechado em wrappers muito aninhados. A lista é estreita, não é um classificador de risco geral.

**Aprovação por texto**: o Codex não usa o texto do chat como aprovação. A decisão vem da interface, como um `ReviewDecision`.

### 3. OpenAI Agents SDK (Python) e o guia de segurança da OpenAI

Fontes 9, 10 e 11.

- Uma ferramenta marca `needs_approval=True` ou passa uma função `(ctx, params, call_id) -> bool`. Quando a função não consegue ler os argumentos (vazios, JSON inválido, não é objeto, NaN, Infinity), ela não é chamada e a chamada exige aprovação manual. É fail-closed.
- A execução pausa e devolve `interruptions`. A aprovação é feita por código: `state.approve(...)` ou `state.reject(...)`, e depois `Runner.run(agent, state)`.
- `always_approve=True` e `always_reject=True` guardam uma decisão persistente. O escopo depende do tipo de ferramenta:
  - funções: por agente que pediu;
  - shell e apply_patch: por tipo e nome, e não por agente (a própria doc avisa que uma decisão pode valer em outro agente após um handoff);
  - MCP hospedado: por `server_label` mais nome da ferramenta.
- Decisões persistentes sobrevivem a `to_json` e `from_json`.
- Não há aprovação por texto livre. A aprovação é uma chamada de código.

Guia de segurança da OpenAI (fonte 11):

- "Keep tool approvals on": com ferramentas MCP, ativar aprovação para que o usuário confirme cada operação, inclusive leituras.
- "Design workflows so untrusted data never directly drives agent behavior": extrair só campos estruturados de entradas externas.
- Dados não confiáveis devem entrar por mensagens de usuário, não em mensagens de desenvolvedor.

### 4. Anthropic, sobre injeção de prompt (fonte 8)

- Conteúdo de terceiros (páginas, e-mails, documentos, saída de ferramenta) deve ir somente em blocos `tool_result`, nunca no system prompt nem em texto de usuário.
- O conteúdo deve vir rotulado com origem e natureza.
- O system prompt deve dizer que conteúdo de ferramenta é dado não confiável e não pode sobrepor a instrução do usuário.

Na fonte 6, a Anthropic diz que a injeção é barrada em duas camadas: uma sonda no resultado de ferramenta e um classificador que não lê resultados de ferramenta.

## Tabela comparativa

| Aspecto | Claude Code (permission modes) | Codex CLI | OpenAI Agents SDK | Suup (hoje, pelo que o dono descreveu) |
|---|---|---|---|---|
| Quem decide se pergunta | Regras deny/ask/allow, depois modo; no modo auto, um classificador de modelo | `AskForApproval` (untrusted / on-request / granular / never) + execpolicy | `needs_approval` (bool ou função por chamada) | Cartão de aprovação para quase tudo |
| Ações sempre perguntadas | `ask` explícito; `rm` de caminho crítico; ferramentas que exigem interação; protegidos | `prompt` no execpolicy; no modo `untrusted`, todo comando sem regra `allow` do execpolicy | Ferramentas com `needs_approval` | Quase tudo |
| Grant "não perguntar de novo" | Edições: até o fim da sessão. Bash: por repositório e por comando/prefixo, gravado em arquivo. WebFetch: por repositório e domínio | `ApprovedForSession` (cache da sessão); emendas persistentes de prefixo, host e MCP | `always_approve` / `always_reject` por tipo de ferramenta, persistente no estado | Não descrito |
| Granularidade do grant | Prefixo de comando; domínio; nome de ferramenta MCP (`mcp__server__*`) | Chave de cache por chamada; prefixo exato de argv; host de rede | Nome da ferramenta (e agente, para funções); `server_label`+nome para MCP | — |
| Limite de tempo | Não há grant com prazo. Há contagem de 2 min para o prompt de `rm` crítico (não é grant) e o limite de 3/20 bloqueios | Não encontrado no código lido | Não encontrado | — |
| Texto do usuário no chat conta como aprovação? | Sim, só para liberar bloqueio do classificador. Precisa nomear a ação e o motivo; cobre uma ação; não vale para `hard_deny` | Não (decisão pela interface) | Não (chamada de código) | Pedido: aceitar "pode", "faz", "libera" |
| Como classifica risco | Regras + lista de bloqueios do classificador + análise de comando (shell) + efeito real (script/cadeia) | Execpolicy + classificador estreito de rm/forçado; sandbox define o que é possível | Nenhum; quem decide é o app | — |
| Sandbox | Sandbox do SO no Bash; rede por host; retry fora do sandbox (pode ser fechado) | `ReadOnly`, `WorkspaceWrite`, `DangerFullAccess`, `ExternalSandbox` | Fora do escopo (app) | — |
| Regra de falha | Classificador falha fechado ("err toward blocking"); resposta não interpretável = bloqueio | Parser falha fechado; `unless-trusted` pede | Função de aprovação falha fechado | — |

## Recomendações para o Suup

### A. O que aprovar automaticamente

Sem perguntar, desde que o escopo da chamada já esteja dentro da política do usuário:

1. Leitura, busca e listagem dentro do escopo do usuário (equivalente ao conjunto somente leitura do Claude Code).
2. Escrita reversível dentro do espaço de trabalho do projeto, quando a própria ferramenta declara que a ação é reversível (equivalente ao Tier 2 e ao `acceptEdits`).
3. Chamadas de ferramenta a hosts já aprovados (equivalente ao `allowedDomains`).
4. Comandos rodando em sandbox, se o Suup tiver sandbox. A Anthropic trata o sandbox como camada separada do classificador.

Perguntar sempre, nunca liberado por grant amplo ou por texto de chat sem confirmação forte:

1. Ação irreversível ou destrutiva: apagar fora do espaço de trabalho, apagar em massa em serviço externo, force push, reset que descarta trabalho, perda de dados.
2. Efeito externo visível ou com dinheiro: enviar mensagem a terceiro, publicar, pagar, emitir documento fiscal.
3. Envio de dados sensíveis para host novo ou fora da lista confiável.
4. Mudança nas próprias permissões, credenciais ou configuração do agente (a Anthropic bloqueia isso no padrão).
5. Deploy e operação em produção, e alteração de infraestrutura compartilhada.

### B. Como classificar risco sem regex

O `CLAUDE.md` do Suup proíbe classificar por regex ou glob no harness. Isso encaixa com o que as fontes fazem:

- Cada ferramenta declara sua estrutura: `reversibility` (`reversible` / `irreversible`), `external_effect` (sim/não), `scope` (workspace, host, recurso), e se aceita grant. A decisão lê esses campos, não o texto do comando.
- Quando a ferramenta não consegue declarar o efeito (por exemplo, um comando shell que o harness não sabe analisar), o padrão é perguntar. É o que a Anthropic faz com comandos que o analisador não consegue rastrear, e o que a OpenAI faz com argumentos não lidos.
- Para casos ambíguos, um classificador de modelo olha só a mensagem do usuário e a proposta estruturada, sem a justificativa do próprio agente (a Anthropic remove o texto do assistente justamente para evitar que o agente convença o classificador). Em dúvida, pergunta.

### C. Escopo do grant (host, comando, ferramenta e tempo)

Unidade do grant: (ferramenta declarada, alvo normalizado, conversa/sessão).

- Alvo normalizado: host, para rede; prefixo de comando com argumentos, para shell (como o Codex grava argv completo, e não só o programa); identificador do recurso, para escrita; nome da ferramenta, para MCP. Nunca "todos os comandos" (a Anthropic descarta `Bash(*)` no modo auto).
- Duração: o padrão é a sessão (como edições no Claude Code e `ApprovedForSession` no Codex). Um prazo fixo, por exemplo 60 minutos, é uma escolha de produto que nenhuma das fontes lidas oferece; se o dono quiser, deve ser decidido e documentado como decisão própria, e não como "padrão da indústria". Revogação visível na interface (o Claude Code mostra "Recently blocked" em `/permissions`).
- Precedência: negação sempre vence; o grant não cria exceção a uma negação (regra do Claude Code).
- Grant não cobre ação irreversível: essas precisam de aprovação por ação, nomeando o alvo (a Anthropic: uma aprovação cobre a ação nomeada, e a aprovação genérica não basta).
- Grant persistente entre sessões só com ação explícita do usuário (a Anthropic grava em arquivo só quando o usuário escolhe "não perguntar de novo").

### D. Como validar "pode", "faz" e "libera" de forma segura

Os produtos lidos não aceitam texto livre como aprovação de rotina. A única exceção é o classificador do Claude Code, que usa a fala do usuário como sinal e tem as ressalvas descritas acima. Por isso a validação precisa ser do Suup, e deve ser conservadora.

1. Existe uma proposta pendente registrada pelo harness: ID, resumo do efeito, hash dos argumentos, horário. A mensagem "pode" só aprova a pendência mais recente da mesma conversa, e só se ela foi mostrada na última mensagem do bot. Havendo mais de uma pendência, o Suup pergunta qual.
2. Comparação exata com uma lista de palavras de aprovação (`pode`, `faz`, `libera`, `sim`, após trim e minúsculas). Pontuação muda o resultado: "pode?" é pergunta, não aprovação (a Anthropic dá o exemplo "can we fix this?" como pergunta, não como ordem). Pergunta de volta.
3. A aprovação vem do usuário autenticado. Texto vindo de ferramenta (página, e-mail, documento, resultado de busca) nunca cria nem confirma aprovação (fontes 8 e 11).
4. Para ação reversível e no escopo: a aprovação por texto vale. Para ação irreversível ou com efeito externo: não vale. O Suup pede confirmação com o alvo nomeado (por exemplo, o nome da pasta ou o destinatário) ou usa botão.
5. Negação, condição ou ressalva na mesma mensagem cancela a aprovação ("pode, mas só depois de eu revisar"). Como não se deve usar regex para isso, a verificação é um modelo pequeno que recebe só a mensagem do usuário e a proposta, e responde `aprovar`, `perguntar` ou `recusar`. Em dúvida, `perguntar`.
6. A aprovação vale só para a proposta exibida. Qualquer mensagem seguinte do bot com nova proposta invalida a anterior. Opcionalmente, expira em alguns minutos.
7. Confirmação de eco antes de criar grant: "Vou executar X. Libero também Y nesta sessão?". A aprovação de uma ação não cria grant sem essa confirmação.
8. Registro de auditoria: quem aprovou, texto exato, ID da proposta, hash, horário, e se houve grant.

## O que continua em aberto

- Não há fonte lida que mostre grant com prazo, nem uma prova de que o prazo de 60 minutos (ou qualquer outro) seja adequado. Falta decisão do dono.
- Nenhuma fonte primária lida valida "pode" como aprovação suficiente para ação de rotina fora de um classificador. A segurança da validação em D depende de testes próprios: falsos positivos (aprovar sem querer), falsos negativos (perguntar demais) e injeção vinda de conteúdo de ferramenta.
- A taxa de 17% de falha em ações excessivamente zelosas é do classificador da Anthropic, medida nos dados deles. Não vale para o Suup sem medição própria.
- Codex: a documentação de segurança e de aprovações não foi lida (bloqueio do proxy). A chave exata de cache de sessão para shell não foi confirmada no código lido. Se o dono quiser essa parte, precisa liberar o acesso a `learn.chatgpt.com` ou fornecer o texto da documentação por outro canal.
- Não há inventário das ferramentas do Suup com `reversibility` e `external_effect`. Sem ele, a lista de "aprovar automaticamente" é só uma proposta.
- O Suup precisa decidir se aceita a regra de "nomear a ação" para aprovação de ação irreversível (mais atrito) ou se usa botão sempre.
- Pela regra do dono em `docs/REGRAS.md` (regex proibida para classificar no harness), a lista de palavras de aprovação em D.2 é comparação exata, permitida. Se a verificação de ressalvas (D.5) virar qualquer padrão de texto, é preciso pedir a decisão do dono antes.
