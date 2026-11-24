# Vigia de progresso

O que acontece quando uma execução chega ao limite de passos ou começa a se repetir. Antes, ela terminava como `failed` e o trabalho útil se perdia. Agora o **vigia** olha, avisa o bot, estende sozinho quando há progresso que dá para conferir e, no resto, **pergunta ao dono**. Pesquisa: [pesquisas/vigia-de-progresso.md](pesquisas/vigia-de-progresso.md). Decisões do dono de 24/11/2026 em [MELHORIAS.md](MELHORIAS.md), item M13.

## O que mudou para o dono

- **Chegou ao limite (`maxTurns`, padrão 50), está repetindo a mesma chamada, ou ficou 3 turnos sem usar ferramenta:** a execução **pausa** (`waiting_user`) e o chat mostra um cartão de pergunta, o mesmo de sempre ([DESIGN.md](DESIGN.md), "Pergunta com opções"): o balão traz uma linha amigável do que houve ("Esta tarefa está levando mais tempo do que o normal." ou "Acho que estou andando em círculos.") e um resumo curto do que já foi feito e do que falta (do plano; sem plano, a contagem de ações); o cartão tem a pergunta **"Quer que eu continue?"** com duas opções, **"Continuar"** e **"Parar por aqui"** (nada de "passos" na tela: decisão do dono), o X e a dica "Ou responda no chat abaixo".
- **"Continuar"** dá mais 25 passos, **abre uma janela nova de detecção** (os sinais antigos não disparam de novo na hora) e a execução segue. O modelo recebe uma nota do harness (nunca as palavras do dono) dizendo que ganhou mais passos e, se era um laço, que mude de abordagem.
- **"Parar por aqui"** termina a execução **limpa** (`done`, não erro), com a mensagem final "Parei por aqui, como você pediu. …" e o mesmo resumo.
- **O X** do cartão (e a mensagem que o servidor manda ao fechá-lo) conta como **parar**: nada se gasta sem uma decisão. **Digitar outra coisa** no chat conta como continuar (+25) e o modelo lê o que o dono escreveu; escolher pela letra (`A`, `B`) ou número (`1`, `2`) vale como a opção. A comparação é exata com os rótulos do cartão, nunca por texto parecido. Decisão do dono (24/11/2026): fica assim, os botões decidem na hora e o que ele escreve o bot lê e obedece.
- **Sem teto de custo ou tempo por padrão** (decisão do dono): `maxCostUsd` e `maxDurationMs` continuam desligados e configuráveis. Quando o dono os define, passar deles **ainda termina** a execução (`failed`, origem `limit`, em uma frase amigável: "Parei porque o gasto desta tarefa chegou ao limite que você configurou…"); o vigia só cuida do limite de **passos** e dos laços.

## Rotinas (ninguém olhando)

Uma execução de rotina não tem a quem perguntar. Quando o laço continua depois do aviso, ou o limite de passos é atingido sem progresso que dê para conferir, a execução **para** (`failed`, origem `limit`) e deixa no chat do bot uma mensagem amigável, em um parágrafo: o que houve, que parou para não gastar sem ninguém acompanhando, o que já foi feito e o que falta, e o pedido para o dono dizer se deve continuar. Nada de pergunta e nada de gasto. A rotina pode se estender sozinha **no máximo 2 vezes** (as extensões automáticas), como qualquer execução, e nunca além disso. O próximo disparo roda normalmente ([ROTINAS.md](ROTINAS.md)).

## Os sinais

Todos por **comparação exata** de campos declarados: nome da ferramenta, argumentos em JSON canônico, a marca de erro e o desfecho (`outcome`), o texto do resultado e o nível de risco da chamada. Nenhum lê texto por significado nem usa regex ([REGRAS.md](REGRAS.md), seção 1). As contas estão em `packages/core/src/loop/watch-state.ts`.

| Sinal | O que é | Aviso | Pergunta (ou parada, na rotina) |
|---|---|---|---|
| **Repetição exata** | mesma ferramenta, mesmos argumentos, mesmo erro/sucesso e **mesmo resultado**, em sequência | no 3º | no 5º |
| **Quase-repetição** | 4 das últimas 8 chamadas são a mesma ferramenta com os mesmos argumentos, **resultado qualquer** | nenhum: só alimenta o juiz | nenhuma |
| **Erro recorrente** | a mesma ferramenta falhando do mesmo jeito (mesmo `outcome` declarado), em sequência, mesmo com argumentos diferentes | no 3º | no 5º |
| **Sem ferramenta** | turnos seguidos só com texto (ou com `finish`/`escalate` recusados) | a cada turno (a partir do 1º, pelo motivo de cada um) | no 3º |
| **Alternância** | A, B, A, B, A, B: chamadas iguais por posição, com os mesmos resultados | aos 6 | aos 10 |

O aviso é **uma nota do harness para o modelo, uma vez por padrão e por janela** ("Você está repetindo X; mude de abordagem"), nunca mostrada ao dono como se fosse dele (o chat só mostra a frase amigável "O Suup pediu ao bot que continuasse."). Os números são `defaults.watchdog` ([CONFIGURACAO.md](CONFIGURACAO.md)).

**Por que a quase-repetição não decide nada sozinha.** Esperar um build chamando o mesmo `status` se parece com um laço, mas o resultado muda a cada vez. Por isso ela só aparece no resumo do juiz, e, sem juiz, o que decide é o resto (repetição exata, erro recorrente, alternância). Uma espera de verdade, com resultado diferente a cada chamada, nunca avisa nem pergunta antes do limite.

## Progresso que dá para conferir

Há progresso quando, em alguma das **últimas 10 chamadas**: uma chamada **bem-sucedida e inédita** (nome e argumentos que a execução ainda não tinha feito) **que não é só leitura** (o nível de risco declarado pela ferramenta: `write_reversible` ou `external_irreversible`; é "arquivo escrito ou alterado"); uma chamada bem-sucedida inédita; ou um **resultado novo** (um texto que a execução ainda não tinha visto). A marca de nível vem do registro de ferramentas (`tool_result.risk`), então não depende de aprovações estarem ligadas.

## O limite de passos

1. **Perto do limite (80% da fatia atual):** o vigia olha (e pergunta ao juiz, se houver). Se o juiz diz **"circulo"**, ou, sem juiz, há um laço já sinalizado, o modelo recebe **um** aviso para mudar de abordagem, enquanto ainda tem passos.
2. **No limite:** se há progresso conferível **e** o juiz concorda (**"avanca"**; sem juiz, basta não haver laço sinalizado), a execução **se estende sozinha em 25 passos**, **no máximo 2 vezes** por execução. **"incerto"**, **"circulo"**, sem progresso, ou o teto das 2 extensões: **pergunta ao dono** (na rotina, para). O dono pode dar +25 quantas vezes quiser; não há teto de passos além das decisões dele.
3. O juiz **só é chamado quando a resposta dele poderia mudar algo** (ainda há extensão automática e há progresso). O custo dele conta no custo da execução; ele não conta como passo.

## O juiz

Um modelo barato, configurado como o revisor: `defaults.watchdog.judge.model`, senão o modelo do auto-review, senão o do `reviewer`. Sem nenhum, ou sem a chave do provedor, **não há juiz** e os sinais estruturais decidem sozinhos (na dúvida, pergunta).

- **O que ele vê** (`judgeDigest`, em `watchdog.ts`): o objetivo e os critérios (cortados), o plano, os contadores medidos pelo harness, as **últimas 10 chamadas** (nome, uma impressão digital dos argumentos, sucesso ou erro, tamanho e **até 100 caracteres do início e do fim** do resultado) e a última frase do bot, cortada. **Nunca** os argumentos, arquivos inteiros, o histórico, o cofre ou credenciais; o texto passa de novo pelo redator do cofre antes de sair.
- **O que ele devolve:** a ferramenta `progress_verdict`, com `verdict` (`"avanca"`, `"circulo"` ou `"incerto"`) e `reason` (uma frase, até 200 caracteres), validada por esquema. Resposta fora do formato, sem a ferramenta, ou falha da chamada: **"incerto"** (a execução nunca falha por causa do juiz).
- **Ele nunca decide sozinho:** "avanca" só estende junto com o progresso estrutural.

## No registro e no chat

- `progress_check` (Inspetor e `suup inspect`): o gatilho, os sinais, se há progresso, o veredito e o motivo do juiz, e o que o vigia fez (`continue`, `nudge`, `extend`, `ask`, `stop`). `progress_decided`: a resposta do dono (continuar ou parar, os passos dados, o texto e os itens da caixa de entrada que ela entrega, num evento só). A pergunta é um `escalated` com `reason: "progress_limit"` e `progress: { cause, grant }`.
- O juiz é uma chamada com `purpose: "progress"` (pedido e resposta gravados, como o revisor). A repetição (`replay`) a serve da gravação.
- **No chat, só o cartão ou a mensagem amigável.** Nada de "turn limit", "origem" nem texto técnico.

## Desligar

`defaults.watchdog.enabled: false` volta ao comportamento antigo (falha no limite e no laço). Uma execução isolada (avaliação) roda sem ninguém para responder: o vigia fica desligado nela e ela falha nos limites como antes.

## Onde está o código

`packages/core/src/loop/`: `watchdog.ts` (decisões, juiz, cartão), `watch-state.ts` (sinais), `watchdog-text.ts` (textos), `state.ts` (a memória, refeita dos eventos), `resume.ts` (a resposta do dono), `safe-point.ts` (o fim limpo). Testes: `watchdog.test.ts`.
