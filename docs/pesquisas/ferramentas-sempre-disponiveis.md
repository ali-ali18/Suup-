# Ferramentas sempre disponíveis: custo e risco de escolha

Data de acesso: 25/11/2026.

## Pergunta

Vale oferecer a todo bot, em toda conversa, as ferramentas de memória (`remember`, `recall`, `forget`, `search_conversations`) e de busca na web (`web_search`, `web_read`), que hoje só são oferecidas quando estão na lista de ferramentas concedidas do bot? Quanto isso custa e há risco de piorar a escolha de ferramenta?

## Fontes lidas

Os endereços pedidos como `docs.claude.com` redirecionam (302) para `platform.claude.com`, que foi liberado nesta sessão. As leituras abaixo são das URLs finais.

1. Prompt caching. URL final lida: `https://platform.claude.com/docs/en/build-with-claude/prompt-caching`. [lido, leitura parcial: os primeiros 100 mil de cerca de 155 mil caracteres]
   - Prefixo: "Prompt caching covers the full prefix: `tools`, `system`, and `messages` (in that order), up to and including the block designated with `cache_control`."
   - Leitura: "Cache read tokens are 0.1 times the base input tokens price (see the table footnote for per-model exceptions)."
   - Gravação: "Cache write tokens with a 5-minute TTL are 1.25 times the base input tokens price."
   - Exceções: "Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input price." e "All other models use the standard 0.1x multiplier."
   - Invalidação: "Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache."
   - Exceção de beta: com o header `inline-tools-2026-09-15`, é possível adicionar ou alterar uma ferramenta no meio da conversa sem editar `tools`. [lido]

2. Tool use overview. URL final lida: `https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview`. [lido]
   - Custo: "These token counts are added to your normal input and output tokens to calculate the total cost of a request."
   - Origem dos tokens: "The `tools` parameter in API requests (tool names, descriptions, and schemas)".
   - Prompt de sistema de uso de ferramentas: "When you use `tools`, the API also automatically includes a special system prompt for the model that enables tool use."
   - Tabela, linhas de interesse: "Claude Haiku 5.5 | 286 tokens | 406 tokens"; "Claude Sonnet 5.5 | 286 tokens |"; "Claude Opus 5.5 | 286 tokens |". As colunas são `auto, none` e `any, tool`.

3. Tool search tool. URL final lida: `https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool`. [lido]
   - Escolha: "Claude's ability to pick the right tool degrades once you exceed 30–50 available tools. Because tool search loads only a focused set of relevant tools on demand, selection accuracy stays high even across thousands of tools."
   - Economia declarada: "Tool search typically reduces this by over 85 percent, loading only the 3–5 tools Claude needs for a given request." (exemplo de cinco servidores MCP, cerca de 55 mil tokens)
   - Quando usar: "You have 10 or more tools available." e "Your tool definitions consume more than 10k tokens."
   - Quando não usar: "Standard tool calling, without tool search, is a better fit when you have fewer than 10 tools, every tool is used in every request, or your tool definitions are small (less than 100 tokens total)."
   - `defer_loading`: "`defer_loading` controls what enters the context window, not what you send in the request: You still send every tool's full definition in the `tools` array on every request, including the deferred ones."
   - Cache: "A tool with `defer_loading: true` can't also carry `cache_control`: the API returns a 400. Put the cache breakpoint on a non-deferred tool."
   - Custo: "Tool search isn't metered as a separate server tool... the tool definitions that search loads into context count as input tokens like any other tool definition."

Fontes não lidas:
- `https://docs.anthropic.com/...` (três páginas): [não verificado] erro `getaddrinfo ENOTFOUND docs.anthropic.com`. Não resolve nesta sessão.
- `https://www.anthropic.com/pricing`: [não verificado] redireciona (301) para `https://claude.com/pricing`, host fora da lista permitida. Não seguido.
- Tabela oficial de preços absolutos por modelo: [não verificado] não foi aberta. Os preços absolutos usados abaixo são a referência interna.

## Conclusão para o Suup

1. Custo, com a referência interna (entrada 0,10; cache lido 0,01; gravação 0,125 US$/MTok, em `docs/TESTES-REAIS.md`). As razões 0,1x (leitura) e 1,25x (gravação) batem com os multiplicadores oficiais. Os valores absolutos não foram confirmados na página oficial. O número de ferramentas atuais e os tokens por definição do Suup são desconhecidos. Estimativa para +6 ferramentas, assumindo 150 a 300 tokens por definição [não verificado]:
   - Tokens extras por pedido: 900 a 1.800.
   - Sem cache: US$ 0,00009 a 0,00018 por pedido, ou US$ 0,09 a 0,18 por mil pedidos.
   - Com cache, em acerto de leitura: US$ 0,000009 a 0,000018 por pedido, ou US$ 0,009 a 0,018 por mil pedidos.
   - Gravação de cache: US$ 0,000113 a 0,000225 por gravação. Uma gravação custa o mesmo que 12,5 leituras do mesmo prefixo (1,25 / 0,1).
   - Conclusão de custo: em dinheiro o acréscimo é pequeno. O custo relevante é a invalidação do cache.
2. Cache e variação por bot: as ferramentas ficam no início do prefixo, e alterar a definição de uma ferramenta invalida todo o cache. Se cada bot tem uma lista concedida diferente, cada variação tem cache próprio e paga gravação. Se as 6 ferramentas são fixas, com a mesma definição e a mesma ordem em todos os bots, o cache é reaproveitado.
3. Efeito na escolha: a documentação diz que a precisão cai "once you exceed 30–50 available tools", e recomenda tool search com 10 ou mais ferramentas. Isso é uma afirmação do fornecedor, não uma medição no Suup. Se o total atual mais 6 passar de 10, o critério oficial sugere avaliar tool search. Se ficar abaixo de 10, o critério oficial não sugere isso. A conclusão depende do número atual, que não foi levantado.
4. Recomendação:
   - Contar as ferramentas concedidas hoje por bot e medir os tokens reais das definições.
   - Medir em evals a taxa de escolha errada com e sem as 6 ferramentas fixas.
   - Se o total passar de 10, avaliar tool search: as menos usadas com `defer_loading: true`, 3 a 5 não diferidas, e nenhum `cache_control` em ferramenta diferida.
   - Manter a lista de ferramentas idêntica e na mesma ordem entre bots para o cache valer.
   - Verificar se o provedor usado pelo Suup é a API da Anthropic. Os números acima valem para ela. O repositório tem outro provedor (ChatGPT), para o qual nada foi verificado.
5. Overhead fixo do prompt de uso de ferramentas: 286 tokens (modo `auto`) e 406 (modo `any` ou `tool`) para Haiku 5.5, segundo a tabela. Esse valor aparece quando há ferramentas no pedido e não depende das 6 ferramentas extras.

## O que não foi verificado

- Preços absolutos oficiais por modelo, incluindo Haiku 5.5. Usei a referência interna.
- Número atual de ferramentas concedidas e tokens reais por definição no Suup. A estimativa de 150 a 300 tokens por definição é um pressuposto.
- Os números internos citados (86% do cache, cerca de 9 mil tokens em M4) não foram reconferidos nesta pesquisa.
- Efeito real na escolha de ferramenta no Suup: não medido.
- Restante da página de prompt caching (cerca de 55 mil caracteres não lidos).
- Página "Tool use with prompt caching", referenciada pela página de tool search, não aberta.
- Disponibilidade de tool search e do header `inline-tools-2026-09-15` no provedor usado pelo Suup.
- Afirmações do fornecedor sobre 30 a 50 ferramentas e 85% de economia: não medidas aqui.
