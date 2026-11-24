# Pesquisa: ícones de marca para os conectores (Simple Icons)

Data da pesquisa: 23/11/2026. Apoia a entrega "plug-ins: o ícone do serviço na linha do conector" (Configurações > Conectores). Não muda o backend.

## Pergunta

Dá para identificar o serviço de um conector (GitHub, Notion, Figma, Gmail e os do Google) com o logo dele, num app aberto, de forma legal e sem decidir "o que o conector é" por padrão de texto? E o que fazer com serviços que não estão no pacote (Composio, Higgsfield)?

## Fontes

Lidas em 23/11/2026:

- Registro npm, `simple-icons@16.38.1`: campos `version`, `license` e `time.modified` (consulta `npm view simple-icons@16.38.1`). Resposta: versão 16.38.1, licença `CC0-1.0`, publicada em 22/11/2026.
- Simple Icons, licença do repositório: https://raw.githubusercontent.com/simple-icons/simple-icons/develop/LICENSE.md (CC0 1.0 Universal).
- Simple Icons, aviso legal: https://raw.githubusercontent.com/simple-icons/simple-icons/develop/DISCLAIMER.md.
- O próprio pacote instalado (`apps/desktop/node_modules/simple-icons`, 16.38.1): conferido por código que as exportações existem.

## Fatos verificados

- O pacote está sob CC0 1.0 (registro npm e `LICENSE.md`).
- O aviso legal diz que o projeto ser CC0 "não significa que todos os ícones dentro dele sejam também CC0", que a licença de cada ícone está nos dados do próprio ícone, que as **marcas pertencem aos donos** e que o projeto não responde por reclamação de uma marca contra quem usa o ícone; pede que quem usa leia as diretrizes de marca de cada serviço.
- Existem na 16.38.1, com o caminho (`path`, grade de 24 x 24) e a cor oficial (`hex`): `siGithub`, `siNotion`, `siFigma`, `siGmail`, `siGoogledrive`, `siGooglecalendar`, `siGoogledocs`, `siGooglesheets`, `siStackoverflow`.
- **Não existem** no pacote: `siComposio` e `siHiggsfield`.
- Nenhum dos nove ícones traz um campo `license` próprio nos dados do pacote (veio vazio na leitura), o que o aviso legal diz que **não** prova ausência de licença.

## Inferências

- Um ícone de marca só deve aparecer para **dizer qual é o serviço**, em uma cor só e pequeno, não como enfeite nem como se o Suup fosse parceiro do serviço (é o uso que o próprio aviso legal e as diretrizes de marca costumam aceitar).
- Escolher o ícone pelo **nome exato** do conector (a tabela `github`, `notion`...) não é "classificar por padrão de texto" (docs/REGRAS.md §1): é comparação exata com valores conhecidos, e erra para o lado seguro (nome diferente: ícone genérico). O ícone não decide nada de segurança.
- Em uma cor só (`currentColor`) o glifo segue o tema claro e o escuro sem nenhuma cor nova e fica coerente com os ícones da navegação.

## O que não foi verificado

- As diretrizes de marca de cada serviço (GitHub, Notion, Figma, Google, Stack Overflow): **não lidas**. Por isso o uso foi limitado a um glifo pequeno e em cor única, só para identificar o serviço, e o dono deve confirmar se quiser cores oficiais ou tamanhos maiores.
- Kits de marca oficiais de Composio e Higgsfield: **não consultados**. Eles ficam com o ícone genérico de plug do Lucide (a segunda opção que o dono deu) até o dono escolher o kit.
- Se o campo `license` por ícone mudar em versões futuras do pacote: trocar a versão exige reler o aviso legal.

## Implicação para o Suup

- Dependência `simple-icons` **fixa** em 16.38.1 (sem `^`), importando só os nove ícones por nome (o bundler leva só eles).
- Um módulo só desenha as marcas: `apps/desktop/src/ui/brand-icons.tsx`, com a tabela de **nomes exatos** e o glifo em `currentColor`. Qualquer outro nome (inclusive composio e higgsfield) mantém o `Plug`.
- Regra e teste no `docs/DESIGN.md` §5c e em `design-rules.test.ts`.

## Adendo (23/11/2026): referências de galerias de plug-ins e cores

Pergunta: como as galerias de apps e conectores desenham o cartão de um serviço (cor do logo, fundo, espaço)?

Fontes (busca na web em 23/11/2026; **só os resumos dos resultados foram lidos, as páginas não foram abertas**):

- Claude, diretório de conectores: https://claude.com/docs/connectors/directory e https://support.claude.com/en/articles/11724452-use-the-connectors-directory-to-extend-claude-s-capabilities
- OpenAI, diretrizes de design do Apps SDK: https://developers.openai.com/apps-sdk/concepts/design-guidelines
- Albato, biblioteca de integrações (análise de padrão, SaaSFrame): https://www.saasframe.io/examples/albato-integrations-library
- Cursor, marketplace de plug-ins: https://cursor.com/marketplace

Fatos (do que os resumos dizem):

- Os diretórios do Claude e do ChatGPT são catálogos com busca, categorias e uma página de detalhe por item; a listagem pública de um conector do Claude é um cartão com nome, uma frase e um botão.
- As diretrizes da OpenAI recomendam **cartões** para listas pequenas de itens parecidos, com um só chamado por cartão.
- A análise da Albato descreve **quadrados claros de cerca de 176 x 176 px, cantos de 16 px, sem sombra forte, e os logos dos apps mantendo as cores diversas**: a marca da galeria fica contida e quem dá a cor são os logos.
- O marketplace do Cursor mostra, por item, nome e uma frase, em grade por categoria.

Não verificado: as medidas exatas dos diretórios do Claude e da OpenAI (nenhum resumo as dá); o layout real da página do Cursor.

Inferência e decisão do dono (23/11/2026: "os ícones estão sem cores, sem espaçamento"): na galeria de plug-ins o logo vai **colorido, na cor oficial do pacote, num quadrado claro** (o mesmo nos dois temas, para o logo preto do GitHub e do Notion aparecer no escuro), em **cartões com respiro**. Nas linhas de Conectores o logo continua em uma cor só (ver acima).

## Segundo adendo (23/11/2026): os logos dos plug-ins vêm do thesvg

O dono indicou o thesvg (https://thesvg.org) e pediu "os mais recentes". Fontes lidas em 23/11/2026:

- Página inicial do thesvg e o repositório https://github.com/glincker/thesvg (MIT; última atividade em 23/11/2026; commit usado: `551229c188b4ab6e2d8b5763b9633ec91206d04c`, de 21/11/2026).
- Política de marcas do projeto: https://raw.githubusercontent.com/glincker/thesvg/main/TRADEMARK.md.
- Os dados dos ícones, `src/data/icons.json` desse commit, e os arquivos `public/icons/<slug>/*.svg` (lidos pelo jsDelivr e pelo raw do GitHub).

Fatos verificados:

- A biblioteca tem 5651 pastas de ícones; existem **GitHub, Notion, Figma, Gmail, Google Drive, Google Agenda, Google Docs, Google Planilhas, Stack Overflow e Composio**. **Higgsfield não existe** (nenhuma pasta nem entrada nos dados com esse nome).
- O repositório é MIT; nos dados, cada um dos nove serviços do Simple Icons vem como CC0-1.0 e o Composio como Unlicense. O `TRADEMARK.md` diz que as marcas são dos donos e que os ícones são para **identificação e desenvolvimento** (uso nominativo), com remoção a pedido do dono da marca.
- Os cinco apps do Google têm **duas versões** no thesvg: a antiga (de 07/03/2026) e a do **redesenho de 2026** (`gmail-2026`, `google-calendar-2026`, `google-docs-2026`, `google-drive-2026`, `google-sheets-2026`, de 22/05/2026, com os apelidos "new logo" e "refresh"). O dono avisou que houve rebrand dos apps, então o app usa as **`-2026`**. Figma, GitHub, Notion e Stack Overflow só têm a versão de março; existem variantes "badge" (setembro) de Figma, GitHub e Notion, que **não** foram usadas.
- Os SVGs são os logos **coloridos** (o Gmail em quatro cores, o Drive em três, o Figma em cinco formas); o GitHub tem a variante `dark.svg` (branca) e o Composio é branco; no tema claro o app os inverte, sobre o quadrado cinza do projeto.
- O jsDelivr recusou o `figma/default.svg` (limite de tamanho do pacote); ele veio do raw do GitHub, no mesmo commit.

Não verificado: as diretrizes de marca de cada serviço (o Figma publica uma em https://www.figma.com/using-the-figma-brand/, **não lida**); se o thesvg atualiza os logos quando as marcas mudam. Para atualizar, trocar o commit e copiar de novo (`apps/desktop/src/assets/brand/README.md`).

Implicação: os logos da galeria de plug-ins são arquivos copiados (nada é buscado em tempo de execução, o app funciona sem internet), **sem edição**, num quadrado cinza do projeto. O Simple Icons continua só nas linhas de Conectores, em uma cor.

## Adendo de 23/11/2026: a tela ligada à galeria do servidor

Fontes (lidas em 23/11/2026, no mesmo commit `551229c188b4ab6e2d8b5763b9633ec91206d04c` do thesvg):

- https://raw.githubusercontent.com/glincker/thesvg/551229c188b4ab6e2d8b5763b9633ec91206d04c/public/icons/google/default.svg (o "G" do Google, quadrado, em cores).
- https://raw.githubusercontent.com/glincker/thesvg/551229c188b4ab6e2d8b5763b9633ec91206d04c/public/icons/google-workspace-2026/default.svg (existe, mas é uma faixa de 1216 x 192 com os apps lado a lado; não cabe no quadrado de um ícone).
- `google-2026` e `google-workspace` **não existem** nesse commit (404).
- O `gmail-2026/default.svg` baixado agora é idêntico, byte a byte, ao `src/assets/brand/gmail.svg` copiado antes (a cópia é a mesma fonte).

Implicação: a entrada **Google Workspace** da galeria do servidor (a única do Google; ela está "a confirmar") usa o `google/default.svg`, sem edição, no quadrado cinza. As peças separadas do Gmail, Agenda, Docs, Planilhas e Drive saíram da tela porque o servidor não as oferece; os SVGs delas continuam em `src/assets/brand/` para quando o servidor tiver as entradas. Linear e Stack Overflow seguem no tom `solid` do Simple Icons, agora pelo id do servidor (`stackoverflow`, sem hífen).
