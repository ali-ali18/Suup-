# Regras de engenharia do projeto

Regras do dono que valem para todo o repositório (a interface tem as suas em [DESIGN.md](DESIGN.md)). Quem trabalha aqui lê isto antes de escrever código. Cada regra é checável; o que um teste consegue conferir está citado.

## 1. Regex e padrões de texto no harness

> "Tem regex que são úteis. Mas dependendo do regex vira amarra, como o do arquivo ou o de identificação." (o dono)

Entender texto é trabalho do **modelo**. O harness tira estrutura de **dados declarados**: esquemas, sinalizadores, ids, comparação exata com valores conhecidos. Uma regex que decide o que algo *é* prende o harness a palavras e o deixa pobre de linguagem.

**Proibido (amarra).** Regex, glob ou qualquer padrão de texto usado para **identificar, classificar, filtrar, interpretar ou barrar**: decidir o que um texto, arquivo, caminho, argumento, chamada de ferramenta, mensagem ou intenção *é*, ou se algo pode rodar, fica escondido, é guardado ou reescrito por causa de como "parece". Inclui casar arquivos ou argumentos por padrão em regras (as regras de aprovação só comparam por **igualdade exata**), e reconhecer texto "com cara de segredo" ou "com cara de e-mail" por padrão. Vale também para SQL (`~`, `SIMILAR TO`, `regexp_*`), `RegExp`, literais de regex, glob convertido em regex e `.match`/`.replace`/`.test`/`.split` com padrão.

**Permitido.** Regex que **lê ou valida um formato formal de gramática fixa**: linhas de protocolo (SSE), sequências ANSI, sintaxe de identificador ou nome, nome de arquivo de migração, sintaxe de URL ou host, formato de número ou data. É o caso em que um acerto errado não muda o que o harness acredita sobre o significado.

**Na dúvida, pergunte ao dono antes.** Regex nova, mesmo do tipo permitido, entra na lista abaixo com um motivo de uma linha, com o OK do dono.

**Como o teste cobre.** `packages/core/test/no-regex.test.ts` lê a árvore sintática de todo o código do harness (`packages/*/src`, `apps/*/src`, `evals/src`) e falha se aparecer uma regex (literal ou `RegExp(...)`) fora de `packages/core/test/regex-allowlist.ts`, ou se a contagem de um arquivo mudar. O detector não usa regex. Além disso exige que o código de aprovações (regras, decisões, cartões, cofre) e as migrações a partir da 0013 fiquem **sem nenhuma**.

**O que fazer no lugar:** estrutura declarada (uma ferramenta declara `outbound`; o usuário marca uma ferramenta de conector), comparação exata, analisadores de formatos formais, ou deixar o entendimento ao modelo.

### Decisões já aplicadas

- Regras de aprovação: só **igualdade exata** dos campos nomeados (`starts_with`, `contains` e `glob` foram removidos; migração 0013 desativa as regras antigas e `suup doctor` as aponta).
- **Regras escritas do Auto-review** (fase 3): o usuário escreve a regra em linguagem comum e quem a **lê** é o modelo revisor. O código guarda o texto (aparado, até 500 caracteres) e **não o interpreta**: sem regex, sem busca de palavras, sem transformar em condição. O que o código confere é estrutura declarada: o **tipo** da regra que o modelo cita (`never`, `ask`, `allow`) e se o id existe. Ver [APROVACOES.md](APROVACOES.md).
- Mensagem a outra pessoa: nunca deduzida do nome ou do texto da ferramenta (era `/mail|smtp|imap|gmail|outlook/i` no app).
- `redactSecrets` e `SECRET_PATTERNS` (reconhecer "texto com cara de segredo") saíram: o diário não copia o texto do usuário, o redator do cofre troca só valores **exatos** conhecidos e o prompt manda não guardar segredos. Lacuna honesta em [MEMORIA.md](MEMORIA.md) e [COFRE.md](COFRE.md).
- **Exceção aprovada pelo dono (19/11/2026): a busca de ferramentas por regex da API da Anthropic.** A variante hospedada `tool_search_tool_regex` (ao lado da `bm25`) pode ser usada, porque o padrão é escrito pelo **modelo**, em tempo de execução, para procurar num catálogo: não é um filtro fixo do harness e **não barra nada** (o que o bot pode usar já foi decidido pela concessão por ferramenta e pelo portão de aprovação). Nosso código continua **sem nenhuma regex** para isso: o índice, a busca própria (`search_tools`, por palavras iguais depois de dividir por classe de caractere) e a validação dos argumentos não usam padrão. Ver [CONECTORES.md](CONECTORES.md), "Muitas ferramentas".
- Também sem regex: roteamento HTTP do servidor (compara segmentos), ids da CLI (prefixo de id), nomes de variável proibidos de conector (conjunto exato), cabeçalho `X-Request-Id`, chave mestra do cofre, nome de campo de condição.

- O texto da resposta a uma pergunta do bot (`answers.ts`, agora em `packages/core`) achata espaço em branco sem regex (`oneLine`); a resposta que é exatamente o número ou a letra de uma opção vira o rótulo por comparação exata.

### Dúvida: perguntar ao dono

Itens sem decisão clara; **não foram removidos**:

- `packages/connectors/src/spec.ts` (`^-[a-z]*c[a-z]*$`): detecta "shell com `-c`" para recusar um conector. É heurística de proteção por padrão. Recomendação: comparar só `-c` e `-lc` exatos, ou manter e o dono assumir.
- `packages/tools/src/html-to-text.ts` (31) e `apps/desktop/src/lib/markdown.tsx` (13): convertem HTML e Markdown por regex. É formato formal, mas regex em HTML é frágil. Recomendação: parser de verdade.
- `packages/connectors/src/text.ts`: limpa texto de servidor MCP (controle, invisíveis). Recomendação: manter (classe de caractere, não significado).
- Providers (`common.ts`, `openai-compatible.ts`), `sandbox/machine.ts`, `server/errors.ts`, `runtime/config.ts`, `runtime/conversations.ts`, `core/replay.ts`: leem o **texto** de um erro ou de uma saída. Recomendação: usar código/status/campos declarados.
- `evals/`: notas por palavras na resposta do modelo e classificação de comandos. Recomendação: juiz por modelo ou resposta estruturada comparada por igualdade.
- Espaço em branco (`/\s+/g`) em vários arquivos: achata texto para exibir. Recomendação: dividir sem regex.

### Regex existentes aguardando decisão do dono

Total: 191 regex em 76 arquivos (a: 68 · b: 16 · c: 104 · d: 3). Geradas por varredura da árvore sintática; o teste `packages/core/test/no-regex.test.ts` impede novas.


### Grupo a — decide, filtra ou interpreta (proibido pela regra; AGUARDA o dono)

| Arquivo:linhas | Para que serve | Sem regex |
|---|---|---|
| `apps/cli/src/args.ts` (80, 83, 86, 87, 113) | lê o TEXTO das mensagens de erro do parseArgs do Node (/ambiguous/, /argument missing/...) para decidir que erro de uso mostrar; mais `^[1-9][0-9]*$` (inteiro positivo, formal) | usar o `code` do erro do parseArgs (ERR_PARSE_ARGS_*) em vez do texto |
| `apps/cli/src/commands/eval.ts` (50, 63, 150, 322) | `^(s\|sim\|y\|yes)$` interpreta a resposta digitada (sim/não); `\s+` normaliza espaço; números | conjunto exato de respostas aceitas (`Set`), sem regex |
| `evals/src/hard/conflicting-sources.ts` (144, 144, 196, 196, 228) | nota a resposta do modelo procurando palavras (campinas, são paulo, foro) no texto | juiz por modelo, ou resposta final estruturada comparada por igualdade |
| `evals/src/hard/flaky-tooling.ts` (26, 27) | lê a saída de uma ferramenta e reconhece um laço de shell (`for/while ... do`) para a nota | resultado estruturado da ferramenta; ou juiz por modelo |
| `evals/src/hard/injection.ts` (191, 193, 237) | nota se o modelo obedeceu ou denunciou uma injeção, procurando palavras na resposta e no comando | juiz por modelo; ou checar efeito (arquivo criado) por igualdade |
| `evals/src/hard/partial-failure-honesty.ts` (89, 138, 142, 143, 219) | lê a resposta do modelo (`PENDENTES: ...`) e nomes de arquivo para a nota | resposta final estruturada comparada por igualdade |
| `evals/src/kit.ts` (149, 154, 155, 159, 169, 180) | classifica comandos de shell do bot em 'escreve' ou 'lê' procurando palavras (`tee`, `sed -i`, `cat`...) e acha nomes de arquivo no comando | registrar o efeito real (diff do workspace) em vez de interpretar o comando |
| `evals/src/qualify/index.ts` (174) | escolhe por palavras (`balanço`, `xlsx`) uma tarefa de qualificação | lista explícita de ids |
| `evals/src/tasks/impossible-task.ts` (25) | nota a resposta do modelo procurando `segredo\|token` | juiz por modelo |
| `evals/src/tasks/multi-file-refactor.ts` (92) | acha usos de um nome (`calc_total`) no código do bot para a nota | analisador de código ou teste que roda o código |
| `evals/src/tasks/simple-question.ts` (5) | nota a resposta procurando `366` | resposta estruturada ou juiz por modelo |
| `packages/connectors/src/spec.ts` (67, 69, 134, 161, 162) | (1) `^-[a-z]*c[a-z]*$` DETECTA se um argumento é um `-c` de shell (decide recusar o conector); o restante é sintaxe formal: nome de variável, nome de cabeçalho HTTP (RFC 9110), espaço no executável, separador de caminho | (1) a lista é uma heurística: perguntar ao dono se mantém (ou comparar só `-c`/`-lc`, exatos); o resto manter |
| `packages/core/src/replay.ts` (313, 329) | lê o TEXTO da saída de uma ferramenta gravada (`could not be read: `, `(N bytes`) para comparar repetições | gravar esses fatos como campos do evento, não no texto |
| `packages/providers/src/common.ts` (47) | reconhece pelo TEXTO do erro do provedor que o contexto estourou (`context length`, `too many tokens`...) para decidir o que fazer | usar o status HTTP e o `code`/`type` que o provedor declara, comparados por igualdade |
| `packages/providers/src/openai-compatible.ts` (68, 217, 218, 219, 221, 222) | classifica o erro do provedor procurando palavras no `code` (`rate_limit`, `overload`, `auth`...) para decidir se tenta de novo; mais barra final de URL | tabela de códigos exatos por provedor + status HTTP |
| `packages/runtime/src/config.ts` (8, 9, 101, 118, 305) | sintaxe de ids/nomes/tamanhos/URL na configuração (formal); e `Invalid input: expected X, received Y` lê o TEXTO de uma mensagem do zod para mostrar um erro mais claro | para o texto do zod usar `issue.code` e `issue.expected`; o resto manter |
| `packages/runtime/src/conversations.ts` (114) | olha o TEXTO de uma mensagem de erro (`archived`) para decidir como responder | usar o tipo/código do erro |
| `packages/sandbox/src/machine.ts` (40, 44, 51, 116, 122, 141) | lê o TEXTO de erro do Docker (`no such container/volume/object`) para decidir se algo não existe; mais sintaxe de imagem e tamanho | usar o código de saída de `docker inspect`; sintaxe: conferir caractere a caractere |
| `packages/server/src/errors.ts` (49) | lê o TEXTO de uma mensagem do zod (`received undefined`) para dizer 'campo obrigatório' | usar `issue.code` / `issue.input` |
| `packages/server/src/routes/meta.ts` (10, 11) | acha o fim da primeira frase de um texto de bot (`[.!?]`) para fazer uma descrição curta: interpreta pontuação de linguagem natural | cortar por tamanho, ou deixar o bot escrever a descrição curta |
| `packages/tools/src/web-fetch.ts` (14, 67, 224, 228, 231) | (1) `^\s*(<!doctype html\|<html)` RECONHECE se o corpo é HTML olhando o começo; (2) lista de tipos MIME 'de texto' decide o que o modelo recebe; (3) nome de cabeçalho e `[\r\n\0]` (formais) | (1)(2) usar só o Content-Type declarado, comparado por igualdade; (3) manter |

### Grupo b — reescreve ou limpa texto

| Arquivo:linhas | Para que serve | Sem regex |
|---|---|---|
| `apps/cli/src/commands/resend.ts` (117) | troca `:` e `.` do horário por `-` para formar nome de arquivo | `replaceAll` de texto fixo |
| `apps/cli/src/format.ts` (90) | achata espaços em branco de uma linha para exibir | dividir por espaço/quebra sem regex |
| `apps/desktop/src/data/actions.ts` (51) | achata espaços em branco de um texto para a linha de resumo | dividir sem regex |
| `apps/desktop/src/data/botlist.ts` (58) | `\p{Diacritic}`: tira acentos para comparar nomes na busca (comparação sem acento) | `localeCompare(..., { sensitivity: 'base' })` |
| `evals/src/tasks/prompt-injection-file.ts` (33) | `\p{Diacritic}`: tira acentos para comparar a resposta | `localeCompare` com sensibilidade base |
| `packages/avatar/src/avatar.ts` (81) | troca caracteres fora de [a-zA-Z0-9_-] num id gerado | percorrer e substituir caractere a caractere |
| `packages/connectors/src/text.ts` (13, 16, 39, 40, 41, 48) | limpa texto vindo de um servidor MCP (não confiável): tira caracteres de controle e invisíveis (classes Unicode fixas) e normaliza espaços/quebras | manter (limpeza por classe de caractere, não por significado) ou dono decide |
| `packages/core/src/untrusted.ts` (11) | neutraliza as cercas `<<<EXTERNAL_DATA` / `<<<END_EXTERNAL_DATA` dentro de texto de fora, para ele não fechar o envelope | `indexOf` do texto fixo, sem regex |
| `packages/runtime/src/memory-service.ts` (25) | achata espaços em branco de um trecho de memória para exibir | dividir sem regex |
| `packages/runtime/src/run-end.ts` (30) | achata espaços em branco do resumo antes de cortar para o diário | dividir sem regex |
| `packages/tools/src/edit-file.ts` (123) | achata espaços em branco para mostrar um trecho na mensagem de erro | dividir sem regex |

### Grupo c — formato formal (permitido)

| Arquivo:linhas | Para que serve | Sem regex |
|---|---|---|
| `apps/cli/src/commands/connectors.ts` (10, 259) | sintaxe de nome de segredo (A-Z, 0-9, _) e inteiro | comparar caractere a caractere (como `isIdPrefix`) |
| `apps/cli/src/commands/inspect.ts` (15) | inteiro sem zeros à esquerda (argumento --seq) | `Number.isInteger` + `String(n) === texto` |
| `apps/cli/src/commands/vault.ts` (27) | sintaxe de nome de segredo | comparar caractere a caractere |
| `apps/cli/src/questionnaire.ts` (20) | a resposta é um número de opção (`^\d+$`) | conferir os dígitos um a um |
| `apps/cli/src/secret-input.ts` (26) | tira o `\n`/`\r\n` final da linha lida | `endsWith` |
| `apps/desktop/src/app/connect.ts` (13, 14) | esquema de URL (`https://`) e barras finais ao conectar a um servidor | `URL` do navegador + `endsWith` |
| `apps/desktop/src/features/inspector/InspectorScreen.tsx` (209) | número da sequência de um evento (`^\d+$`) | conferir os dígitos um a um |
| `apps/desktop/src/lib/connector-form.ts` (78, 79, 85, 133, 152) | validação de formulário: nome de variável, nome de cabeçalho, URL http(s), espaço no executável, `\r` de fim de linha | validadores caractere a caractere / `URL` |
| `apps/desktop/src/lib/format-args.ts` (22) | gramática fixa do marcador `{{secret:NOME}}` para desenhar o selo do segredo | percorrer o texto procurando `{{secret:` e `}}` (gramática fixa) |
| `apps/desktop/src/lib/links.ts` (55, 68) | sintaxe de IPv4 e de nome de host ao decidir como desenhar um link | `URL` + conferência por caractere |
| `apps/desktop/src/lib/markdown.tsx` (19, 20, 23, 32, 37, 48, 76, 120, 214, 215, 216, 217, 218) | leitor de Markdown simples (títulos, listas, cercas de código, negrito, links): gramática fixa de um formato, não significado | biblioteca de Markdown, ou manter (dono decide) |
| `apps/desktop/src/lib/pane-size.ts` (87) | lê a largura gravada (`^\d{1,5}$`) | conferir os dígitos |
| `apps/desktop/src/ui/question-card.tsx` (105) | tecla de atalho A-F de uma opção | comparar com o conjunto de letras |
| `evals/src/hard/kit.ts` (145) | lê a saída de um programa de testes (`nome (módulo) ... ok/FAIL`): formato fixo do unittest | manter, ou `--json` do executor de testes |
| `packages/api/src/client.ts` (237) | tira barras finais da URL base | `endsWith` em laço |
| `packages/api/src/connectors.ts` (5) | sintaxe do nome de conector (minúsculas, dígitos, hífens) | comparar caractere a caractere |
| `packages/api/src/sse.ts` (72) | `id:` de um quadro SSE é um número (protocolo) | conferir os dígitos |
| `packages/api/src/subscribe.ts` (116) | tira barras finais da URL base | `endsWith` em laço |
| `packages/api/src/vault.ts` (4) | sintaxe do nome de segredo | comparar caractere a caractere |
| `packages/avatar/src/render/path-utils.ts` (8, 8) | lê comandos de caminho SVG (`L`, `Z`) e separa números | leitor de caminho dedicado |
| `packages/avatar/src/render/svg.ts` (41, 54, 64) | valida cor/valor de CSS e ids que entram num SVG gerado (lista fixa de formas) | validar com leitor de cor dedicado |
| `packages/connectors/src/names.ts` (8, 41, 45, 46) | sintaxe do nome de conector e normalização do nome de ferramenta do servidor para `[a-z0-9_]` | conferir/substituir caractere a caractere |
| `packages/connectors/src/schema.ts` (202) | `$ref` de JSON Schema (`#/$defs/nome`): gramática fixa | dividir por `/` |
| `packages/core/src/loop/evidence.ts` (105) | lê o id de evidência `#12` que o modelo escreveu (`^#?(\d+)$`) | separar `#` e conferir dígitos |
| `packages/core/src/registry.ts` (17, 449) | sintaxe de nome de ferramenta (`^[a-z][a-z0-9_]{0,63}$`) e nome de arquivo seguro de um id | conferir caractere a caractere |
| `packages/core/src/secrets.ts` (7, 13, 132) | gramática fixa do marcador `{{secret:NOME}}` e do nome de segredo; tira `=` de preenchimento base64 | percorrer o texto procurando o marcador |
| `packages/db/src/client.ts` (18) | sintaxe de identificador SQL (nome de esquema) | conferir caractere a caractere |
| `packages/db/src/events.ts` (107) | id de inbox é inteiro (`^\d+$`) | conferir os dígitos |
| `packages/db/src/inbox.ts` (102) | id de inbox é inteiro (`^\d+$`) | conferir os dígitos |
| `packages/db/src/migrate.ts` (13) | nome de arquivo de migração (`0001_nome.sql`) | dividir por `_` e conferir |
| `packages/db/src/runs.ts` (291) | formato numérico de um valor vindo do banco | `Number` + conferência |
| `packages/db/src/secrets.ts` (56) | sintaxe do nome de segredo | comparar caractere a caractere |
| `packages/providers/src/anthropic.ts` (58) | tira barras finais da URL base | `endsWith` |
| `packages/runtime/src/runtime.ts` (146) | sintaxe do nome de uma máquina/provedor na configuração | conferir caractere a caractere |
| `packages/sandbox/src/docker-executor.ts` (92, 112, 272) | sintaxe de nome de imagem, variável e volume antes de montar o comando do Docker | conferir caractere a caractere |
| `packages/server/src/auth.ts` (42) | cabeçalho `Authorization: Bearer <token>` (RFC 6750) | dividir no primeiro espaço |
| `packages/server/src/http.ts` (166) | tipo de mídia `application/json` do cabeçalho Content-Type | dividir por `;` e comparar |
| `packages/server/src/server.ts` (369) | inteiro do cabeçalho Content-Length | conferir os dígitos |
| `packages/tools/src/html-to-text.ts` (51, 76, 79, 80, 81, 82, 84, 90, 92, 93, 94, 99, 101, 112, 113, 114, 115, 116, 117, 118, 119, 127, 128, 132, 136, 143, 147, 151, 160, 170, 171) | converte HTML em texto: tira tags/comentários/scripts, decodifica entidades, acha `<a>`, `<img>`, `<pre>` (gramática de HTML, mas por regex) | parser de HTML de verdade; dono decide |
| `packages/tools/src/list-files.ts` (86) | tira `/` final de um caminho | `endsWith` |
| `packages/tools/src/read-file.ts` (131) | tira `/` final de um caminho | `endsWith` |
| `packages/tools/src/util.ts` (23, 30) | tira `/` finais de um caminho | `endsWith` em laço |
| `packages/tools/src/write-file.ts` (35) | tira `/` final de um caminho | `endsWith` |

### Grupo d — configuração/ajuda de teste

| Arquivo:linhas | Para que serve | Sem regex |
|---|---|---|
| `apps/desktop/vite.config.ts` (10, 11, 12) | aliases do bundler (configuração, não lógica do harness) | manter |

### SQL (migrações 0001 a 0012)

As migrações antigas validam nomes com `~` (`name ~ '^[A-Z][A-Z0-9_]{0,63}$'` em `secrets`, `name ~ '^[a-z]...'` em `connectors`): formato formal de nome, grupo c. Migrações já aplicadas nunca se editam; da 0013 em diante o teste proíbe operadores e funções de regex.

## 2. Pesquisa confiável antes de implementar

> "Cada etapa do plano ganha uma pesquisa confiável, para validar a ideia antes de implementar." (o dono)

Antes de desenhar ou implementar uma fase ou entrega significativa de [PLANO.md](PLANO.md):

1. Faça uma pesquisa sobre como produtos, APIs e especificações atuais resolvem o problema.
2. **Só fontes primárias** (documentação oficial, especificações, artigos de engenharia, artigos científicos). Cada afirmação com **URL e data**. **Fatos** separados de **inferências**; o que não deu para conferir fica como "não verificado".
3. Salve em `docs/pesquisas/<fase>-<tema>.md` (formato em [pesquisas/README.md](pesquisas/README.md): pergunta, fontes com data, fatos verificados, inferências, o que não foi verificado, implicação para o Suup) e ligue a pesquisa na seção do plano que ela valida.
4. Se a pesquisa **contradiz** o desenho planejado, **mude o plano** (ou pergunte ao dono) **antes** de escrever código.

## 3. Outras regras

- Regras permanentes de aprovação só nascem de um **ato explícito do usuário** (Configurações > Permissões, `suup rules`, ou "Permitir destinatário" no cartão de uma mensagem a outra pessoa), nunca de um cartão comum. Ver [APROVACOES.md](APROVACOES.md).
- Ações comuns pedem só **aprovar ou recusar**; a escolha extra (menu do botão dividido) existe só para mensagens a outras pessoas, e só quando a ferramenta (ou o usuário, no conector) **declarou** que é uma. Ver [DESIGN.md](DESIGN.md).
