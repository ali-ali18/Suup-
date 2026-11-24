# WebMCP: o que é, estado atual e uso no Suup

**Pergunta.** O que é o WebMCP, quem o mantém, em que estado está e como um agente o consome? Ele serve ao Suup como ferramenta de busca, ou para o leitor de páginas (`web_read`, com `render`) e o navegador da fase 5?

**Data de acesso:** 24/11/2026, por `curl -sL`, salvo onde indicado. Cada fato traz a marca **[lido]** (conferido no texto da fonte) ou **[não verificado]**.

---

## Fontes

1. **WebMCP, especificação** (W3C Web Machine Learning Community Group). Draft Community Group Report, "24 November 2026". https://webmachinelearning.github.io/webmcp/ . Acesso 24/11/2026. Data da fonte: 24/11/2026 (cabeçalho).
2. **README do repositório oficial**, `webmachinelearning/webmcp`. https://raw.githubusercontent.com/webmachinelearning/webmcp/main/README.md . Acesso 24/11/2026.
3. **Browser and Agent Implementation Status**, mesmo repositório. https://raw.githubusercontent.com/webmachinelearning/webmcp/main/implementation-status.md . Acesso 24/11/2026. Data da fonte: não indicada.
4. **Chrome for Developers, "WebMCP"** (AI in Chrome). https://developer.chrome.com/docs/ai/webmcp . Acesso 24/11/2026. Publicado em 18/05/2026; atualizado em 07/10/2026.
5. **Chrome for Developers (blog), "WebMCP is available for early preview".** https://developer.chrome.com/blog/webmcp-epp . Acesso 24/11/2026. Publicado em 10/02/2026.
6. **Chrome for Developers (blog), "Join the WebMCP origin trial".** https://developer.chrome.com/blog/ai-webmcp-origin-trial . Acesso 24/11/2026. Publicado em 09/06/2026.
7. **Microsoft Learn, Microsoft Edge (página inicial).** https://learn.microsoft.com/en-us/microsoft-edge/ . Acesso 24/11/2026. Só a página inicial foi lida: não menciona WebMCP.
8. **Blogs do Windows (página inicial).** https://blogs.windows.com/ . Acesso 24/11/2026. Só a página inicial foi lida: não menciona WebMCP.
9. **Model Context Protocol (página inicial).** https://modelcontextprotocol.io/ . Acesso 24/11/2026. Só a página inicial foi lida: não menciona WebMCP.
10. **GitHub Blog (página inicial).** https://github.blog/ . Acesso 24/11/2026. Só a página inicial foi lida: não menciona WebMCP.

**Tentativas que não deram leitura:**
- `https://github.com/webmachinelearning/webmcp` (repositório e explicador): resposta 403 do proxy. O host `github.com` não está na lista de hosts permitidos para esta pesquisa; fiz uma tentativa e não insisti. O explicador ficou **[não verificado]**.
- `https://webmachinelearning.github.io/webmcp/explainer`: resposta HTTP 503.
- `https://webmachinelearning.github.io/webmcp/implementation-status.html`: 404 (usei a versão `raw` do mesmo arquivo, fonte 3).
- `https://developer.microsoft.com/` (origin trial do Edge, citado pela fonte 3): host fora da lista permitida; **não consultado**.

---

## Fatos verificados

### 1. O que é

- **[lido, fonte 2]** "WebMCP lets developers expose web application functionality as 'tools'—JavaScript functions with natural language descriptions and structured schemas, designed for AI agent ingestion."
- **[lido, fonte 1]** "Web pages that use WebMCP can be thought of as Model Context Protocol [MCP] servers that implement tools in client-side script instead of on the backend."
- **[lido, fonte 4]** "WebMCP is a proposed web standard to help you build and expose structured tools for AI agents."

### 2. Quem está por trás e estado

- **[lido, fonte 1]** Editores listados: Brandon Walderman (Microsoft), Khushal Sagar (Google), Dominic Farolino (Google) e Samuel Dallstream (Microsoft). O documento é publicado pelo Web Machine Learning Community Group do W3C.
- **[lido, fonte 1]** "It is not a W3C Standard nor is it on the W3C Standards Track."
- **[lido, fonte 4]** "WebMCP is under active discussion and subject to change in the future."
- **[lido, fontes 1 e 3]** O status é de rascunho de grupo comunitário (Draft). A origin trial está ativa no Chrome 149 e no Edge 150 (ver item 4).

### 3. Forma da API

- **[lido, fonte 1, IDL]** A interface fica em `document`: `partial interface Document { [SecureContext, SameObject] readonly attribute ModelContext modelContext; };`. O acesso é `document.modelContext`.
- **[lido, fonte 1, IDL]** A interface `ModelContext` tem `registerTool(tool, options)` (retorna `Promise<undefined>`), `waitForToolsUntil(promise)`, `getTools(options)` (retorna `Promise<sequence<Tool>>`) e `executeTool(tool, inputObject, options)` (retorna `Promise<DOMString>`). Tem também os eventos `ontoolchange`, `ontoolactivated` e `ontoolcancel`.
- **[lido, fonte 1]** O dicionário `ModelContextTool` tem `name` (obrigatório, de 1 a 128 caracteres: letras ASCII, dígitos, `_`, `-` e `.`), `title`, `description` (obrigatório), `inputSchema` e `outputSchema` (JSON Schema), `execute` (obrigatório) e `annotations`.
- **[lido, fonte 1, §6.4.4–6.4.5]** As anotações citadas são `readOnlyHint`, `untrustedContentHint` e `consequentialHint`.
- **[lido, fonte 1]** `registerTool()` rejeita um nome já registrado no mesmo contexto.
- **[lido, fonte 2, exemplo]** `await document.modelContext.registerTool({ name: "filter-templates", description: "...", inputSchema: {...}, execute({ description }) { ... } });`
- **[lido, fontes 1 a 6]** Os nomes `navigator.modelContext` e `provideContext` não aparecem em nenhuma das fontes lidas. **A premissa de que a API é `navigator.modelContext` com `provideContext` não se confirma.** O nome atual é `document.modelContext` com `registerTool`.
- **[lido, fonte 2 e fonte 4]** Declarative API: a fonte 2 diz "A declarative API based on HTML `<form>` elements is also being explored". A fonte 4 descreve as duas APIs e aponta uma demo de formulário declarativo. A especificação lida (fonte 1) só tem a API imperativa.

### 4. Suporte de navegadores (24/11/2026)

- **Chrome.** **[lido, fonte 3]** "An Origin Trial is live in Chrome 149." **[lido, fonte 6]** "In Chrome 149, you can sign up for the WebMCP origin trial." A origin trial é um programa de prazo limitado, com uso restrito.
- **Chrome, flag para teste local.** **[lido, fonte 4]** "Open Chrome and navigate to chrome://flags/#enable-webmcp-testing. Set the flag to Enabled. Relaunch Chrome." A fonte 3 cita `about:flags#enable-webmcp-testing`.
- **Chrome, early preview.** **[lido, fonte 5]** Publicado em 10/02/2026 como "available for early preview".
- **Edge.** **[lido, fonte 3]** "An Origin Trial is live in Edge 150. Refer to Chrome implementation status for platform support."
- **Brave.** **[lido, fonte 3]** "WebMCP is supported in Leo AI chat as of the Brave 1.102.2 release (expected on January 5, 2027)." A data é futura em relação a hoje; registro como afirmação da fonte, não como fato.
- **ChatGPT Desktop.** **[lido, fonte 3]** "WebMCP is supported in ChatGPT Desktop." Sem versão indicada.
- **Meta Ray-Ban Display.** **[lido, fonte 3]** "coming soon", desligado por padrão e habilitado por dispositivo.
- **Firefox e Safari.** **[lido, fonte 3]** Só há links para issues de posição de padrões (Mozilla e WebKit), sem status declarado. **[não verificado]** quanto ao estado real.
- **Chromium do Playwright.** **[não verificado]**. As fontes falam do Chrome. Não verifiquei se o Chromium empacotado pelo Playwright tem a flag ou a origin trial. O leitor do Suup usa a imagem `mcr.microsoft.com/playwright:v1.65.1-noble` (`docs/BUSCA.md`), cuja versão de Chromium não foi checada.

### 5. Como um agente consome

- **[lido, fonte 1, §2]** "A browser agent is an agent provided by or through the browser that could be built directly into the browser or hosted by it, for example, via an extension or plug-in."
- **[lido, fonte 1, §1]** As ferramentas podem ser invocadas por "agents, browser's agents, and assistive technologies".
- **[lido, fonte 1, §5.2]** "The browser agent, on the other hand, does not run JavaScript on the page. Instead, it obtains a view of the page's tools ... by getting an observation." Ou seja, o agente de navegador lê uma observação da página, e não executa JavaScript dela.
- **[lido, fonte 1, §5.2]** "In-page agents implemented in JavaScript can 'observe' the tools that a page offers by using the ModelContext APIs directly." Logo, um agente também pode rodar dentro da própria página.
- **[lido, fonte 4]** "Clients and browsers must visit a site directly to know if it has callable tools." A descoberta é por página visitada.
- **[lido, fonte 1, `getTools`]** `getTools()` agrega as ferramentas dos documentos do mesmo origin (e frames), e `fromOrigins` permite pedir outras origens quando permitido.
- **[lido, fonte 4]** "Chrome Extensions can query and execute WebMCP tools with content scripts." A documentação oficial cita duas extensões de demonstração do Chrome; elas exigem chave de API de um provedor de modelo.
- **[lido, fonte 1, Goals]** "Headless browsing scenarios: Tools exposed for human-in-the-loop can also be used for task completion in headless scenarios."
- **[lido, fonte 4, Limitations]** "Headless browsing: While it may be possible to run WebMCP tools in headless environments, this API is primarily designed for local browser workflows with a human in the loop."
- **[lido, fonte 1, Non-Goals]** "Fully autonomous workflows: The API is not intended for fully autonomous agents where a browser UI is not present."
- **[lido, fonte 1, §5.2]** A exposição das ferramentas ao agente de navegador é "implementation-defined" (definida pela implementação). O texto lido não diz como o navegador pede permissão ao usuário. **[não verificado]** o fluxo de consentimento do Chrome.
- **[lido, fonte 4]** Política de permissões: "The policy defaults to self, which allows tool registration in top-level and same-origin contexts, and disables it for cross-origin iframes. To allow WebMCP tools in a cross-origin iframe, add the allow="tools" attribute."

### 6. Relação com MCP e com as abordagens por extensão (MCP-B)

- **[lido, fonte 1]** "WebMCP is designed to complement, not replace, existing backend-focused protocols like MCP." (Non-Goals, "Replacement of backend integrations".)
- **[lido, fonte 1]** As integrações de backend (MCP, OpenAPI) são descritas como o caso que WebMCP complementa, e não substitui.
- **[lido, fonte 9]** A página inicial do modelcontextprotocol.io não menciona WebMCP. Só a página inicial foi lida.
- **[não verificado]** MCP-B ou qualquer abordagem por extensão mantida por terceiros. Nenhuma das fontes oficiais lidas cita MCP-B. Não pesquisei fora das fontes permitidas.

### 7. Segurança e privacidade (especificação, §6)

- **[lido, fonte 1, §6.2]** "Identity inheritance: Agents are able to inherit user identity and authentication context from the browser. When an agent visits a website, it carries the user's logged-in credentials and session state."
- **[lido, fonte 1, §6.3.1]** "Prompt injection represents a threat to WebMCP where malicious instructions are embedded in tool metadata, inputs, or outputs to manipulate agent behavior." Os subitens tratam de *tool poisoning* (§6.3.1.1), *output injection* (§6.3.1.2) e de ferramentas como alvo (§6.3.1.3).
- **[lido, fonte 1, §6.3.2]** "There is no guarantee that a WebMCP tool's declared intent matches its actual behavior." O exemplo `finalizeCart` tem descrição "Intentionally ambiguous" e dispara uma compra.
- **[lido, fonte 1, §6.3.3]** Vazamento de privacidade por sobre-parametrização (*over-parameterization*): ferramentas podem pedir dados que o agente pode ter de outras origens.
- **[lido, fonte 1, §6.3.4]** "By default, WebMCP enforces strict same origin isolation." Para origens cruzadas, há três portões independentes, entre eles `allow="tools"` e o opt-in do dono da ferramenta. O §6.3.4 também trata de transferência de estado entre origens pelo agente.
- **[lido, fonte 1, §6.3.5]** Modos de navegação privada: a especificação alerta que expor ferramentas a agentes em navegação privada pode vazar dados entre o modo privado e o perfil principal.
- **[lido, fonte 1, §6.4.1]** Mitigação: "Site authors can deliver a Permissions-Policy: tools=() response header", que desativa WebMCP no documento e nos descendentes.
- **[lido, fonte 1, §6.4.4]** `untrustedContentHint`: sinal para o cliente tratar a saída com cuidado (sanitizar, marcar ou ocultar o conteúdo).
- **[lido, fonte 1, §6.4.5]** `consequentialHint`: sinal de que a ferramenta tem consequência real (por exemplo, reservar voo ou transferir dinheiro), para que o agente imponha "mandatory user confirmation prompts" antes de executar.
- **[lido, fonte 1, §6.4.2, 6.4.3 e 6.4.6]** Apenas os títulos foram lidos: limite de tamanho de entrada, defesas probabilísticas com conjuntos de avaliação e guardrails no nível do agente. **[não verificado]** o conteúdo desses trechos.
- **[lido, fonte 1, §6.3.2 e §6.4.5]** A especificação deixa a confirmação ao agente ("they can selectively enforce"). Não vi uma exigência de consentimento do navegador nas partes lidas.

### 8. Adoção

- **[lido, fonte 4]** Demos publicados pelo Chrome: "WebMCP zaMaker" (imperativa), "Travel demo (React)" (imperativa) e "Le Petit Bistro demo" (declarativa).
- **[lido, fonte 4]** "Several major frameworks have experimental support for WebMCP, including React, Angular, and Vue."
- **[não verificado]** Sites em produção que publicam ferramentas WebMCP. Nenhuma fonte lida lista sites reais. O painel de testes `wpt.fyi/results/webmcp` (citado na fonte 1) não foi lido.

### 9. Busca

- **[lido, fontes 1 a 6]** Nenhuma das fontes lidas descreve um índice de ferramentas entre sites, uma API de busca ou uma consulta a um catálogo global. A descoberta é por página aberta (ver item 5).

---

## Inferências

1. **WebMCP não é ferramenta de busca.** As ferramentas são registradas pelo próprio site, dentro da página, e só existem enquanto a página está aberta e o JavaScript dela rodou. Não há como perguntar "quem tem ferramenta X" entre sites. A hipótese do dono, "não", está correta.
2. **Não substitui `web_search` nem `web_read`.** Para uma página pública lida pelo Suup, as ferramentas WebMCP só aparecem depois que o JavaScript da página roda e só se o site as registrou. Quase todas as páginas não terão nenhuma.
3. **O uso previsto é com humano na tela.** A especificação diz que não é para agente autônomo sem interface, e a documentação do Chrome diz que o foco é fluxo local com humano. O leitor do Suup é um agente autônomo em contêiner, sem interface e sem sessão do usuário. Usar WebMCP ali sai do desenho que o padrão descreve.
4. **O leitor do Suup não tem a identidade do usuário.** Pela especificação (§6.2), o agente de navegador herda a sessão do usuário. O leitor do Suup roda sem cookies entre páginas (`docs/BUSCA.md`, linha 216), então as ferramentas de áreas logadas não estariam acessíveis lá. Esta é uma inferência a partir dos dois textos.
5. **Usar WebMCP não é contornar proteção.** O site opta por expor as ferramentas (`registerTool`), e pode desligá-las com `tools=()`. Mas executar uma ferramenta com efeito real (`consequentialHint`) em nome do dono é ação que deve passar pelo portão de aprovação do Suup.
6. **Como o Suup não é um navegador, o caminho seria dirigir o Chromium do Playwright.** A especificação não diz se um script externo pode chamar `document.modelContext.executeTool` por `page.evaluate`. **[não verificado]**.

---

## O que não foi verificado

- Se o Chromium do Playwright (imagem `v1.65.1-noble`) tem a flag `enable-webmcp-testing` ou a origin trial.
- O fluxo de consentimento do Chrome antes de um agente executar uma ferramenta.
- O explicador do repositório (github.com não está na lista permitida e o site do W3C deu 503).
- Estado real de Firefox e Safari.
- MCP-B e abordagens por extensão de terceiros (sem fonte oficial lida).
- Sites reais que publicam ferramentas WebMCP.
- Os trechos §6.4.2, §6.4.3 e §6.4.6 da especificação, além dos títulos.
- A página de origin trial do Edge (host fora da lista permitida).
- A data de Brave 1.102.2 ("January 5, 2027") é futura em relação a esta pesquisa; registrada como afirmação da fonte.

---

## Implicação para o Suup

**É ferramenta de busca?** Não. A premissa do dono se confirma. WebMCP expõe ações e leituras de um site aberto, registradas pelo próprio site. Não indexa nem pesquisa a web. Para `web_search` e `web_read`, Tavily, Brave e SearXNG continuam sendo o caminho.

**Serve ao leitor ou ao navegador agora?** Não, agora. Recomendo tratar como **item futuro**, com três condições antes de qualquer código:
1. Confirmar que o Chromium usado pelo Suup (Playwright) suporta a API, por flag ou origin trial, na versão da imagem do leitor.
2. A especificação sair do rascunho ou ter API estável; a fonte diz que pode mudar.
3. Haver um caso concreto do dono, em um site que ele usa, com ferramentas publicadas.

Se um dia for feito, o escopo mínimo e seguro seria só **ler** as ferramentas declaradas de uma página já lida (`getTools`, com `readOnlyHint`), como dado extra de `web_read`, sem executar nenhuma. Executar fica para um passo posterior, com aprovação.

**Riscos a tratar se for feito:**
1. **Injeção pela descrição ou pela saída da ferramenta.** Tratar descrições e saídas como dado não confiável. Respeitar `untrustedContentHint`, e nunca deixar o texto de uma ferramenta virar instrução ao modelo.
2. **Ação com efeito.** Qualquer ferramenta com `consequentialHint`, ou que altere estado, deve passar pelo portão de aprovação (`docs/APROVACOES.md`). O agente não executa sem confirmação do dono.
3. **Classificação pelos campos declarados, não pelo texto.** Decidir se uma ferramenta é leitura ou ação só pelas anotações declaradas (`readOnlyHint`, `consequentialHint`), com comparação exata. Não casar padrão na descrição: isso é a regra de `docs/REGRAS.md` §1 e de `CLAUDE.md`.
4. **Vazamento entre origens.** O Suup não pode levar dado de uma origem como argumento de uma ferramenta de outra (especificação §6.3.3 e §6.3.4).
5. **Respeitar a recusa do site.** Página com `Permissions-Policy: tools=()` fica fora do alcance. Não tentar ativar flags ou origin trial em sites alheios.
6. **Superfície do contêiner.** Habilitar a flag no Chromium do leitor (que roda com `--no-sandbox`, `docs/BUSCA.md`) muda a superfície de ataque. Só com revisão própria.
7. **Não contornar.** WebMCP é opt-in do site. Usá-lo onde o site o expõe é consistente com "nunca contornar proteção". Criar ferramentas em nome de terceiros, ou forçar a exposição em sites que não as declaram, não é.

**Registro no plano.** Nada muda no plano hoje. Sugiro incluir WebMCP como item futuro em `docs/PLANO.md`, ligado a esta pesquisa, com as três condições acima.
