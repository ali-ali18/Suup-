# Pesquisa: muitas ferramentas de conectores MCP sem pesar o contexto

Data da pesquisa: 19/11/2026. Valida a entrega "pesquisa de ferramentas" da fase 3 (`docs/PLANO.md`, seção 4.11).

## Pergunta

Quando um bot tem acesso a centenas de ferramentas de conectores MCP, como os produtos e as APIs atuais evitam mandar todas as definições ao modelo em todo turno, e com que custo?

## Fontes

Lidas diretamente em 19/11/2026:

- Anthropic, "Tool search tool" (documentação da API, sem data): https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Anthropic, "Tool use with prompt caching" (documentação, sem data): https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
- Anthropic, "Advanced tool use" (24/11/2025): https://www.anthropic.com/engineering/advanced-tool-use
- Anthropic, "Code execution with MCP" (04/11/2025): https://www.anthropic.com/engineering/code-execution-with-mcp
- Claude Code, MCP (documentação, sem data): https://code.claude.com/docs/en/mcp
- OpenAI, guia de tool search (sem data): https://developers.openai.com/api/docs/guides/tools-tool-search
- OpenAI, prompt caching (sem data): https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI, conectores e MCP (sem data): https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- Especificação do MCP, versão 2026-07-28, ferramentas e paginação: https://modelcontextprotocol.io/specification/latest/server/tools e https://modelcontextprotocol.io/specification/latest/server/utilities/pagination
- MCP, proposta SEP-1821 "Dynamic Tool Discovery" (aberta em 17/11/2025, fechada em 24/06/2026): https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1821
- GitHub, "How we're making GitHub Copilot smarter with fewer tools" (19/11/2025): https://github.blog/ai-and-ml/github-copilot/how-were-making-github-copilot-smarter-with-fewer-tools/
- RAG-MCP, arXiv:2505.03275 (06/05/2025), só o resumo: https://arxiv.org/abs/2505.03275

## Fatos verificados

### Anthropic

- A API tem carregamento adiado: marca-se a ferramenta com `defer_loading: true` e inclui-se uma ferramenta de busca. Há duas variantes hospedadas, uma por regex escrito pelo modelo e outra por BM25; também é possível fazer a busca do lado do cliente, devolvendo blocos `tool_reference`.
- Antes da busca, as ferramentas adiadas não estão no contexto do modelo. Depois dela, a API "expande automaticamente essas referências em definições completas": a ferramenta fica chamável de forma nativa, com o esquema real.
- O cache é preservado: "Deferred tools are not included in the system-prompt prefix. When the model discovers a deferred tool through tool search, the definition is appended inline as a `tool_reference` block in the conversation history. The prefix is untouched, so prompt caching is preserved."
- Mudar a lista de ferramentas invalida o cache inteiro: a hierarquia é `tools` → `system` → `messages`, e "Modifying tool definitions" invalida "Entire cache".
- Recomendação de uso: a partir de 10 ferramentas, ou de 10 mil tokens de definições, ou ao juntar vários servidores MCP. A documentação afirma, sem citar fonte, que a escolha piora acima de 30 a 50 ferramentas.
- Números da própria Anthropic: de cerca de 77 mil para 8,7 mil tokens (85%); acerto na escolha de 49% para 74% num modelo e de 79,5% para 88,1% em outro. São avaliações internas.
- Claude Code: busca de ferramentas ligada por padrão; "Only tool names and server instructions load at session start". No modo automático, as ferramentas carregam de início enquanto as definições somam menos de 10% da janela. Um servidor pode ser marcado para carregar sempre. Descrições têm teto de caracteres.
- Alternativa descrita: o agente escreve código contra as ferramentas, lendo só os arquivos de que precisa (98,7% de economia num exemplo). O próprio texto diz que isso exige ambiente de execução seguro, com custo operacional.

### OpenAI

- Existe `tool_search` na Responses API, "only gpt-5.4 and later models". Usa `defer_loading: true` em funções ou no servidor MCP, com namespaces recomendados ("fewer than 10 functions" por namespace).
- Antes de carregar, o modelo vê nome e descrição do que é pesquisável; para uma função adiada, o que fica de fora é sobretudo o esquema de parâmetros.
- O carregamento preserva o cache: "When new tools are discovered by the model, they are injected at the end of the context window."
- As ferramentas fazem parte do prefixo em cache; mudar nomes, descrições, esquemas ou ordem quebra o reaproveitamento.
- No MCP hospedado, `allowed_tools` importa só um subconjunto das ferramentas de um servidor, por custo e latência.

### Especificação do MCP (2026-07-28)

- Não há busca, filtro ou agrupamento de ferramentas como primitiva. A proposta SEP-1821 foi fechada sem resultado claro.
- `listChanged` avisa quando a lista muda; a paginação de `tools/list` tem tamanho de página decidido pelo servidor.
- "Servers SHOULD return tools in a deterministic order", citando o cache de prompt.
- "Clients MUST consider tool annotations to be untrusted unless they come from trusted servers."

### Outros

- GitHub Copilot: "ferramentas virtuais" que agrupam as relacionadas e se expandem sob demanda; conjunto embutido reduzido de 40 para 13. Cobertura de uso de ferramentas num teste offline: 94,5% com agrupamento por embeddings contra 69,0% com a lista inteira.
- RAG-MCP (resumo): recuperar ferramentas antes de mostrá-las cortou mais de 50% dos tokens e levou o acerto de 13,62% para 43,13% num teste de estresse próprio.

## Inferências

- Os dois grandes provedores convergiram para o mesmo desenho: índice leve, busca, e a definição completa injetada no fim da conversa para não quebrar o cache. O Suup deve usar o mecanismo nativo de cada provedor onde ele existir.
- A liberação por ferramenta (o equivalente a `allowed_tools`) é prática corrente e independente da busca.
- Uma ferramenta genérica `usar_ferramenta(nome, argumentos)`, com o esquema entregue como texto, mantém a lista estável e funciona em qualquer provedor, mas perde o esquema nativo. Serve como caminho para provedores sem carregamento adiado, com validação dos argumentos pelo harness.

## O que não foi verificado

- Nenhuma medição comparando a ferramenta genérica com a definição nativa foi encontrada; não há evidência a favor nem contra.
- Número máximo de ferramentas documentado pela OpenAI; detalhes do carregamento adiado na API de agentes dela.
- Comportamento atual de Cursor, Gemini CLI e opencode com muitas ferramentas.
- Os valores por tamanho de catálogo do RAG-MCP (só o resumo foi lido).

## Implicação para o Suup

| Decisão | Base |
|---|---|
| Liberar ferramentas de conector uma a uma por bot | Prática corrente (`allowed_tools`); independe de provedor |
| Com provedor que tem carregamento adiado, usar o mecanismo nativo | Esquema real e cache preservado, verificados nos dois provedores |
| Sem esse recurso, usar busca mais ferramenta genérica com validação pelo harness | Mantém a lista estável; confiabilidade ainda não medida |
| Não usar a variante de busca por regex | Regra do projeto (`docs/REGRAS.md`); usar ranqueamento por palavras ou busca do nosso lado |
| Só ligar a busca acima de um limite de tamanho; abaixo dele, carregar direto | Recomendação dos provedores (10 ferramentas ou 10 mil tokens; 10% da janela) |
| Devolver as ferramentas em ordem determinística | Recomendação da especificação, por causa do cache |
| Medir tokens de definição por pedido no diagnóstico | Para decidir com dado, não com estimativa |
| Medir com modelo real a taxa de erro de argumentos da ferramenta genérica | Lacuna de evidência encontrada |
