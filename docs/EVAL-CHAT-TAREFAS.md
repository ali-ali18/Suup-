# Eval: chat ou tarefa (KOD-68)

Mede se o bot manda **sozinho** o trabalho longo para uma tarefa, sem botão e sem perguntar, e se trata cada pedido de uma mensagem com vários. Compara duas variantes:

- **A**: só o prompt reforçado (a descrição de `start_task` e a seção de tarefas: decidir antes da primeira chamada; mais de uns 5 usos de ferramenta ou um minuto é tarefa, mesmo com terminal).
- **B**: o mesmo prompt, mais o **freio cedo** (5 chamadas ou 60 s sem tarefa: o harness move o trabalho) e a **conferência no fim** (um modelo barato confere se algum pedido ficou de fora). Ver [TAREFAS.md](TAREFAS.md).

## Os casos

32 casos em `evals/src/chat-tasks/cases.ts`, escritos antes de rodar e não ajustados depois:

| Grupo | Casos | Certo é | Antes (rodada real anterior) |
|---|---|---|---|
| Rápidos | 9 | responder no chat, nenhuma tarefa | 7/7 |
| Longos (7 no terminal) | 9 | uma tarefa | 3/6 |
| Vários pedidos | 8 | uma tarefa por pedido longo, os rápidos no chat | 1/3 |
| Seguimento | 6 | repassar à tarefa aberta (`send_to_task`), sem tarefa nova; ou nada, se a mensagem não é sobre ela | sem referência |

Cada caso cria um bot novo (conversa sem histórico) com `shell`, `read_file`, `write_file`, `edit_file`, `list_files` e `search_files` liberados por regra do próprio bot, escreve a pasta que a mensagem cita (projeto com testes falhando, 40 CSV, 30 logs...) e roda **só o turno do chat**. As tarefas abertas são contadas e canceladas; nenhuma é executada. Uma execução de chat que passa de 14 chamadas ou 240 s é cancelada e conta como trabalho preso no chat. O relatório traz, por grupo, acertos contra a rodada anterior, quantos longos viraram tarefa pelo bot e quantos pelo freio (e depois de quantos passos), latência até a primeira resposta e até o fim do turno (mediana e p90) e o custo.

## Como rodar (sessão no ambiente Suup)

O ambiente precisa da variável `SUUP_ANTHROPIC_KEY`, acesso a `api.anthropic.com` e a um PostgreSQL. A chave nunca vai para o repositório nem para o chat: só o **nome** da variável aparece na configuração.

1. Instalar e conferir:

   ```
   pnpm install
   pnpm lint
   pnpm typecheck
   DATABASE_URL=postgres://suup:suup@127.0.0.1:5432/suup pnpm vitest run
   ```

2. Uma configuração **fora do repositório** (por exemplo `/tmp/suup-eval/suup.config.json`), com sandbox local e o mesmo modelo da rodada anterior. Os preços são obrigatórios (sem eles o teto não vale):

   ```json
   {
     "providers": [{ "id": "anthropic", "kind": "anthropic", "apiKeyEnv": "SUUP_ANTHROPIC_KEY" }],
     "models": [
       { "id": "<modelo do chat>", "provider": "anthropic", "contextWindow": 200000, "maxOutputTokens": 4096,
         "pricing": { "inputPerMTok": 0, "outputPerMTok": 0, "cachedInputPerMTok": 0, "cacheWriteInputPerMTok": 0 } },
       { "id": "<modelo barato da conferência>", "provider": "anthropic", "contextWindow": 200000, "maxOutputTokens": 1024,
         "pricing": { "inputPerMTok": 0, "outputPerMTok": 0, "cachedInputPerMTok": 0, "cacheWriteInputPerMTok": 0 } }
     ],
     "sandbox": { "kind": "local", "root": "workspace" }
   }
   ```

   Preencha os ids e os preços reais (US$ por milhão de tokens) dos modelos.

3. Migrar o banco e rodar as duas variantes, com teto total de US$ 0,60 (metade para cada):

   ```
   export DATABASE_URL=postgres://suup:suup@127.0.0.1:5432/suup
   export SUUP_CONFIG=/tmp/suup-eval/suup.config.json
   pnpm db:migrate
   pnpm suup eval chat-tasks --model "<modelo do chat>" --check-model "<modelo barato da conferência>" \
     --variant ab --budget-usd 0.60 --out /tmp/suup-eval/chat-tasks.json --yes
   ```

   Sem `--yes` ele só mostra o plano. Com o teto atingido, os casos que faltam aparecem em "NÃO RODARAM"; a ordem alterna os grupos, então todo grupo tem casos rodados.

4. Relatar, por variante: acertos por grupo contra 7/7, 3/6 e 1/3; longos pelo bot × pelo freio e passos antes da tarefa; latência (mediana e p90); custo total e por caso; os ids que falharam.

## O que isso NÃO mostra

- Uma rodada, um modelo, 32 casos: não é uma taxa.
- As tarefas não rodam: não mede se o trabalho ficou bom, só para onde foi.
- O freio decide por contagem: um pedido rápido que precisa de muitas chamadas também vira tarefa (é o comportamento pedido).
