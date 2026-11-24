# Motor de pesquisa (deep research) para os bots

**Origem:** relatório técnico trazido pelo dono em 24/11/2026 (escrito fora deste repositório). Guardado aqui como **entrada** para a fase que vier implementar o motor de pesquisa; **ainda não vale como pesquisa da regra §2**: as fontes citadas abaixo precisam ser abertas e lidas antes do código (marcar cada uma como lida, com data).

## Ideia central

Pesquisa profunda é um loop do agente, não um RAG maior nem um fluxo fixo: **esclarecer o pedido → resumo da pesquisa (brief) → dividir em subtemas → buscar e ler (em paralelo quando os subtemas são independentes) → refletir sobre o que falta → repetir dentro de um orçamento → escrever o relatório de uma vez só → conferir as citações** contra um conjunto único de fontes lidas.

## O que adotar no Suup (proposta do relatório, a validar)

1. **Camada de busca plugável com troca automática** (`SearchProvider` + cadeia de failover). Casa com a pesquisa `fase-4-busca-alternativas-ao-ddg.md` (Tavily/Brave lidas em 24/11) e com a remoção do DuckDuckGo.
2. **Conjunto de fontes por pesquisa** (`SourcePool`): URL normalizada sem duplicar, numeração global `[S1]`, **só cita o que foi lido de verdade** (o Suup já exige proveniência no `web_read`).
3. **Orçamento como condição de parada** (rodadas, buscas, leituras, tokens, tempo), com presets rápido / padrão / profundo; estourou, escreve com o que tem. Liga no `costCap` das rotinas.
4. **Escrita em uma passada** depois da pesquisa (escrever seções em paralelo dá relatório desconjuntado).
5. **Verificação das citações** em etapa separada: o id existe e o trecho sustenta a afirmação.
6. **Subagentes só para subtemas independentes**, usando o supervisor e a delegação que já existem; modelo menor nos subagentes.
7. **Estado em memória persistente** (brief, fontes, achados por rodada): retomar de onde parou.
8. **Avaliação desde o início:** ~20 perguntas reais e um juiz com 5 eixos (acerto dos fatos, acerto das citações, completude, qualidade das fontes, uso das ferramentas); conferência humana periódica (fazendas de SEO passam pelo juiz).

Ordem sugerida: busca plugável (desbloqueia tudo) → conjunto de fontes e leitura com cache → loop de um agente só → verificação de citações → subagentes → avaliação → refinos (aprovar o plano antes, perspectivas no estilo STORM).

## Divergências com o que já foi lido

- O relatório diz que o crédito gratuito da Brave **acabou** (relato de terceiro, não página oficial); a leitura da página oficial em 24/11 (`fase-4-busca-alternativas-ao-ddg.md`) registrou crédito de US$ 5/mês. **Conferir de novo antes de decidir.**
- O relatório sugere SearXNG próprio como reserva gratuita; a nossa pesquisa mostrou que os outros motores dentro do SearXNG (Mojeek, Qwant) ferem a regra de não contornar proteções. **Não adotar sem rever.**
- "Rotacionar user-agent" aparece só como o que *não* funciona; o Suup não faz isso de jeito nenhum.

## Fontes a ler antes do código

- Anthropic, multi-agent research system: https://www.anthropic.com/research/multi-agent-research-system
- Anthropic, building effective agents: https://www.anthropic.com/research/building-effective-agents
- LangChain, Open Deep Research: https://www.langchain.com/blog/open-deep-research
- GPT Researcher: https://docs.gptr.dev/blog/building-gpt-researcher
- OpenAI, deep research: https://openai.com/index/introducing-deep-research/
- Google, Gemini Deep Research: https://ai.google.dev/gemini-api/docs/deep-research
- Hugging Face, open deep research: https://huggingface.co/blog/open-deep-research
- Stanford STORM: https://github.com/stanford-oval/storm
- Jina node-DeepResearch (TypeScript): https://github.com/jina-ai/node-DeepResearch
- OpenAI BrowseComp: https://openai.com/index/browsecomp/
- Citações fabricadas: https://www.nature.com/articles/s41598-023-41032-5 e https://arxiv.org/abs/2505.18059
- SearXNG issue do captcha do DDG: https://github.com/searxng/searxng/issues/3927
