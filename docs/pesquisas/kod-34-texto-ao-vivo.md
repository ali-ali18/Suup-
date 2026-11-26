# Pesquisa KOD-34: texto da resposta aparecendo em tempo real (streaming)

Data da leitura das fontes: 25/11/2026 (todas lidas nesta data).
Escopo: bolha do bot que "digita" a resposta, com o texto final gravado no `run_events` ao fim do turno. Texto parcial nunca vira mensagem gravada.

Regra de método: só entram como fonte as páginas que de fato li. Buscador não conta. Onde não houve leitura, a resposta está marcada como **raciocínio próprio**.

---

## Fontes

Todas lidas via `curl -sL` (HTTP 200) e convertidas para texto. A rede da sessão liberou os hosts numa segunda rodada.

| # | Fonte | URL | Data |
|---|---|---|---|
| F1 | Anthropic, Streaming Messages | https://platform.claude.com/docs/en/build-with-claude/streaming | 25/11/2026 |
| F2 | Vercel AI SDK, Chatbot Resume Streams | https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams | 25/11/2026 |
| F3 | GitHub Docs, Using secrets in GitHub Actions | https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions | 25/11/2026 |
| F4 | WHATWG HTML, Server-sent events | https://html.spec.whatwg.org/multipage/server-sent-events.html | 25/11/2026 |
| F5 | PostgreSQL, NOTIFY | https://www.postgresql.org/docs/current/sql-notify.html | 25/11/2026 |
| F6 | PostgreSQL, LISTEN | https://www.postgresql.org/docs/current/sql-listen.html | 25/11/2026 |
| F7 | Vercel AI SDK, useChat reference | https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat | 25/11/2026 |
| F8 | OWASP Cheat Sheet Series, Logging | https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html | 25/11/2026 |
| F9 | MDN, prefers-reduced-motion | https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion | 25/11/2026 |
| F10 | MDN, aria-live | https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes/aria-live | 25/11/2026 |

Nota sobre a primeira rodada: F4 a F10 falharam nela (403 do proxy ou DNS não resolvido). Na segunda rodada, com os hosts liberados, todas responderam 200.

---

## Respostas

### 1. Anthropic streaming: eventos e índice de bloco (F1)

- Sequência por bloco: um `content_block_start`, zero ou mais `content_block_delta`, e um `content_block_stop`. Cada bloco tem um `index` que corresponde à posição dele no array `content` da mensagem final.
- Bloco de texto: o `content_block_start` traz `"content_block": {"type": "text", "text": ""}`. Os deltas são `{"type": "text_delta", "text": "..."}`.
- Os fragmentos não respeitam palavras. O exemplo da própria página tem `"ello frien"`. Um segredo pode ser cortado em qualquer ponto entre dois deltas.
- `ping` pode aparecer em qualquer lugar do stream e deve ser ignorado.
- Erro no meio do stream chega como evento `error` (ex.: `overloaded_error`). Com o SDK, o stream termina com exceção.
- Tool use usa `input_json_delta` com JSON parcial. Não se aplica ao texto da bolha.

Implicação para Suup: agrupar deltas por `index` de bloco, não por ordem de chegada.

### 2. SSE no WHATWG: `id`, `Last-Event-ID`, reconexão, `retry` (F4)

- **Campo `id`**: se o valor não contém U+0000 NULL, o "last event ID buffer" recebe esse valor. Se contém NULL, o campo é ignorado. O buffer não é zerado a cada evento: persiste até ser substituído.
- **Evento sem `id`**: herda o último `id` visto. Um campo `id` vazio zera o last event ID, e então nenhum `Last-Event-ID` é enviado na reconexão.
- **Cabeçalho `Last-Event-ID`**: na reconexão, se o last event ID não for vazio, o cliente envia o cabeçalho HTTP `Last-Event-ID` com esse valor. O valor é qualquer string UTF-8 sem NULL, LF ou CR.
- **Campo `retry`**: se o valor for inteiro na base 10, define o tempo de reconexão em milissegundos. Esse tempo é um valor inicial de implementação, "na ordem de alguns segundos".
- **Reconexão**: quando a conexão cai, o cliente aguarda o tempo de reconexão e tenta de novo. O agente de usuário pode aplicar backoff exponencial. Se o servidor responder **HTTP 204 No Content**, o cliente não reconecta.
- **Exemplo normativo**: o bloco com `id: 1` faz o próximo `Last-Event-ID` ser `1`. Um bloco com `id:` vazio zera o buffer.

Implicação para Suup: `id: <run_id>:<seq>` funciona porque o `Last-Event-ID` é só uma string opaca. O servidor precisa interpretar o valor na reconexão. A cadeia fica ativa enquanto o servidor não responder 204.

### 3. Canal efêmero entre processos: LISTEN/NOTIFY (F5, F6)

Dados verificados:

- **Limite de payload** (F5): "In the default configuration it must be shorter than 8000 bytes." A própria página recomenda tabela para dados grandes, passando só a chave.
- **Entrega só para quem escuta** (F5, F6): NOTIFY envia o evento "to each client application that has previously executed LISTEN". LISTEN registra a sessão no canal; o registro some quando a sessão termina. Não há armazenamento para quem não estava ouvindo no momento do envio.
- **Dentro de transação** (F5): "if a NOTIFY is executed inside a transaction, the notify events are not delivered until and unless the transaction is committed." Se a transação aborta, a notificação é descartada.
- **Ouvinte em transação** (F5): notificações recebidas durante uma transação só chegam ao cliente depois que ela termina. A página recomenda manter transações curtas para sinalização em tempo real.
- **Duplicatas** (F5): mesmo canal e mesmo payload na mesma transação são entregues uma vez. Payloads diferentes são sempre entregues. Dentro da mesma transação a ordem é mantida.
- **Fila cheia** (F5): se a fila de notificações encher, transações que chamam NOTIFY falham no commit. Uma sessão que fica em `LISTEN` com transação aberta por muito tempo impede a limpeza da fila.
- **LISTEN no commit** (F6): LISTEN só vale a partir do commit. Ao se registrar, a página recomenda fazer commit do LISTEN antes de ler o estado.

Comparação com canal em memória (raciocínio próprio, fundado em F5 e F6):

- Mesmo processo (desktop com servidor embutido): canal em memória (`EventEmitter` por `run_id`). Sem limite de payload, sem ida ao banco, sem risco de fila.
- Processos separados (VPS): NOTIFY, com payload pequeno (`run_id`, `seq`, trecho curto). Como a entrega não é garantida para quem não está ouvindo, o estado importante (texto final) continua no `run_events`.
- Cuidado: não envolver o streaming numa transação longa. Se o NOTIFY for emitido dentro de uma transação que dura o turno inteiro, a fila de notificações segura, e o cliente recebe tudo só no commit. Isto anula o efeito de streaming.

### 4. Reconexão no meio da digitação: AI SDK resume (F2)

- `resume: true` no `useChat` faz um GET em `/api/chat/[id]/stream` ao montar, para procurar e retomar um stream ativo.
- Reconecta também quando a página volta a ficar visível, mas só se a interrupção foi queda de rede. Streams saudáveis e outros erros não são tocados.
- A aplicação guarda uma referência do chat para o stream (`activeStreamId`). O endpoint de resume usa esse valor.
- O servidor mantém o stream rodando mesmo sem cliente. Um `abort` no cliente só fecha a conexão HTTP.
- A recomendação de parada é um endpoint de stop separado, que **persiste a resposta parcial** e cancela o trabalho.
- `resumeStreamIsReplay`: por padrão o resume é tratado como replay completo. Se o endpoint mandar só o restante, usar `resumeStreamIsReplay: false`.
- Após o usuário parar, evitar reconexão automática até nova mensagem.

Conflito com a regra de Suup: F2 recomenda persistir o parcial no stop. Suup proíbe que texto parcial vire mensagem gravada. **Questão aberta para o dono**, que decide. Não resolvida nesta nota.

Alternativa simples: reenviar o texto acumulado até o momento na reconexão. Basta para a bolha, sem replay de deltas.

### 5. Limitar a taxa de deltas (F7)

- O `useChat` tem a opção **`throttle`** (o nome é `throttle`, não `experimental_throttle`). É um número em milissegundos, documentado como "React and Vue only". O padrão é `undefined`, que desativa o throttle.
- Documentado: "Positive values reduce UI update frequency without delaying stream processing or callbacks, and the latest messages are published before a ready or error status." Ou seja, o throttle só atrasa a renderização, não o processamento nem os callbacks.
- Documentado: "throttle can delay message rendering without delaying stream processing or callbacks." Em React, o snapshot final sempre é publicado antes de `ready` ou `error`.
- Não é documentado um valor recomendado. O valor de ~50 ms do briefing é uma sugestão, não uma recomendação da fonte.

Implicação para Suup: o throttle do cliente é só de renderização. Para limitar tráfego SSE e NOTIFY, agrupar deltas no worker (raciocínio próprio, ~50 ms). Os dois são complementares.

### 6. Redação de segredos num stream

**Fontes primárias:**

- F3 (GitHub): "Mask all sensitive information that is not a GitHub secret by using `::add-mask::VALUE`. This causes the value to be treated as a secret and redacted from logs." Não descreve buffer para segredos partidos entre chunks.
- F8 (OWASP, Logging): lista como "should usually not be recorded directly in the logs, but instead should be removed, masked, sanitized, hashed, or encrypted": tokens de acesso, senhas de autenticação, strings de conexão com banco, chaves de criptografia e outros segredos primários. Orienta mascarar ou remover antes de gravar. Não trata de segredo cortado entre dois fragmentos.

**Sem fonte primária para o buffer de retenção.** O buffer é raciocínio próprio:

Para cada texto a ser exibido, mantém-se um buffer de retenção de N−1 caracteres, onde N é o tamanho do maior segredo do cofre. O que sai do buffer já está redigido. Ao fim do bloco (`content_block_stop`), o buffer é liberado após redação completa. Isto garante que um segredo cortado entre dois deltas nunca aparece inteiro nem parcialmente no canal efêmero.

Ponto crítico: a redação precisa acontecer **antes** de o delta sair do worker. Redigir só ao gravar o `model_response` deixa o segredo visível na bolha durante a digitação. Isto fica em aberto como decisão de implementação, com teste próprio.

### 7. Acessibilidade: `prefers-reduced-motion` e `aria-live` (F9, F10)

**`prefers-reduced-motion` (F9):**

- Valores: `no-preference` e `reduce`. `reduce` avalia como verdadeiro. `@media (prefers-reduced-motion)` equivale a `prefers-reduced-motion: reduce`.
- Descrição: "The setting is used to convey to the browser on the device that the user prefers an interface that removes, reduces, or replaces motion-based animations."
- Implicação: animações decorativas da bolha (cursor piscando, efeito de entrada) devem ser removidas ou substituídas por versão sem movimento quando `reduce` estiver ativo. O texto pode aparecer sem animação de caractere.

**`aria-live` (F10):**

- Valores: `off` (padrão), `polite` e `assertive`. `polite` notifica sem interromper a tarefa atual. `assertive` interrompe e pode limpar a fila de fala.
- Em conteúdo que muda com frequência, a página recomenda `aria-live="off"` quando o usuário não está focado na região: "you likely do not want to inform the user every time it updates".
- Sobre `aria-busy` (F10): "Use aria-busy to prevent announcements while updates are still being made."
- A página também recomenda não usar `assertive` salvo quando a interrupção for imperativa.

Implicação para Suup: bolha em digitação com `aria-busy="true"` e `aria-live="off"`, sem anunciar cada delta. Ao fim do turno, remover `aria-busy` e anunciar a mensagem final com `polite`. Nunca `assertive` para texto de resposta.

---

## Arquitetura recomendada para Suup

Itens com fonte lida estão apontados como (F#). Os demais são raciocínio próprio.

1. **Canal efêmero separado do log.** Deltas não vão para `run_events`. O `model_response` continua sendo o único registro gravado do texto (F5: entrega só para quem escuta, sem armazenamento).
   - Mesmo processo: canal em memória por `run_id`.
   - Processos separados: NOTIFY com payload menor que 8000 bytes (F5), contendo `run_id`, `seq` e trecho curto. Sem transação longa envolvendo o streaming (F5).

2. **Identificadores.** Cada delta recebe `seq` monotônico por `run_id` e por `index` de bloco (F1). O SSE envia `id: <run_id>:<seq>`. O cliente guarda o último `id` (F4). O servidor interpreta o `Last-Event-ID` como string opaca.

3. **Reconexão.** O servidor responde a uma reconexão com um snapshot do texto acumulado até o `seq` atual e segue com deltas de `seq` maior (alternativa simples de F2). Se o turno já terminou, responde com HTTP 204 para encerrar a reconexão (F4). Se o servidor reiniciar, o snapshot some e o cliente cai para o texto gravado ao fim do turno.

4. **Redação.** Buffer de N−1 caracteres antes de qualquer delta sair do worker (item 6, raciocínio próprio). Esta é a única fronteira em que o segredo pode vazar para a UI.

5. **Throttle.** Agrupamento no worker a cada ~50 ms (raciocínio próprio). No cliente, `throttle` do `useChat` se for usado, só para renderização (F7).

6. **Fim do turno.** O worker grava o `model_response` (já redigido) e emite um evento efêmero `turn_end` com o id do registro. O cliente troca o texto da bolha pelo texto gravado numa única atualização de estado, mantendo o mesmo elemento na tela. O cliente não grava nada.

7. **Parada pelo usuário.** Questão aberta para o dono (ver item 4). Pela regra de Suup, o parcial não é gravado. Desativar reconexão automática até nova mensagem (F2).

8. **Acessibilidade.** Bolha com `aria-busy="true"` e `aria-live="off"` durante a digitação. Ao fim, anúncio `polite` (F10). Sem animação quando `prefers-reduced-motion: reduce` (F9).

---

## O que continua aberto

1. **Stop x regra de Suup (decisão do dono).** F2 recomenda persistir o parcial no stop; Suup não grava parcial. Escolher: (a) stop descarta o parcial, ou (b) gravar parcial como evento não-mensagem. Esta nota não resolve.
2. **Buffer de redação.** Sem fonte primária. Definir o tamanho máximo de segredo no cofre (N). Se algum segredo for muito longo, o buffer fica grande. Validar com teste que parta um segredo em todos os pontos possíveis.
3. **Limites de NOTIFY na prática.** O limite de 8000 bytes é o padrão (F5). Se a configuração do Postgres do VPS mudar, confirmar. Também medir o tamanho típico de um delta.
4. **Valor do throttle.** ~50 ms é sugestão do briefing, não recomendação de fonte. Medir na UI.
5. **Repositório.** O CLAUDE.md pede pesquisas em `docs/pesquisas/` antes do código. Esta nota está no scratchpad, no caminho pedido. Se for para o repositório, copiar para `docs/pesquisas/` no commit de implementação.

---

## Decisão adotada (dono, 25/11/2026)

Implementada na branch `kod-34-texto-ao-vivo`. O que o dono decidiu e o que foi feito:

1. **Tudo ao vivo, inclusive o `summary` do `finish`.** Os providers leem o JSON parcial (`input_json_delta` na Anthropic; `function.arguments` no formato OpenAI) com uma máquina de estados da gramática de strings do JSON (`packages/core/src/loop/summary-stream.ts`, sem regex), só da chave `summary` e só de uma chamada cujo nome, no início do bloco, é exatamente `finish`. Escapes, `\uXXXX` e pares substitutos entram. O `summary` que não é texto (por exemplo uma lista) não é mostrado. Passa pelo mesmo `LiveText` e pela mesma retenção de N−1 caracteres.
2. **Parar o bot: o texto parcial some.** Nada é gravado. Se um dia o dono quiser guardar, o único lugar é o ramo `aborted` de `callModel` (`packages/core/src/loop/model-call.ts`).
3. **Texto + `finish` no mesmo turno:** o balão do texto é descartado assim que o bloco do `finish` começa (`finish_start`), e o resumo é escrito no lugar.
4. **`live.crossProcess`:** `true` por padrão (servidor e workers podem ser processos separados: o texto vai também por `NOTIFY`); o sidecar do app põe `false` (mesmo processo: memória). Um quadro leva o id do runtime que o mandou, e quem ouve o próprio `NOTIFY` o ignora.
5. **Segurança.** O worker tira os valores do cofre antes de o texto sair do processo (o redator inteiro do bloco, e retém `maior texto procurado − 1` caracteres, contando as formas codificadas: `Redactor.longestNeedle()`); o servidor passa o quadro de novo pelo redator. Só a chamada do agente de uma execução de conversa publica (`liveAllowed`); o revisor, a compactação, o vigia, as rotinas, a delegação e as avaliações nunca. Testes: o segredo cortado em todos os pontos (formas pura, base64, hexadecimal e de URL), o `summary` com a mesma retenção, um valor que o cofre aprende no meio, e cada tipo de chamada e de execução.
6. **Uma única regra de tempo:** `LIVE_SETTLE_MS` = 3 s (`apps/desktop/src/data/live.ts`): o texto que nenhuma mensagem gravada substituiu some 3 s depois de uma chamada mais nova começar ou da execução parar de rodar.
