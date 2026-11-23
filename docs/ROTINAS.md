# Rotinas

Um bot faz algo sozinho, num horário: "vê meu calendário todo dia", "toda segunda me manda o resumo da semana", "lembra de pagar o aluguel dia 5". Pesquisa que embasa o desenho: [pesquisas/fase-4-rotinas-webhooks-notificacoes.md](pesquisas/fase-4-rotinas-webhooks-notificacoes.md) (Claude Code, GitHub Actions, croner, Hermes, OpenClaw, OpenMausBot). Seção 4.9 do [PLANO.md](PLANO.md).

Esta etapa tem só o gatilho de **horário**. Monitor (consulta periódica com condição) e webhook ficam para depois; o tipo do gatilho já é um campo (`routines.trigger_kind`, hoje só `schedule`).

## Criada conversando

Decisão do dono: como no Grok, a rotina nasce da conversa, não de um formulário.

- O usuário diz "vê meu calendário todo dia". O bot chama `create_routine` escolhendo **ele mesmo** um horário razoável e diz na própria mensagem o que escolheu: "Combinado, vejo seu calendário todo dia às 8h. Quer outro horário?". O prompt (`ROUTINES_HOW`, `packages/core/src/loop/prompts.ts`) manda escolher, dizer em palavras e perguntar; e manda **não** criar rotina que o usuário não pediu.
- Para mudar, o usuário fala ("muda para 7h") e o bot chama `update_routine`. **Não há formulário de horário no app** (decisão do dono, 22/11/2026, como as tarefas do Grok): o "Editar" do painel leva ao chat do bot com o rascunho preenchido ("Editar a rotina “Calendário da manhã” (todo dia às 08:00): ") e uma **referência escondida** à rotina (abaixo).

### A referência à rotina na mensagem

O id da rotina **nunca aparece no chat**. O "Editar" prende ao rascunho do compositor uma referência estruturada (`routineRef: { id }`); apagar o rascunho, ou trocar de bot, a tira. Ela vai com a mensagem (`POST /v1/conversations/{id}/messages`, `{ text, routineRef }`), o servidor confere que é uma rotina do bot da conversa e a guarda **na mensagem** (`messages.routine_ref`, migração 0027; `null` quando a rotina é apagada), nunca no texto.

O modelo recebe a referência como dado, numa nota do harness no mesmo turno da mensagem (`renderRoutineRef`, `packages/core/src/loop/prompts.ts`): "The user's message is about your routine "Calendário da manhã" (todo dia às 08:00), id …. … To change or delete this routine, pass routine: "…"", com o aviso de não mostrar o id ao usuário. Fica no log, então retomar e reproduzir dão o mesmo: a mensagem que abriu a execução vai em `context_loaded.routineRefs`; a que chegou com a execução andando, em `user_message.routineRef` (a caixa de entrada lê a referência da mensagem). Uma mensagem assim que já está no histórico de uma execução seguinte leva a mesma nota ao lado do texto. O texto que o usuário digitou continua sendo o objetivo e o que o revisor do Auto-review lê como pedido dele. Lacuna: a resposta a uma pergunta do bot (`escalate`) é o resultado da chamada e não leva a nota.
- `schedule_return` ([RETORNO.md](RETORNO.md)) continua sendo só para voltar **uma vez**, dentro da tarefa atual (um deploy que termina em 20 minutos). O que se repete, ou é para outro dia, é rotina. O prompt diz isso aos dois lados.

Ferramentas (só em execução de conversa do usuário, `origin: user`):

| Ferramenta | O que faz | Nível |
|---|---|---|
| `create_routine` | `{ name, instruction, schedule, timeZone?, costCapUsd? }` | `write_reversible` (permissão permanente) |
| `update_routine` | `{ routine, name?, instruction?, schedule?, timeZone?, paused?, costCapUsd? }` | `write_reversible`; **só pausar** é `read` (tira poder) |
| `delete_routine` | `{ routine }` | `read` (tira poder) |
| `list_routines` | as rotinas do próprio bot | `read` |

`routine` é o id ou o nome **exato** (sem diferença de maiúsculas), só entre as rotinas do próprio bot. A instrução precisa ser completa: cada disparo é uma execução nova, sem a conversa.

## Aprovação

Uma rotina é uma **permissão permanente** (o bot vai agir sozinho, de novo e de novo):

- **Auto-review**: o revisor de sempre decide. Ele vê as mensagens do usuário: se o usuário pediu a rotina, roda; se o bot inventou, vira cartão.
- **Perguntar tudo**: sempre cartão.
- O cartão (texto do servidor, em pt-BR): **"Criar uma rotina: <instrução> — <quando, por extenso>"**, por exemplo "Criar uma rotina: Veja meu calendário de hoje e me diga o que tenho. — todo dia às 08:00". Mudar: "Mudar a rotina “Manhã”: toda segunda às 07:30". Categoria "Rotina" no app (ícone de calendário). Ver [APROVACOES.md](APROVACOES.md).
- Pausar e apagar pelo bot são livres: reduzem o que ele pode fazer.

## O disparo não é aprovação

A pesquisa (Claude Code, rotinas): o texto disparado "can't act as approval or consent for actions during the run". No Suup:

- Dentro da execução da rotina, **toda** ferramenta passa pelo portão normal: regras, revisor, pisos, cartões. Os cartões aparecem em **Pendências** como quaisquer outros (a execução fica `waiting_approval`).
- O revisor do Auto-review recebe, num bloco próprio, que a execução foi **iniciada por uma rotina**, que o usuário não está vendo ao vivo e que o disparo não é aprovação; a instrução aparece como "pedida quando o usuário configurou a rotina", **fora** das mensagens do usuário (`ReviewTrigger`, versão `auto-review-v3`).
- Ninguém responde ao vivo: `escalate` e `request_secret` são **recusados** numa rotina (o bot diz na resposta final o que precisa). Senão a execução ficaria esperando para sempre e todos os próximos disparos seriam pulados.
- Pelo mesmo motivo, quando o revisor de conclusão não consegue verificar o `finish` (ou a revisão falha, mesmo depois de tentar de novo), a execução da rotina **termina não concluída** (`failed`, motivo em português no chat: "a revisão falhou..." ou "o revisor não conseguiu confirmar...") em vez de passar a decisão ao dono. O próximo disparo roda normalmente.
- `schedule_return` não é oferecido a rotinas (só a conversa do usuário volta sozinha), então o teto de 6 retornos seguidos continua valendo sem mudança.

## Horário: campos, nunca cron

O horário é **estrutura** (`packages/core/src/schedule.ts`, usado pelo servidor, pelo app e pelo bot):

| `kind` | Campos |
|---|---|
| `once` | `date` (`AAAA-MM-DD`), `time` (`HH:MM`) |
| `daily` | `time` |
| `weekly` | `days` (`sun`…`sat`), `time` |
| `monthly` | `day` (1 a 31), `time` |
| `interval` | `every`, `unit` (`minutes` ou `hours`); mínimo 5 minutos, máximo 31 dias |

Todos, menos `once`, aceitam `until` (`AAAA-MM-DD`, inclusive). Sem texto de cron em lugar nenhum; data e hora são lidas caractere a caractere (formato de gramática fixa, sem regex). A ferramenta do bot recebe o horário como **um objeto plano** (os mesmos campos, todos opcionais menos `kind`) e o servidor o lê com o esquema estrito, devolvendo ao bot o campo que falta: o `oneOf` estrito custava três vezes mais tokens em cada pedido.

O próximo disparo é calculado no fuso da rotina com os deslocamentos do `Intl.DateTimeFormat`, sem biblioteca de cron. Política (croner e GitHub Actions, na pesquisa):

- **Hora que não existe** (o relógio pula para a frente): roda no **primeiro instante válido depois do buraco**. 02:30 em Nova York em 08/03/2026 roda às 03:00.
- **Hora que se repete** (o relógio volta): roda **uma vez**, na **primeira**. 01:30 em Nova York em 01/11/2026 roda às 01:30 do horário de verão.
- **Intervalo** é duração absoluta, contada da âncora (o momento em que o horário foi definido): "a cada 30 minutos" são 30 minutos reais, atravessando qualquer mudança do relógio. O primeiro disparo é um período depois da âncora, nunca na hora.
- **Dia que o mês não tem** (31 em abril, 29 em fevereiro de ano não bissexto): roda no **último dia** do mês.
- Sem jitter: os horários são do usuário.

Testes: `packages/core/src/schedule.test.ts` (São Paulo hoje e no horário de verão antigo de 2018/2019, Nova York, Lisboa, fim de mês, ano bissexto, intervalo atravessando a mudança), com o processo em qualquer fuso.

## O fuso é o do usuário

Decisão do dono: as horas das rotinas são do **usuário** (que está no Brasil), nunca do servidor, que pode rodar numa VPS em UTC ou em outro país.

- O fuso fica no banco (`user_settings`, migração 0026). O app manda o fuso do computador do usuário ao conectar (`source: "device"`); o usuário pode escolher outro em **Configurações > Geral > Fuso horário** (`source: "user"`), e o do computador **nunca** substitui uma escolha do usuário.
- Ordem: o do usuário ou do aparelho, senão `defaults.timeZone` da configuração. **Nunca** o fuso do processo do servidor. Sem nenhum, `GET /v1/info` diz `timeZone: null`, o bloco "Now" do prompt diz que o fuso é desconhecido (e usa UTC dizendo isso), `create_routine` pede ao bot que pergunte ao usuário, e a revisão noturna espera.
- Cada rotina guarda o fuso em que foi criada (`routines.time_zone`). Teste ponta a ponta: processo do servidor em `TZ=UTC`, usuário em `America/Sao_Paulo`, "todo dia às 8h" vai para 11:00 UTC.

## O disparo

Um job do worker (`routines`, a cada 15 s; `routinesEveryMs`) chama `fireDueRoutines` (`packages/db/src/routines.ts`), no mesmo padrão do job que acorda os retornos ([RETORNO.md](RETORNO.md)): as rotinas ativas vencidas (de bot não arquivado) são pegas com `FOR UPDATE SKIP LOCKED`, e o disparo, a execução e o novo `next_run_at` são **uma transação por rotina**. O índice único `(routine_id, scheduled_for)` em `routine_fires` faz cada horário disparar no máximo uma vez, com qualquer número de workers e depois de uma queda.

Políticas (da pesquisa e do dono):

- **Perdidos com a máquina desligada**: **uma** recuperação, para o horário perdido mais recente; os mais antigos são descartados e contados (`missed_count`, "Recuperação · 3 perdidas" no histórico). Um disparo atrasado mais de 2 minutos também é registrado como `catch_up`.
- **Sobreposição**: se a execução anterior da rotina ainda não terminou (qualquer estado não final, inclusive esperando aprovação), o disparo é registrado como `skipped` (`overlap`) e nada entra na fila. "Rodar agora" responde `409` nesse caso.
- **Pausada**: não dispara, e o que passou durante a pausa não é recuperado (retomar calcula a partir de agora).
- **Fim**: data única que já disparou, ou `until` passado: a rotina fica `ended` (registrado). O resumo final opcional do PLANO **não** foi feito: a rotina só para e registra.
- **Custo**: teto por execução opcional por rotina (`costCapUsd`, padrão nenhum, como o do supervisor); com teto, vale o menor entre ele e o do bot. É texto decimal simples (só algarismos e um ponto, até 4 casas, conferido caractere a caractere, sem regex); na API, um número de 0.01 a 100 com até 4 casas.
- **Horário salvo inválido** (gravado por uma versão anterior ou à mão): a rotina continua na lista com `schedule: null` e `problem` (frase para o usuário); o agendador a **pausa** uma vez (registra no log do worker) em vez de falhar a cada passada, e ela só volta a rodar com um horário novo. Uma linha ruim nunca quebra a lista inteira.

## Onde roda e onde o resultado aparece

Cada disparo é uma **execução nova** do bot dono, origem `routine` (como `reception` e `delegation`), **fora de conversa** (`conversation_id` vazio), e o resultado vai para a **conversa direta do bot**. Por quê, e não uma conversa própria da rotina nem a execução dentro do chat do bot:

- A conversa direta tem no máximo uma execução em primeiro plano; uma rotina dentro dela disputaria com o usuário (como a delegação, que recusa bot "ocupado") e carregaria o histórico inteiro do chat a cada disparo. A pesquisa recomenda a execução **isolada**, que começa da instrução e do estado da rotina e não cresce a cada disparo.
- Uma conversa por rotina seria um tipo novo de conversa no app (lista, não lidas, recepção), sem pedido do dono.
- O usuário já lê o chat do bot: a resposta da rotina chega lá como mensagem do bot, uma vez (`appendMessageOnce`, chave `routine-fire:<id>`), com `routineId` na mensagem. Falha ou cancelamento viram mensagem do sistema. O disparo guarda o resultado (`routine_fires.result_text` e `message_id`: o `routine_result` que o app mostra no histórico). Notificação do desktop fica para depois: o ponto de gancho é esse registro.

O que a execução recebe (gravado uma vez em `context_loaded.routine`, então o replay diz o mesmo): o nome, o horário em palavras, o fuso, a hora marcada, o tipo (no horário, recuperação ou rodar agora), quantos horários foram perdidos e a **nota da rotina**. A instrução é o objetivo da execução. O prompt ganha o bloco "This run is a routine".

**Estado.** Uma nota de texto pequena (até 2000 caracteres) por rotina, que a própria execução substitui com `update_routine_state` (só oferecida numa execução de rotina, junto com `list_routines` e `delete_routine`). Serve para "o que já avisei", "o último valor visto".

## No app

Painel do bot, aba **Atividade**, cartão **Rotinas** ([DESIGN.md](DESIGN.md) §5b): uma linha por rotina, de borda a borda, com ícone, nome, o horário em palavras, a próxima vez ("Próxima: amanhã, 08:00"), ou "Pausada"/"Encerrada", e o último resultado. **Sem formulário**: criar e mudar é pedindo ao bot (decisão do dono, 22/11/2026). Clicar numa linha abre o **detalhe na própria coluna do painel**: voltar, pausar/retomar e "Rodar agora" em ícones no topo; o nome, o horário e a próxima vez; e **o que o bot escreveu** em cada disparo (do mais novo ao mais velho, em Markdown como no chat, com a hora e a situação; pulada e rodando numa linha quieta), com **as fontes** da execução: o ícone do site de cada página lida (que segue a configuração "Ícone dos sites nos links"; desligada, o ícone genérico) e o do conector usado. No fim, **Editar** (leva ao chat do bot com o rascunho "Editar a rotina “…” (…): " e a referência escondida, acima) e **Remover** (pede confirmação). Vazio: "Nenhuma rotina", com a frase de como pedir no chat. A lista e o detalhe são lidos de novo quando uma execução do bot muda de estado.

As fontes vêm do backend, nunca do texto: cada ferramenta **declara** a página que leu (`ToolOutput.source`; o `web_read` grava o endereço final e o título em `tool_result.source`), e `GET /v1/routines/{id}/fires` devolve, em `sources`, essas páginas e os conectores cujas ferramentas responderam (pelo nome registrado exato que o conector lista), na ordem, cada um uma vez, até 8.

## API

`/v1/routines` (CRUD, `POST /v1/routines/{id}/run`, `GET /v1/routines/{id}/fires`) e `/v1/user-settings`: [API.md](API.md).

## O que ainda não existe

- Monitor (consulta periódica com condição antes do modelo) e webhook ([PLANO.md](PLANO.md) 4.10); notificação do desktop (Tauri) com o resultado; resumo final ao terminar pela data de fim.
- Um rótulo "Rotina" no balão do chat (a mensagem já traz `routineId`).
- A busca (`web_search`) não vira fonte: só a página lida. Os resultados de uma busca são muitos e o bot nem sempre os usa.
- Tetos por conta e por hora (a pesquisa cita os do Claude); hoje há só 30 rotinas por bot e o intervalo mínimo de 5 minutos.
- Medir: disparos por dia, pulados por sobreposição, recuperações depois de um dia desligado.
