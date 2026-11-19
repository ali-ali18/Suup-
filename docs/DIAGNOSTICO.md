# Diagnóstico: de quem é o problema

Este roteiro é a seção 4.13 do [plano](PLANO.md) escrita como comandos. A pergunta é sempre a mesma: uma execução deu errado, e o defeito está no **modelo**, no **harness** (o loop e o contexto que ele monta), numa **ferramenta**, no provedor ou na infraestrutura? Os comandos vão do mais barato ao mais caro; pare quando a causa aparecer.

Nos exemplos, `3f2a9c1d` é o começo do id de uma execução (a CLI aceita o início do id, com pelo menos 4 caracteres). Todos os comandos aceitam `--json`.

**O mesmo roteiro pela API.** `inspect --request`, `replay`, `resend` e `doctor` existem também no servidor, com o mesmo código (é o Inspetor do app): `GET /v1/runs/{id}/requests/{seq}`, `POST /v1/runs/{id}/replay`, `POST /v1/runs/{id}/resend` (até 20 vezes) e `GET /v1/doctor` ([API.md](API.md)). A diferença: a API pede o id **inteiro** da execução e não grava o resultado do `resend` em `.suup/diagnostics/` (devolve-o na resposta).

## 1. `suup show`: a classificação já vem pronta

```sh
suup show 3f2a9c1d
```

Mostra a situação, o plano, o resultado ou a falha, o uso e os tempos. Em toda execução que não termina bem, a **origem da falha** aparece logo no alto, com uma linha dizendo o que ela significa:

| Origem | O que significa | Para onde ir |
|---|---|---|
| `provider` | O provedor falhou (rede, chave, limite de taxa, resposta inválida) | Infraestrutura ou configuração: `suup doctor`, a variável da chave, o `baseUrl`. Não é decisão do modelo |
| `model` | O modelo se comportou mal: recusou, parou sem concluir, repetiu a mesma chamada ou não fez progresso | Passo 3 em diante: o que ele viu, e `resend` |
| `tool` | Uma ferramenta falhou ou a máquina dos bots não respondeu | Os eventos `tool_result` (passo 2) e `suup doctor` (sandbox) |
| `harness` | Falha do próprio harness: exceção no loop, conversa reconstruída inválida, configuração do bot inválida | Passo 4 (`replay`); o replay vira teste de regressão |
| `limit` | Um limite foi atingido (turnos, custo ou duração) | Ajustar o limite do bot ou dividir a tarefa; ver se o bot estava num laço |
| `approval` | Uma aprovação necessária foi negada | A decisão foi de uma pessoa |
| `user` | O usuário encerrou a execução | Nada a investigar |

`show` também lista os erros do provedor (`model_error`) e a versão do modelo que respondeu: o provedor devolve a versão real, que pode ser diferente do nome pedido.

## 2. `suup inspect`: a linha do tempo crua

```sh
suup inspect 3f2a9c1d                                # todos os eventos, uma linha cada
suup inspect 3f2a9c1d --type tool_call,tool_result   # só as ferramentas
suup inspect 3f2a9c1d --from 10 --to 20 --full       # um trecho, com o conteúdo completo
```

Cada linha é `seq`, hora, tipo e um resumo. É o que o banco guardou, sem interpretação: o app nunca mostra nada que não esteja aqui.

- Os eventos estão certos e o que você viu na tela estava errado: o problema é do **app** (fase 2).
- Os eventos não existem, ou a execução nem foi criada: é o **servidor ou a fila** (`suup doctor` confere o banco).
- Há `tool_result` com `outcome` diferente de `ok` (`tool_error`, `timeout`, `crashed`...): é a **ferramenta** ou a máquina dos bots. Leia o conteúdo com `--full`.
- Os eventos mostram o modelo decidindo mal: siga para o passo 3.

## 3. `suup inspect --request`: o que o modelo viu

```sh
suup inspect 3f2a9c1d --type model_request     # ache o seq do turno em que ele errou
suup inspect 3f2a9c1d --request 14
```

Imprime exatamente o pedido daquele turno: o prompt do sistema, cada mensagem (com as chamadas de ferramenta e os resultados), o lembrete de estado que o harness acrescenta, as ferramentas oferecidas e, no fim, a resposta gravada com o motivo de parada (`stop reason`) e a versão do modelo.

| O que você encontra | Conclusão |
|---|---|
| A informação necessária **não estava** no contexto | **Harness**: ele montou mal o que o modelo recebe |
| A informação **estava** e o modelo a ignorou | **Modelo** ou instruções |
| A resposta foi cortada (`max_tokens`) ou recusada (`refusal`) | Não foi decisão do modelo: é configuração (`maxOutputTokens`) ou o filtro do provedor |

### Lendo o revisor

Os eventos `review`, `review_evidence` e `review_reprompt` aparecem na linha do tempo (`suup inspect`). Uma revisão é: a chamada do revisor (`model_request`/`model_response` com `purpose: review`), zero a três rodadas de `review_evidence` (cada uma seguida de uma nova chamada ao revisor), no máximo uma repetição da pergunta (`review_reprompt`, ver abaixo) e um `review` final com `approve`, `reject` ou `unverified`.

- `reject` só vale com **divergências estruturadas e reais**: cada entrada de `discrepancies` é `{ claimed, shows, where, real_mismatch }` (o que o trabalho afirma, o que a evidência mostra, onde, e se o próprio revisor diz que é uma diferença **real** entre a afirmação e a evidência). O campo `real_mismatch` é obrigatório na ferramenta `verdict`; a entrada que o revisor marca como não real (ou que vem sem a marca) é **descartada** antes de tudo, e o que sobra, sem a marca, é o que o evento `review` guarda em `discrepancies` e o que vai, numerado, na mensagem de recusa que o bot lê. A lista não é para "o que conferi e bate" (isso vai em `notes`). Um `reject` sem nenhuma divergência real (vazio, ou com entradas do tipo "confere; não há divergência" marcadas como não reais) **não é reprovação**: o harness grava um `review_reprompt` (a resposta do revisor e o motivo, que diz o que foi descartado) e pergunta uma vez mais; se ele der uma divergência real, vale; se aprovar ou disser que não conseguiu verificar, vale isso; se reprovar de novo sem divergência real, o `review` final é `unverified`, com o motivo em `notes`, e a decisão vai ao dono. O harness não julga o texto das divergências: só a marca que o revisor pôs. Se o motivo for "o resumo está cortado" e não um valor errado, é problema do revisor/harness, não do bot: veja se ele pediu evidência (`review_evidence`) e o que foi cortado (`supplied[].sent` menor que `chars`) ou ficou de fora (`omitted`, `missing`).
- O revisor pode pedir três coisas, em campos separados do `need_evidence`: `results` (o que a ferramenta devolveu), `calls` (os **argumentos completos** de uma chamada: o comando de shell inteiro, o conteúdo escrito num arquivo) e `files` (arquivos do espaço de trabalho). O resumo marca `[ARGUMENTS SHORTENED]` quando os argumentos foram cortados e `[SHORTENED]` quando foi o resultado. Um arquivo fora do espaço de trabalho continua ilegível (o limite do executor não muda); o motivo (`missing[].hint`) diz que o conteúdo pode estar nos argumentos da chamada que o escreveu e, quando acha, qual (`#N`).
- O limite real de cada rodada é o **orçamento de caracteres** (60 000), preenchido na ordem pedida (resultados, depois chamadas, depois arquivos): o que cabe inteiro vem inteiro, o primeiro que não cabe vem cortado se sobrar o bastante para valer a pena, o resto fica de fora. O que ficou de fora **só pelo orçamento** está em `omitted` (`{ item, chars }`) e o revisor recebe essa lista, para pedir na rodada seguinte. Há um teto de sanidade de 24 itens por rodada.
- `unverified`: o revisor não conseguiu checar algo (`notes` diz o quê); a execução fica `waiting_user` com a pergunta do dono. O trabalho não foi reprovado. Um `cannot_verify` precisa de um objeto: a lista `unchecked`, com `{ what, kind, ref }` para cada coisa que o revisor não pôde checar (`kind`: `result`, `call`, `file` ou `other`; `ref`: o `#N` do digest ou o caminho que ele precisaria). O harness sabe o que já mandou inteiro (`supplied[].sent == chars` em algum `review_evidence`, ou um resultado/argumento que o próprio digest mostra inteiro). Se a lista está vazia, ou tudo nela já foi enviado inteiro, grava um `review_reprompt` (motivo: "você não listou nada" ou "tudo o que você listou já foi enviado inteiro") e pergunta uma vez mais (a mesma repetição única do `reject`: no máximo um `review_reprompt` por revisão). Se continuar assim, o `review` final é `unverified` com `namedNothing: true` (e `unchecked` com o que ele listou, se listou), e a pergunta ao dono diz com todas as letras que o revisor não nomeou nada que lhe faltasse, para o dono tratar como dúvida sem lacuna concreta. Quando há ao menos um item que ele de fato não tinha, `unchecked` guarda só esses e a pergunta ao dono os lista com o que cada um precisaria.
- Cada rodada extra, e a repetição da pergunta, é uma chamada a mais ao modelo: conta como turno e no custo da execução, e aparece como um `model_request` com `purpose: review` no inspetor. `suup inspect --request <seq>` mostra o que o revisor viu, inclusive o texto da evidência. O número de rodadas (3) é limitado porque cada uma custa uma chamada com até 60 000 caracteres a mais.
- O replay refaz a revisão toda a partir do log (os arquivos que o revisor leu estão em `review_evidence`; resultados e argumentos de chamadas vêm dos eventos `tool_result` e `tool_call`), sem tocar na máquina.

## 4. `suup replay`: o harness reproduz a execução?

```sh
suup replay 3f2a9c1d
```

Roda o loop **atual** de novo, usando as respostas do modelo e os resultados das ferramentas que foram gravados. Nada é chamado de verdade: nenhum modelo, nenhuma ferramenta, nenhum efeito colateral. O relatório diz se o resultado é idêntico, a primeira divergência (posição, o que foi gravado e o que a reexecução fez), as diferenças nos pedidos ao modelo e uma leitura em um parágrafo:

| Leitura | Significa |
|---|---|
| "O loop atual reproduz a execução" | Com as mesmas respostas, o harness toma as mesmas decisões e monta os mesmos pedidos. Se o resultado foi ruim, a causa **não está no código do harness**: é o modelo ou as instruções. Vá ao passo 5 |
| "Só o que é enviado ao modelo mudou" | As decisões são as mesmas, mas o prompt, o contexto ou a descrição de alguma ferramenta mudou desde a gravação. Os modelos poderiam responder diferente agora |
| "O comportamento do harness mudou no evento N" | Com as mesmas respostas, o código atual decide de outro jeito (código de saída 1). Se a mudança foi proposital, essa execução deixou de valer como teste; se não foi, é uma **regressão do harness** |

Uma execução com falha de origem `harness` deve ser guardada: o replay dela é o teste de regressão do conserto.

## 5. `suup resend --times`: erra sempre ou só às vezes?

```sh
suup resend 3f2a9c1d --seq 14 --times 10
```

Reenvia o pedido gravado do evento 14 (o `seq` do `model_request`) ao **mesmo modelo**, 10 vezes, exatamente como foi gravado. A execução não é tocada e o custo não entra nela. Para cada tentativa mostra o motivo de parada, as chamadas de ferramenta (nome e argumentos), um trecho do texto, os tokens, a latência e a versão do modelo. No fim, uma linha de resumo conta os desfechos distintos e diz quantas vezes o desfecho gravado se repetiu:

| Resultado | Conclusão |
|---|---|
| O desfecho gravado se repete em todas as tentativas | O modelo **errou sempre** com esse pedido: o problema está no que foi enviado (instruções ou contexto), não em variação do modelo |
| Repete em algumas | O modelo **erra às vezes**: é variação do modelo (instruções mais claras ainda podem reduzi-la) |
| Não repete em nenhuma | O desfecho gravado foi uma exceção |

Os resultados completos ficam em `.suup/diagnostics/` (JSON), para comparar depois.

## 6. `suup resend --model`: só este modelo erra?

```sh
suup resend 3f2a9c1d --seq 14 --times 5 --model model-y
```

Reenvia o mesmo pedido a **outro modelo configurado**. Compare com o desfecho gravado, que o relatório repete:

| Resultado | Conclusão |
|---|---|
| Outro modelo acerta onde o original errou | **Só o modelo original erra**: é o modelo |
| Todos erram do mesmo jeito | É **o que foi enviado**: instruções ou contexto montado pelo harness. Volte ao passo 3 |

## Quando os comandos acima não bastam

- `suup doctor` confere cada componente (configuração, banco e migrações, sandbox, provedores, ferramentas). Com `--live` faz uma chamada minúscula de verdade a cada modelo e mostra a latência e a versão que o provedor devolveu.
- Um defeito de tradução no adaptador de um provedor parece defeito do modelo. A bateria de conformidade (`packages/providers/test/conformance.test.ts`) é o que os distingue: se ela passa e o modelo continua errando, o adaptador não é o problema.
- O conjunto de avaliação em matriz por modelo e a qualificação de modelo (seção 9, item 11 do plano) ainda não existem na CLI.
