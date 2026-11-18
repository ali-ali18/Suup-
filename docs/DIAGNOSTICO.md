# Diagnóstico: de quem é o problema

Este roteiro é a seção 4.13 do [plano](PLANO.md) escrita como comandos. A pergunta é sempre a mesma: uma execução deu errado, e o defeito está no **modelo**, no **harness** (o loop e o contexto que ele monta), numa **ferramenta**, no provedor ou na infraestrutura? Os comandos vão do mais barato ao mais caro; pare quando a causa aparecer.

Nos exemplos, `3f2a9c1d` é o começo do id de uma execução (a CLI aceita o início do id, com pelo menos 4 caracteres). Todos os comandos aceitam `--json`.

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
