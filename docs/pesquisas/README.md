# Pesquisas por etapa do plano

Regra do dono (`docs/REGRAS.md`): **cada etapa do plano ganha uma pesquisa confiável, para validar a ideia antes de implementar.** Uma pesquisa por fase ou entrega significativa de `docs/PLANO.md`, salva aqui como `docs/pesquisas/<fase>-<tema>.md` (por exemplo, `fase-3-aprovacoes.md`) e ligada a partir da seção do plano que ela valida.

## Formato

Cada arquivo tem, nesta ordem:

1. **Pergunta**: o que se quer validar, numa frase (como produtos, APIs e especificações atuais resolvem isto?).
2. **Fontes**: só fontes primárias (documentação oficial, especificações, artigos de engenharia dos autores, artigos científicos). Cada uma com título, URL e **data de acesso** (e a data da fonte, quando houver).
3. **Fatos verificados**: o que as fontes dizem, cada afirmação com a sua fonte (URL e data). Só o que foi lido de fato.
4. **Inferências**: o que se conclui a partir dos fatos. Separado dos fatos e marcado como inferência.
5. **O que não foi verificado**: o que não deu para conferir (fonte inacessível, sem documentação pública, versão diferente). Escreva "não verificado"; nunca preencha lacuna com palpite.
6. **Implicação para o Suup**: o que muda (ou confirma) no plano. Se a pesquisa **contradiz** o desenho planejado, o plano é mudado (ou o dono é consultado) **antes** de escrever código.

## Quando

Antes de desenhar ou implementar uma fase ou entrega significativa. Uma correção pequena não precisa de pesquisa; na dúvida, faça.
