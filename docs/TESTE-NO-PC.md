# Testes no PC do dono

Lista curta para conferir, no app instalado, o que não dá para testar na nuvem (contas e chaves de verdade). Cada linha: o que fazer e o que deve acontecer. Se algo falhar, mande o print e a linha do arquivo de registros do dia (Configurações > Geral > Servidor > Registros > Abrir pasta).

## Conectores

| # | Faça | Deve acontecer |
|---|---|---|
| 1 | Notion: peça "liste minhas páginas recentes do Notion" | O bot lista; aprovações aparecem numa linha só |
| 2 | Composio: dê o Principal ao conector (página do plugin) e peça "veja minha agenda de hoje" | Se o Google Agenda não estiver autorizado, um **cartão** com o botão "Conectar Google Agenda" (nunca um link solto no texto) |
| 3 | Autorize pelo cartão e peça de novo | A agenda de hoje |
| 4 | Peça algo do Gmail ("e-mails importantes de hoje") | O resumo; nada de shell remota da Composio |
| 5 | Peça algo que precisa de um conector que não está instalado | Um cartão com a ação (Instalar / Conectar), nunca "vá em Configurações" |

## Busca

| # | Faça | Deve acontecer |
|---|---|---|
| 6 | Sem chaves: peça uma busca geral | Uma frase amigável dizendo que falta a chave, e o resultado da Wikipédia/arXiv/Stack Overflow se couber |
| 7 | Ponha a chave da Tavily (Configurações > Busca ou o plugin) e repita | Resultados; "N buscas este mês" sobe |
| 8 | Ponha a da Brave e, se der, esgote a Tavily | A busca segue pela Brave sozinha |

## Documentos

| # | Faça | Deve acontecer |
|---|---|---|
| 9 | "Faça um PDF sobre X" | O cartão do arquivo embaixo da mensagem; abre em A4, com acentos certos |
| 10 | "Faça um trabalho no padrão ABNT sobre X" | Margens 3/2/2/3, fonte 12, espaçamento 1,5 |
| 11 | "Faça uma planilha de gastos com total" | O Excel abre com fórmulas e valores em reais |

## Rotinas e vigia

| # | Faça | Deve acontecer |
|---|---|---|
| 12 | "A partir de amanhã, me mande os e-mails do dia anterior" | O bot cria a rotina (ou mostra o cartão) com um horário e pergunta se quer mudar; com o bot Rotina na equipe, delega a ele |
| 13 | Apague uma rotina no app e pergunte ao bot sobre ela | Ele sabe que **você** apagou |
| 14 | Pergunte "que dia é hoje?" | O dia da semana certo |
| 15 | Uma tarefa longa que trave | O cartão "Quer que eu continue?" com Continuar / Parar por aqui |
