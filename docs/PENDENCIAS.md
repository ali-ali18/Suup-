# Pendências (24/11/2026)

O que falta no Suup, em ordem de prioridade. Branch: `feat/ajustes-ui` (PR #12). Regras: [`AGENTS.md`](../AGENTS.md). O histórico com a evidência de cada item está em [`MELHORIAS.md`](MELHORIAS.md); ao terminar um item, marque-o lá e aqui, com o commit.

## 1. Bugs vistos no PC do dono (primeiro)

| # | O que | Onde olhar | Estado |
|---|---|---|---|
| P1 | **A recepção falha.** Ao abrir o chat vazio do Principal, onde o bot deveria cumprimentar sozinho, aparece "Não consegui terminar: houve um erro interno do Suup". A mensagem seguinte do dono ("oii") fica parada em "Na fila…". Instalador 0.1.0-beta (commit `ae3bc83`), Windows. | `docs/RECEPCAO.md`; o servidor (`packages/server`) e o worker (`packages/runtime`). Peça ao dono os registros: Configurações, parte do servidor, "Abrir a pasta de registros". Reproduza num teste antes de corrigir. "Na fila" parado sugere que o worker caiu ou não pegou a execução depois do erro. | aberto |
| P2 | **A lista dos apps ligados dentro do Composio** (ativo, falta autorizar, falhou) não aparece na página do plugin: o backend não tem um endpoint que a devolva. Só o bot a vê, por `COMPOSIO_MANAGE_CONNECTIONS`. | `docs/CONECTORES.md`, "Composio"; `packages/server/src/routes` | aberto |

## 2. Motor do harness

| # | O que | Estado |
|---|---|---|
| M3 | O `plan` quase não é usado em tarefas de vários passos: rever o prompt e medir de novo. | aberto |
| M4 | As definições das ferramentas pesam cerca de 9 mil tokens por pedido: enxugar e adiar as raras para a busca de ferramentas. | aberto |
| M12 | Um bot barato que erra a fonte de um documento várias vezes gasta os turnos do revisor. A recusa já traz a receita; falta medir de novo. | em andamento |
| M19 | O bot usou o terminal remoto do Composio para um trabalho do próprio Suup. O prompt já foi corrigido e as ferramentas perigosas estão negadas; falta confirmar no uso real. | em andamento |
| Me1 | Memória duplicada quando a consolidação roda com um cartão pendente: reproduzir num teste e corrigir. | aberto |

## 3. Busca

| # | O que | Estado |
|---|---|---|
| B2 | Testar Tavily, Brave e Firecrawl com chaves de verdade (no PC do dono; este ambiente não alcança). | aberto |
| B5 | Pesquisa profunda (deep research): brief, subtemas, fontes, orçamento, citações conferidas. Pesquisa inicial: `docs/pesquisas/motor-de-pesquisa-deep-research.md`. | aberto |
| B6 | WebMCP: item futuro, não é busca (`docs/pesquisas/webmcp.md`). | futuro |

## 4. Avaliações (`evals/`)

A1 (tarefas novas mais longas), A2 (mostrar se `plan`/`finish` foram usados), A3 (3 repetições por célula), A4 (`injection-in-web-fetch` com o sandbox Docker), A5 (texto de falha em checagem que passou), A6 (colunas do revisor), A7 (recalibrar a meta de turnos), A8 (documentos: Word e imagem, 3 repetições). Detalhes em `MELHORIAS.md`. **Respeite o orçamento** (`AGENTS.md`, regra 23).

## 5. Interface (outro agente cuida; siga `docs/DESIGN.md`)

| # | O que | Estado |
|---|---|---|
| U1 | O dono ainda precisa validar o **trilho recolhido** no modelo da referência dele (só bots no topo; uma linha entre as seções; embaixo +, Conectores e a conta). | aguardando o dono |
| U2 | A pílula "Meus conectores" fica desproporcional quando nada está conectado (pilha de logos vazia). | aberto |
| U3 | Um degradê de rolagem cobre um pouco do campo de digitar: confirmar com o dono em qual tela. | aberto |
| U4 | O estilo do hover do botão ocupado. | aberto |
| I1 | O app catar sozinho o retorno do login OAuth e mandar para a VPS (dependência nova no Tauri; pesquisar antes). | aberto |
| I2 | Aviso falso de "sem isolamento" no formulário de conector. | aberto |

## 6. Decisões que só o dono toma (pergunte, não suponha)

- O nome do titular no `LICENSE` ("Alisson"?).
- Tirar a referência a `ali-ali18/atlas` de `docs/pesquisas/avatar-vivo-no-chat.md`?
- Manter as falas do dono citadas nos docs?
- Na legenda ABNT, usar o travessão "–" ou "—"?
- M11: o bot repete o nome do arquivo no texto. Insistir no prompt ou deixar como está?
- M7: liberar o loopback da própria máquina do bot (decisão de segurança)?
- Pesquisar um conector oficial do Google para a galeria?
- Trocar o motor de avatares pelo do Atlas? (O dono sugeriu em 24/11; antes, ler o repositório e comparar.)

## 7. Para o dono fazer no PC

Roteiro em [`TESTE-NO-PC.md`](TESTE-NO-PC.md):
- criar as contas do Tavily e do Brave (e do Firecrawl, se quiser) e pôr as chaves pelo app;
- autorizar a Agenda do Google no Composio pelo cartão do chat.
