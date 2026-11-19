# O bot volta sozinho

Pesquisa e decisão do dono: [pesquisas/fase-4-acordar-sozinho.md](pesquisas/fase-4-acordar-sozinho.md). Primeira peça da fase 4 ([PLANO.md](PLANO.md), 4.14).

> "Ele faz uma tarefa e essa tarefa leva, sei lá, 20 minutos para rodar lá no CI/CD ou para dar deploy. Aí ele fala, volta daqui 20 minutos. E ele volta sozinho daqui 20 minutos … Sem ser eu criar uma rotina para aparecer lá no meu painel. Fica só para interno dele." (o dono)

## O que é

Uma ferramenta de controle, `schedule_return`, para o bot que disparou algo que demora e só pode conferir o resultado depois:

```text
schedule_return({ inMinutes: 1..60, note: "até 500 caracteres: o que conferir ao voltar" })
```

O bot chama, escreve **uma mensagem normal** ao usuário ("Disparei o deploy, volto em 20 minutos para conferir") e a execução fica **parada**, sem worker, sem custo e sem nada na tela. Na hora marcada ela acorda **sozinha**, a **mesma execução** (mesmo plano, mesmo histórico, mesmos orçamentos), recebe a nota que o bot escreveu e continua na mesma conversa.

Não é rotina: não aparece no painel, não tem nome, não se repete e o usuário não a cria. É interno do bot. Horário fixo ou repetição continuam sendo assunto de rotina.

## Sem marcador na interface

Decisão do dono: um indicador "volto às 14h20" com botão Cancelar seria "meio anti-usuário". Então:

- **O aviso é a mensagem do bot.** A ferramenta e o resultado dela mandam o bot contar ao usuário, em texto, o que deixou rodando e quando volta. Essa mensagem é a do turno em que ele se despede (ela fica no evento `status_changed` que estaciona a execução, e o runtime a escreve na conversa como qualquer resposta do bot). Não há outro aviso.
- **Nada novo no app**: a chamada não vira cartão, a execução parada não tem chip nem indicador de trabalho e o avatar fica calmo. Regra em [DESIGN.md](DESIGN.md).
- **Só o diagnóstico mostra**: `suup show` e `suup inspect` (com a hora e a nota), o inspetor do app e os eventos do log.

## Como funciona

| Passo | O que acontece |
|---|---|
| 1. Chamada | O laço valida os argumentos e grava `wait_scheduled { at, note, minutes, callId }` (o instante `at` é fixado agora, e uma retomada ou um replay nunca o recalcula). O resultado da chamada diz ao bot para escrever a mensagem ao usuário e não chamar mais ferramentas |
| 2. Mensagem | O bot responde só com texto. O laço **não** conta isso como "parou sem terminar": estaciona a execução com `status_changed → waiting_timer` (a mensagem vai em `result.summary` do evento) e grava `wake_at`, `wake_note`, `wake_count` na linha da execução |
| 3. Parada | `waiting_timer` não usa worker (como `waiting_user`). A execução continua sendo a execução ativa da conversa |
| 4. Acordar | Um job do worker (`wake-returns`, a cada 5 s; `wakeEveryMs`) pega as `waiting_timer` com `wake_at <= now()` (`FOR UPDATE SKIP LOCKED`) e, **na mesma transação**, grava `wait_fired { at, note, delayMs }` e devolve a execução à fila. Quem a pega é um worker comum |
| 5. Retomada | O laço lê `wait_fired` do log, volta a `running` e acrescenta ao contexto um aviso **do sistema** (nunca do usuário): "Retorno agendado: *nota*" mais o plano como está. O modelo faz o que a nota diz e conta o resultado ao usuário |

**Exatamente uma vez.** A transição `waiting_timer → queued` é a trava: só um worker a faz, o evento e a mudança de estado são uma transação só, e uma execução que já acordou não está mais parada. Se nada rodava na hora (todos os workers fora), o retorno dispara **uma vez, atrasado**, nunca em rajada; `delayMs` registra o atraso e o bot é avisado quando passa de 2 minutos. Uma queda do worker em qualquer ponto é retomada do log (o teste mata o processo depois de cada evento). O replay (`suup replay`) refaz a execução inclusive com o acordar, lendo `wait_fired` do que foi gravado.

## Limites

- **De 1 a 60 minutos**, inteiro. Passou de uma hora: o bot agenda 60 e, ao voltar, confere e agenda de novo.
- **Uma nota de até 500 caracteres.**
- **Um retorno pendente por execução.** Uma segunda chamada substitui a primeira (`wait_cancelled { reason: "replaced" }` e um novo `wait_scheduled`).
- **No máximo 6 retornos seguidos por execução** (`defaults.maxReturns`, ou `limits.maxReturns` do bot; `0` desliga). Depois disso a ferramenta recusa e manda o bot terminar ou perguntar ao usuário. Uma mensagem do usuário zera a conta.
- **Só em conversa do usuário** (`origin: user`). A ferramenta nem é oferecida a avaliações (execuções isoladas), rotinas, delegadas ou de iniciativa; se chamada mesmo assim, é recusada com erro claro.
- **Nunca enquanto a execução espera o usuário ou uma aprovação.**
- **Os orçamentos continuam valendo através dos retornos**: turnos e custo não zeram. O limite de duração (`maxDurationMs`) **não conta o tempo parado**: só o que a execução trabalhou.
- **Aprovações continuam valendo**: é o mesmo laço. Uma ação que pede aprovação depois da volta continua pedindo, e o retorno não aprova nada.
- Esperar não custa token. Uma espera de mais de 5 minutos perde o cache do prompt (TTL de 5 minutos em chave de API): a primeira chamada depois da volta custa como uma chamada a frio.

## Como parar

Nada de botão novo; as formas são as de sempre:

- **Falar com o bot.** Uma mensagem do usuário durante a espera cancela o retorno (`wait_cancelled { reason: "user_message" }`) e a execução segue com a mensagem, como seguiria com a resposta a uma pergunta. Se o bot ainda quiser conferir depois, agenda de novo naquele turno.
- **Cancelar a execução**: o menu do bot no app, `suup stop <execução>` e `POST /v1/runs/{id}/cancel` a cancelam na hora, sem precisar de worker, e gravam `wait_cancelled { reason: "cancelled" }`.
- Terminar o trabalho (`finish`) com um retorno pendente o descarta (`reason: "finished"`).

## O que o log guarda

| Evento | Quando |
|---|---|
| `wait_scheduled` | O bot chamou `schedule_return` (e só se a chamada foi aceita) |
| `wait_fired` | A hora chegou; gravado pelo job que acorda, junto com o requeue |
| `wait_cancelled` | Não vai disparar: `user_message`, `cancelled`, `replaced` ou `finished` |

No banco, `runs.status = waiting_timer` com `wake_at`, `wake_note` e `wake_count` (migração 0019). Na API, `Run.wakeAt` e `Run.wakeNote` ([API.md](API.md)).

## Na CLI

`suup run` e `suup resume` seguem a execução **através** do retorno: o processo que acompanha só trabalha naquela execução, então ele mesmo a acorda na hora (e digitar uma mensagem cancela o retorno). Ctrl+C a deixa parada; um worker (`suup worker`, `suup serve`) a acorda depois. `suup show` mostra "Retorno agendado: hora, nota" e `suup stop` cancela.

## Segurança

- A nota é escrita pelo bot. Se a execução leu conteúdo de fora (uma página, um e-mail), o texto pode ter tentado induzir um retorno. Não há defesa específica nas fontes lidas ([pesquisa](pesquisas/fase-4-acordar-sozinho.md)); o que limita o dano: um retorno por vez, no máximo 6 seguidos, orçamento de turnos e custo que continua valendo, e todas as ações de risco ainda passam pelo portão de aprovação.
- O retorno nunca é uma ação "em segredo": fica no log, e o aviso ao usuário é a mensagem do bot (se ele não avisar, o log e `suup show` mostram).

## Medição com modelo real

[TESTES-REAIS.md](TESTES-REAIS.md), "Fase 4".
