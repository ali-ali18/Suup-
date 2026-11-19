# Pesquisa: aprovações, cofre e conectores (retroativa)

Data da pesquisa: 19/11/2026. Pesquisa retroativa: valida as entregas de aprovações, cofre e conectores da fase 3 (`docs/PLANO.md`, seções 4.8 e 4.11), que foram implementadas antes dela.

## Pergunta

O Suup implementou três áreas sem pesquisa prévia: (1) aprovações por nível de risco, regras de usuário, revisor automático e card; (2) cofre com placeholder `{{secret:NAME}}`, criptografia em repouso e scrubbing por comparação exata; (3) conectores MCP com ask por padrão, annotations que só endurecem, resultados não confiáveis e stdio no host. Objetivo: comparar com produtos atuais e padrões, achar erros e lacunas, e classificar cada item por prioridade. Restrição do projeto: nada de regex ou padrões de texto para classificar ou liberar ações. Quando um mitigador comum for baseado em padrão, isso é indicado.

Método: fontes primárias lidas por curl (MCP, quando WebFetch falhou com ENOTFOUND) ou WebFetch (Anthropic, Claude Code, OpenAI Agents SDK, Cursor, Gemini CLI). Itens só de snippet de busca estão marcados. Datas são as declaradas na página, quando existem.

## Fontes

- [S1] MCP, especificação de autorização, versão 2025-11-25. https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization. Lida por curl em 2026-11-19. Data de publicação não lida; a página declara a versão 2025-11-25.
- [S2] MCP, especificação de tools (annotations). https://modelcontextprotocol.io/specification/2025-11-25/server/tools. Mesma versão; lida por curl em 2026-11-19.
- [S3] MCP, especificação de elicitation (modos form e url). https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation. Mesma versão; lida por curl em 2026-11-19.
- [S4] MCP, security best practices. https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices. Sem data na página; lida por curl em 2026-11-19.
- [S5] Claude Code, configuração de permissões. https://code.claude.com/docs/en/permissions. Sem data; cita versões até v2.1.292. Lida por WebFetch em 2026-11-19.
- [S6] Claude Code, modos de permissão e auto mode. https://code.claude.com/docs/en/permission-modes. Sem data; cita v2.1.326 e auto como modo inicial a partir da v2.1.283. Lida por WebFetch em 2026-11-19.
- [S7] Anthropic, sandboxing do Claude Code. https://www.anthropic.com/engineering/claude-code-sandboxing. Data: 2025-10-20.
- [S8] Anthropic, defesas contra prompt injection. https://www.anthropic.com/research/prompt-injection-defenses. Data: 2025-11-24.
- [S9] OpenAI Agents SDK, human-in-the-loop. https://openai.github.io/openai-agents-python/human_in_the_loop/. Sem data. Lida por curl em 2026-11-19.
- [S10] OpenAI Agents SDK, guardrails. https://openai.github.io/openai-agents-python/guardrails/. Sem data. Lida por curl em 2026-11-19.
- [S11] Cursor, terminal e sandbox. https://cursor.com/docs/agent/terminal. Sem data. Lida por curl em 2026-11-19; detalhes de sandbox não extraídos.
- [S12] Cursor, MCP (allowlists e aprovação de tools). https://cursor.com/docs/context/mcp. Sem data. Lida por curl em 2026-11-19.
- [S13] Gemini CLI, pastas confiáveis. https://geminicli.com/docs/cli/trusted-folders/. Atualizada em 2026-04-23. Lida por curl em 2026-11-19.
- [S14] OpenAI Codex, approvals e segurança. https://developers.openai.com/codex/agent-approvals-security. Só snippet de busca (fetch retornou 403 pelo proxy, mesmo com o host liberado). Data não verificada.
- [S15] Willison, "lethal trifecta". https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/. Data: 2025-06-16. Só snippet (host não resolvido na leitura direta).
- [S16] Hou et al., MCP: landscape, security threats and future research directions. https://arxiv.org/abs/2503.23278. Submetido em 2025-03-30; versão 3 em 2025-10-07. Lido o resumo.
- [S17] OWASP Top 10 for Agentic Applications (2026). Fonte secundária: https://cycode.com/blog/owasp-top-10-agentic-applications/. Só snippet. Documento oficial do OWASP não acessado (genai.owasp.org e owasp.org sem acesso). Data 2025-12-09 segundo fonte secundária.
- [S18] Hash pinning para rug pull de tools MCP. Fonte secundária: nota de pesquisa da CSA, https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/07/CSA%5Fresearch%5Fnote%5Fmcp%5Ftool%5Fpoisoning%5Fai%5Fagent%5Fexfiltration%5F20260702-csa-styled.pdf. Só snippet; data inferida do nome do arquivo (2026-07-02).
- [S19] Trackr, detecção de rug pull em MCP. https://www.trackr.live/?p=1129. Só snippet; data não verificada.

## Fatos verificados

### 1. Aprovações (produtos atuais)

- Claude Code avalia regras na ordem deny, depois ask, depois allow. A primeira correspondência decide. Deny vence sempre. Um allow não cria exceção a deny, e ask vence allow mesmo quando o allow é mais específico [S5].
- Claude Code afirma que regras de permissão são aplicadas pelo harness, não pelo modelo [S5].
- Um hook PreToolUse que retorna "allow" não pula deny nem ask [S5].
- Regras de Bash casam texto do comando com wildcard. Documentação oficial: a correspondência não cobre o mesmo programa chamado por outro caminho ou dentro de `sh -c`, e o texto `Bash(curl *)` não é fronteira de segurança. Ela recomenda sandbox para restrição real [S5].
- No modo auto, um classificador de modelo revisa cada ação antes de executar. Ele não vê resultados de ferramentas (são removidos da entrada), o que reduz injeção direta no classificador. Um servidor separado varre resultados de ferramentas [S6].
- Ao entrar no modo auto, regras amplas que dão execução arbitrária são descartadas (ex.: `Bash(*)`, `Bash(python*)`) e são restauradas ao sair [S6].
- Se o classificador bloquear 3 vezes seguidas ou 20 no total, o modo auto volta a pedir confirmação. Falha ou ausência de veredito vira negação, não execução sem revisão [S6].
- A própria documentação diz que o classificador não substitui controle do sistema operacional como sandbox [S6].
- Sandbox do Claude Code: limita escrita ao diretório de trabalho (bubblewrap no Linux, seatbelt no macOS). A rede passa por um proxy fora do sandbox com allowlist de domínios, e domínio novo pede confirmação. A Anthropic relata 84% menos prompts, com a ressalva de ser uso interno, não avaliação independente. Não lista limitações explícitas [S7].
- OpenAI Agents SDK: ferramenta declara `needs_approval` como booleano ou função por chamada. O estado da execução pausada é serializável (RunState) e a aprovação pode ser feita depois [S9].
- OpenAI Agents SDK: guardrails podem rodar em paralelo com o agente (o agente pode já ter consumido tokens e executado ferramentas antes do tripwire) ou em modo bloqueante (o agente não roda se o guardrail disparar) [S10].
- Codex (snippet, não verificado na página): rede desligada por padrão no modo workspace-write; approval_policy on-request é o preset recomendado para automação local; danger-full-access com approval never é o modo sem proteção; .git fica protegido como leitura [S14].
- Cursor: sandbox para comandos de terminal que bloqueia acesso não autorizado a arquivos e rede; os modos de rede estão em sandbox.json [S11].
- Gemini CLI: pede aprovação para confiar em uma pasta antes de executar código dela; configuração gravada por padrão [S13].

### 2. Cofre e segredos

- Especificação MCP (elicitation url): credenciais informadas por URL externa não passam pelo LLM, nem pelo cliente MCP, nem por servidores intermediários. Com elicitation form, a especificação orienta a não pedir credenciais; o modo url existe para isso [S3].
- Anthropic: o proxy de rede que injeta credenciais roda fora do sandbox. O sandbox não enxerga o valor, só o caminho de rede permitido [S7].
- Claude Code auto mode: leitura de `.env` e envio de credenciais para a API correspondente são auto-aprovados por padrão. Ou seja, o produto trata credencial como dado que pode ser usado, desde que vá ao destino certo [S6].

### 3. MCP (spec, authorization e práticas de segurança)

- Autorização: a especificação 2025-11-25 segue OAuth 2.1 (rascunho IETF). PKCE é obrigatório, e clientes devem verificar se o servidor de autorização suporta PKCE [S1].
- Resource Indicators (RFC 8707) são obrigatórios; tokens são vinculados ao público pretendido e o servidor deve validar audiência [S1][S4].
- Registro de cliente: Client ID Metadata Documents (CIMD) são preferidos quando o servidor de autorização os suporta; Dynamic Client Registration (DCR) é o fallback [S1].
- Token passthrough é explicitamente proibido. Servidor que aceita token de outra audiência e o repassa para API downstream é descrito como anti-padrão que gera confused deputy e quebra controles de taxa e monitoramento [S1][S4].
- Práticas de segurança: validação exata do redirect_uri, sem wildcard nem correspondência por padrão [S4].
- Práticas de segurança: cookie de consentimento definido antes da aprovação anula a tela de consentimento; o consentimento deve ser por cliente [S4].
- Práticas de segurança: servidores MCP locais devem rodar em sandbox com privilégio mínimo; servidores locais de fonte não confiável são risco explícito [S4].
- Annotations (readOnlyHint etc.): a especificação diz que clientes DEVEM tratar annotations como não confiáveis, a menos que venham de servidor confiável [S2].
- O spec de tools não define o que acontece quando a descrição de uma tool muda depois de aprovada (snippet da CSA, [S18]; não lido diretamente no spec).

### 4. Ataques e modos de falha

- Lethal trifecta (Willison, 2025-06-16, [S15] snippet): acesso a dados privados, exposição a conteúdo não confiável e capacidade de comunicação externa. Os três juntos permitem exfiltração por injeção. A mitigação recomendada é remover uma das pernas.
- Anthropic (2025-11-24, [S8]): com safeguards novos, a taxa de sucesso de ataque adaptativo em browser agent ficou entre 1,4% e 2,4% para os modelos medidos. A própria Anthropic diz que 1% ainda é risco significativo e que nenhum agente de browser é imune. Resultados internos, não benchmark independente.
- OWASP Top 10 for Agentic Applications (2026, [S17] snippet): ASI02 Tool Misuse (ferramentas usadas indevidamente por prompt ambíguo, permissão excessiva ou entrada envenenada) e ASI03 Identity and Privilege Abuse (credenciais herdadas e reutilizadas). Recomendação: "least agency" e credenciais de curta duração por agente.
- Tool poisoning e rug pull: classe de ataque documentada; defesa mais citada é hash da definição aprovada e comparação em cada carga [S18][S19] (snippets). Limite: hash não pega mudança de comportamento com descrição igual, e mudança legítima é indistinguível de rug pull no nível do hash [S18] (snippet).
- Cross-server shadowing e confused deputy: descritos em [S4] (confused deputy e passthrough verificados; shadowing não lido diretamente).
- Pesquisa acadêmica: [S16] (resumo lido) cataloga ameaças de MCP, incluindo envenenamento de tools, mas o conteúdo completo não foi lido.
- Claude Code (documentação oficial): regras de padrão em Bash são frágeis e não são fronteira de segurança [S5].
- Claude Code (documentação oficial): "Yes, and don't ask again" salva regras por subcomando de prefixo; um `*` no meio muda o alcance da regra [S5].

## Inferências

- I1. O shell do Suup com rede dentro do container, sem card, forma a perna de exfiltração do trifecta se o container puder ler dados privados (cofre, outros bots, arquivos do usuário) e se receber conteúdo não confiável (páginas, e-mails, resultados de conectores). Isolar o container não resolve isso, porque a rede é o canal de saída.
- I2. Exact-value scrubbing não basta. Ele não cobre valor partido entre chunks de stream, valor reescrito pelo modelo, valor em forma de transformação não listada, nem exfiltração pela rede. Ele é última barreira. A proteção real é não colocar o segredo ao alcance do modelo nem de processos com rede.
- I3. Comparação exata de valores (sem regex) é compatível com a regra do projeto. Não há necessidade de padrões para o scrubbing, desde que o conjunto de valores conhecidos seja mantido.
- I4. Hash de definição de tool é comparação exata, compatível com a regra do projeto. Não é detecção por padrão de texto.
- I5. Um revisor automático que recebe resultados de ferramentas repete o problema que o auto mode da Anthropic evita ao remover resultados da entrada do classificador.
- I6. Namespacing `conn_<connector>__<tool>` evita colisão de nome, mas não impede que a descrição de um servidor induza o modelo a usar outro servidor. Esse risco é mitigado por aprovação por tool e por contexto, não por nome.
- I7. Rascunho em vez de envio é o mesmo princípio de remover a perna de comunicação externa. O rascunho em si pode carregar segredo ou dado privado, então o envio precisa de card com conteúdo exato.
- I8. Stdio roda no host com env mínimo e sem shell, mas ainda é código executado no host com acesso ao sistema de arquivos e à rede do servidor. A redução de env não limita o que o processo faz. Isso fica fora do que a especificação exige como sandbox.

## O que não foi verificado

- Documentação oficial da OpenAI Codex (developers.openai.com retornou 403 pelo proxy, apesar de estar na lista liberada). Descrição de Codex só por snippet.
- Documentação oficial do OWASP Top 10 for LLM Applications 2025 e do OWASP Agentic 2026. Só fonte secundária (snippet).
- Artigos de Simon Willison e Invariant Labs (tool poisoning, 2025-04): não lidos diretamente; simonwillison.net e invariantlabs.ai não resolveram.
- Meta, "Agents Rule of Two" (ai.meta.com): não acessado.
- Detalhes de sandbox do Cursor (sandbox.json, modos de rede): não extraídos.
- Especificação MCP sobre se servidor de autorização deve ou não estar no mesmo domínio do recurso, e o alcance exato de "HTTP-based transports" na autorização: não lido com precisão.
- Comportamento real do Claude Code, Codex e Cursor com regras de allow em runtime: só a documentação, não testes.
- Taxas de falso positivo e falso negativo do classificador do Claude Code: a documentação diz que não são publicadas [S6].
- Recomendações de criptografia (AES-256-GCM, unicidade de nonce, rotação por key id): não pesquisadas nesta rodada.
- Nenhuma fonte primária sobre fadiga de aprovação foi lida; o único número é o da Anthropic, de uso interno [S7].

## Implicações para o Suup

### Aprovações

| Item | Situação no desenho | Prática atual | Prioridade | Fonte |
|---|---|---|---|---|
| Ordem de decisão | regras de usuário antes do revisor e do card | deny sempre vence allow, independente da especificidade; ask vence allow | Medium: definir explicitamente que deny vence, e que allow nunca pula o card de risco externo | [S5] |
| Shell com rede sem card na container (a) | roda sem card | rede por proxy com allowlist de domínio; domínio novo pede confirmação; rede desligada por padrão em Codex (snippet) | High: rede desligada por padrão; egress por proxy com allowlist exata de hostnames por bot; sem segredo no ambiente do shell; card para domínio novo | [S7][S14] |
| Shell com argumento em string | comando por texto (presumido) | regras de prefixo de texto são frágeis; recomendação oficial é isolamento | High: shell recebe argv estruturado e comparação exata de argv; sandbox é a fronteira real, não a string | [S5] |
| Revisor automático (hook) | interface sem modelo | classificador não vê resultados de ferramenta; bloqueio repetido volta a pedir; erro vira negação | High: revisor vê pedido do usuário e chamada, nunca resultado de ferramenta; erro vira card, não allow | [S6] |
| Revisor paralelo vs bloqueante | não especificado | guardrail paralelo pode permitir execução antes do tripwire | High: revisor síncrono e bloqueante antes de qualquer execução | [S10] |
| Regra "sempre permitir" | não especificado | regra de prefixo salva por subcomando; regra ampla vira alcance amplo | Medium: regra exata de ferramenta e campos; mostrar a regra antes de salvar; expiração; nenhuma regra ampla criada por padrão | [S5] |
| Negação devolvida ao modelo | como no desenho | Claude Code e Agents SDK devolvem bloqueio como resultado | Low: manter | [S6][S9] |
| Rascunho em vez de envio (e) | planejado | modo auto bloqueia envio de dado sensível para destino externo; remover a perna de comunicação externa é a mitigação mais simples | Medium: manter rascunho; envio é ação externa com card mostrando conteúdo exato; rascunho passa pelo scrubbing | [S6][S15 snippet] |
| Fadiga de aprovação | um card por vez | isolamento reduz prompts (84%, uso interno) | Medium: reduzir prompts por isolamento e não por regra ampla | [S7] |
| Log de decisões | append-only | não há prática verificada exigida | Low: manter; registrar versão da regra usada | inferência |

### Cofre

| Item | Situação no desenho | Prática atual | Prioridade | Fonte |
|---|---|---|---|---|
| Placeholder e substituição só em campos declarados | como no desenho | segredo injetado fora do LLM e do cliente (url mode); proxy fora do sandbox | Low: manter; é a forma correta | [S3][S7] |
| Scrubbing por comparação exata (c) | raw, base64, URL, hex | não é suficiente como única defesa; a proteção é não expor o valor | High: mapear onde o valor pode sair (saída, erro, log, stream, rede do shell); comparação exata com janela sobre fronteiras de chunk; scrub também em mensagens de erro e stack | inferência I2, I3 |
| Segredo no ambiente de shell com rede (a) | não especificado | proxy de credencial fora do sandbox | High: nenhum segredo no ambiente do shell; credencial de API só via proxy de injeção | [S7] |
| Pedido de segredo pelo bot | form escreve direto no cofre | url mode: credencial não passa por LLM nem cliente | Low: manter; não exibir valor no chat | [S3] |
| Criptografia AES-256-GCM e rotação | key id e chave em variável | não verificado nesta rodada | Medium: nonce único por gravação, chave fora da variável em produção (KMS ou equivalente); verificar | não verificado |

### Conectores MCP

| Item | Situação no desenho | Prática atual | Prioridade | Fonte |
|---|---|---|---|---|
| Ask por padrão | como no desenho | Cursor e Claude Code pedem aprovação por padrão | Low: manter | [S5][S12] |
| Annotations só endurecem (exceto opt-in) | como no desenho | spec: annotations não confiáveis salvo servidor confiável | Low: manter; sinalizar opt-in na UI | [S2] |
| Descrições e resultados não confiáveis | como no desenho | tratar descrição também como não confiável | Low: manter; estender a descrição (não só resultado) | [S2][S16] |
| Hash pinning da definição (b) | não implementado (presumido) | prática secundária recomendada; spec não define o caso | High: hash canônico (nome, descrição, schema, annotations, versão do servidor) na aprovação; mudança desabilita a tool até nova aprovação. Limite: não pega mudança de comportamento | [S18][S19] snippet; inferência I4 |
| Cross-server shadowing | namespacing `conn_<connector>__` | namespacing evita colisão, não indução | Medium: aprovação por tool; descrição de um conector não altera regra de outro | inferência I6 |
| OAuth para servidor remoto (d) | não implementado | OAuth 2.1, PKCE, RFC 8707, audiência validada, sem passthrough, CIMD antes de DCR, redirect_uri exato | Medium hoje; High antes de implementar: sem passthrough, tokens vinculados ao recurso, consentimento por cliente, sem cookie de consentimento | [S1][S4] |
| Stdio no host (f) | fora do sandbox, env mínimo, sem shell | spec de práticas: sandbox com privilégio mínimo; servidor de fonte não confiável é risco explícito | High: rodar stdio dentro de sandbox (bubblewrap ou container) com rede allowlist e só o env do conector | [S4] |
| Elicitation para segredos | não especificado | url mode para credencial; form não para dado sensível | Medium: usar url mode ou form do harness, nunca pelo modelo | [S3] |

Ponto de atenção sobre a regra do projeto: Claude Code usa wildcard em regra de Bash, glob em nome de tool e casamento por texto. Todos são padrões de texto. Recomendação compatível com a regra: comparação exata de argv e de nomes, hash de definição, canonização de caminho por componentes de diretório (não por prefixo de string), isolamento e, quando for preciso julgar intenção, um modelo como revisor com entrada declarada.
