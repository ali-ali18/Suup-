# Pesquisa: a ferramenta que monta o documento (PDF, Word, Excel) no servidor

Data da pesquisa: 24/11/2026. Valida o pedido do dono de 24/11/2026: "por que o bot roda Python para fazer um PDF?" e "o resultado com excelência e nada mais". O desenho aprovado: o bot dá o **conteúdo** e o **formato**, o Suup monta um arquivo bem desenhado e o entrega no chat (o mesmo cartão do `send_file`, [arquivos-no-chat.md](arquivos-no-chat.md)). Sem Python, sem terminal, menos tokens.

## Pergunta

Quais bibliotecas Node/TypeScript, mantidas, de licença MIT ou compatível com Apache, montam PDF, DOCX e XLSX **dentro do processo do servidor** (o app embutido, empacotado num arquivo só pelo esbuild, e a VPS) sem navegador, sem rede e sem programa externo; com que fonte o texto em português sai certo; e que formato de entrada o modelo escreve melhor?

## Fontes

Lidas em 24/11/2026 (`curl` em raw.githubusercontent.com e gitlab.com; `npm view` no registro do npm para versões, datas e licenças). `pdfmake.github.io`, `spec.commonmark.org` e `github.github.com` não abriram nesta rede (proxy).

- pdfmake, README: https://raw.githubusercontent.com/bpampuch/pdfmake/master/README.md
- pdfmake, CHANGELOG (0.3.0 a 0.3.15 e "Unreleased"): https://raw.githubusercontent.com/bpampuch/pdfmake/master/CHANGELOG.md
- pdfmake, LICENSE (MIT): https://raw.githubusercontent.com/bpampuch/pdfmake/master/LICENSE
- pdfmake 0.3.14, código publicado (`src/base.js`, `src/Printer.js`, `src/PDFDocument.js`), lido no pacote instalado.
- PDFKit, README e `docs/text.md` (fontes): https://raw.githubusercontent.com/foliojs/pdfkit/master/README.md e https://raw.githubusercontent.com/foliojs/pdfkit/master/docs/text.md ; LICENSE (MIT): https://raw.githubusercontent.com/foliojs/pdfkit/master/LICENSE
- docx, README e docs (`docs/usage/document.md`, `page-numbers.md`, `numbering.md`, `tables.md`, `hyperlinks.md`, `packers.md`): https://raw.githubusercontent.com/dolanmiu/docx/master/README.md e https://raw.githubusercontent.com/dolanmiu/docx/master/docs/usage/document.md (os demais no mesmo diretório); LICENSE (MIT): https://raw.githubusercontent.com/dolanmiu/docx/master/LICENSE
- write-excel-file, README e LICENSE (MIT): https://gitlab.com/catamphetamine/write-excel-file/-/raw/main/README.md e https://gitlab.com/catamphetamine/write-excel-file/-/raw/main/LICENSE
- ExcelJS, README: https://raw.githubusercontent.com/exceljs/exceljs/master/README.md
- mdast-util-from-markdown, README: https://raw.githubusercontent.com/syntax-tree/mdast-util-from-markdown/main/readme.md
- mdast-util-gfm, README: https://raw.githubusercontent.com/syntax-tree/mdast-util-gfm/main/readme.md ; mdast (a árvore): https://raw.githubusercontent.com/syntax-tree/mdast/main/readme.md
- CommonMark, especificação: https://raw.githubusercontent.com/commonmark/commonmark-spec/master/spec.txt ; GFM (tabelas): https://raw.githubusercontent.com/github/cmark-gfm/master/test/spec.txt
- Geist, LICENSE.txt e OFL.txt (SIL Open Font License 1.1): https://raw.githubusercontent.com/vercel/geist-font/main/LICENSE.txt e https://raw.githubusercontent.com/vercel/geist-font/main/OFL.txt
- pdf.js (só para os testes), README (Apache-2.0): https://raw.githubusercontent.com/mozilla/pdf.js/master/README.md
- Registro do npm (`npm view <pacote> version license time dependencies`), 24/11/2026.
- Verificação empírica (não é fonte escrita, mas é o que rodou): as fontes Geist 1.9.0 abertas com o fontkit (cobertura de glifos e `OS/2.fsType`), e o renderizador empacotado com o esbuild e rodado de outra pasta.

## Fatos verificados

**PDF**

- **pdfmake** é "PDF document generation library for Node.js and browsers, written in pure JavaScript", com listas numeradas e com marcadores, tabelas (cabeçalho repetido depois de quebra de página), cabeçalho e rodapé dinâmicos "with access to current page number and page count", margens, fontes embutidas, links e metadados (README, 24/11/2026). Licença MIT. Usa o PDFKit por baixo (CHANGELOG 0.3.0: "Reverted to the original `pdfkit` package").
- Versões (npm, 24/11/2026): 0.3.13 (25/10/2026), **0.3.14 (08/11/2026)**, 0.3.15 (20/11/2026). A 0.3.14 depende de `pdfkit ^0.20.2`, `linebreak ^1.1.0` e `xmldoc ^2.0.3`.
- **Segurança, CHANGELOG**: 0.3.6 acrescentou `setUrlAccessPolicy()` ("addresses a potential server vulnerability CVE-2026-26801"); 0.3.8 acrescentou `setLocalAccessPolicy()` no servidor e passou a validar a URL antes de cada redirecionamento; 0.3.12 corrigiu `setLocalAccessPolicy` contornado por imagem dentro de SVG; **0.3.14** mudou o cache de recursos baixados para "per document by default" ("Addresses CVE-2026-119743 in server-side applications that let untrusted users specify resource URLs") e **"Added support for binary font definitions and image dictionary entries using `Buffer`, `Uint8Array` or `ArrayBuffer`"**.
- Código da 0.3.14 (`Printer.js`): o documento do PDFKit é criado com `font: null` (nenhuma fonte padrão do PDF é carregada do disco) e `info` vem de `docDefinition.info` (Title, Author, Subject, Creator, Producer). `base.js` avisa no console quando não há política de URL ou de arquivo local.
- **PDFKit**: embute TrueType, OpenType, WOFF e WOFF2 e aceita a fonte como `Buffer` (docs/text.md, "Fonts"). As 14 fontes padrão do PDF não são embutidas (docs/text.md); elas só cobrem a codificação WinAnsi (não verificado nesta página: ver abaixo).
- Uma alternativa, HTML para PDF pelo Chromium do leitor de páginas (docs/BUSCA.md), depende de um contêiner que nem toda instalação tem.

**DOCX**

- **docx** ("Easily generate and modify .docx files with JS/TS. Works for Node and on the Browser", README): `Document` com `title`, `creator`, `subject`, `description` (docs/usage/document.md); `Footer` com `PageNumber.CURRENT` e `PageNumber.TOTAL_PAGES` (page-numbers.md); listas por `numbering` com `reference`, `level` e `instance` ("a new `instance` value starts a new list", numbering.md); `Table`, `TableRow`, `TableCell` (tables.md); `ExternalHyperlink` (hyperlinks.md); `Packer.toBuffer(doc)` (packers.md). Licença MIT. Versões (npm): 9.15.3 (06/11/2026), 9.15.4 (14/11/2026), 9.16.0 (19/11/2026). Dependências da 9.15.3: `fflate`, `nanoid` (e `@types/node`).

**XLSX**

- **write-excel-file** ("Write `.xlsx` files in a browser or Node.js", README): várias planilhas (`{ sheet, data }`), célula como valor (`string`, `number`, `boolean`, `Date` ou `null`) ou objeto com estilo (`fontWeight: "bold"`, `backgroundColor`, `textColor`, `borderColor`, `align`, `wrap`, `fontFamily`, `fontSize`), `columns` com `width`, `stickyRowsCount` (linhas congeladas), `autoFilter`, `showGridLines`, `toBuffer()` em `write-excel-file/node`. Uma fórmula só é fórmula com `type: 'Formula'` explícito. Licença MIT. Versão 4.1.1 (08/06/2026); única dependência `fflate`. Não escreve `docProps/core.xml` (título, autor): o pacote não tem a opção (README e código publicado).
- **ExcelJS** (MIT, README completo e capaz) tem a última versão estável 4.4.0 publicada em 2024 (npm: `time.modified` 20/12/2024, só um `4.4.1-prerelease.0` depois) e depende de `archiver ^5`, `unzipper ^0.10`, `uuid ^8`, `tmp`, `fast-csv`, `jszip`, `saxes`.

**Entrada (Markdown)**

- `mdast-util-from-markdown`: "Markdown is parsed according to CommonMark" (README, 24/11/2026); devolve uma árvore **mdast** com nós declarados (`heading` com `depth`, `paragraph`, `list` com `ordered` e `start`, `listItem` com `checked`, `table` com `align`, `strong`, `emphasis`, `link` com `url`, `inlineCode`, `code`, `blockquote`, `html`...) (mdast README). Seção "Security": o perigo é virar **HTML**; quem gera HTML precisa sanear.
- `mdast-util-gfm` + `micromark-extension-gfm` acrescentam "autolink literals, footnotes, strikethrough, tables, tasklists" (README). Versões 2.1.0 (03/10/2026), 3.1.0 (10/02/2025) e 3.0.0 (26/06/2023); MIT.
- CommonMark é uma especificação com gramática e exemplos (spec.txt); as tabelas do GFM estão em cmark-gfm `test/spec.txt` ("Tables (extension)").

**Fonte**

- Geist: "licensed under the SIL Open Font License, Version 1.1" (LICENSE.txt e OFL.txt); a OFL diz que as fontes "can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works" e exige o aviso de copyright e a licença junto (OFL.txt).
- Empírico (fontkit, 24/11/2026): Geist 1.9.0 Regular, Bold, Italic e Mono Regular têm todos os glifos de `ãõçéêáíóúàâôüÃÕÇÉÊÁÍÓÚÀÂÔ€–—“”‘’•…ºª·°§¹²³½ñ¿¡ßøæœŁłŞşĞğİıŒ` (Latin-1 e Latin Extended-A); faltam só `✓☐☑`. `OS/2.fsType` não tem restrição de embutir (`noEmbedding: false`, `viewOnly: false`). Cada TTF estático tem de 126 a 149 KB.

## Inferências

- **PDF: pdfmake 0.3.14**, puro JavaScript, no processo. Dá de graça o que um documento bonito precisa (escala tipográfica por estilos, tabela com cabeçalho repetido, listas, rodapé com "página X de Y", metadados) sem desenhar coordenadas à mão como no PDFKit puro. A 0.3.14 é a primeira com fonte em `Uint8Array` e com a correção do cache de URL; a 0.3.15 tem 4 dias e fica para depois. O Chromium do leitor não serve: nem sempre existe.
- **Sem rede e sem disco ao montar**: `setUrlAccessPolicy(() => false)` e `setLocalAccessPolicy(() => false)`, nenhuma imagem no documento, as fontes entregues como bytes. O texto do bot entra só como **texto** (strings), nunca como objeto de definição: não há HTML nem injeção de definição.
- **A fonte vai dentro do código** (base64 num módulo gerado a partir do pacote `geist`), não num arquivo ao lado: o servidor da VPS roda o `dist` e o app embutido roda um único `sidecar.mjs` do esbuild; um `readFileSync` de `.ttf` relativo quebraria no segundo. Quatro estilos do Geist e o Geist Mono são cerca de 660 KB (880 KB em base64): aceitável no servidor. O PDF embute só o subconjunto usado (o PDFKit subsetta).
- **DOCX: docx 9.15.3** (MIT, ativo, poucas dependências). A fonte do Word: a pesquisa inicial propunha Calibri; na implementação a **Geist vai embutida** no DOCX (a `docx` 9.15.3 embute as quatro faces em `word/fonts/*.odttf`, opção `fonts`), para o arquivo nunca depender do que o leitor tem instalado (o LibreOffice abriu o arquivo e usou a Geist embutida). Custa cerca de 330 KB por arquivo. A versão de 06/11 é a mais nova com mais de duas semanas.
- **XLSX: write-excel-file 4.1.1** (MIT, uma dependência, ativo) em vez do ExcelJS (sem versão estável desde 2024 e com dependências velhas). Título e autor entram por um passo pequeno nosso: abrir o ZIP com o `fflate` e acrescentar `docProps/core.xml` (com o tipo no `[Content_Types].xml` e a relação em `_rels/.rels`, inseridos antes da marca de fechamento, comparação exata). Nenhum texto do bot vira fórmula: as células são sempre texto, número ou booleano.
- **Entrada: Markdown (CommonMark + GFM)** para PDF e Word, e **planilhas de linhas** para Excel. O modelo escreve Markdown o tempo todo; é o formato com menos tokens para títulos, listas, negrito, links e tabelas; uma árvore JSON gastaria várias vezes mais caracteres com chaves e aspas para o mesmo texto. O analisador lê uma **gramática fixa** (CommonMark), não classifica nada (docs/REGRAS.md §1: permitido), e o nosso código só percorre os nós declarados da árvore. `html` cru é escrito como texto literal; imagem vira o texto alternativo (sem buscar nada); link só é link se a URL for `http`, `https` ou `mailto` (o `URL` diz o esquema).
- **Testes**: `pdfjs-dist` (Apache-2.0, só em desenvolvimento) para ler o texto e o número de páginas do PDF; `fflate` para abrir DOCX e XLSX e ler o XML.

## O que não foi verificado

- A documentação do pdfmake em `pdfmake.github.io` (bloqueada): as opções (`info`, `footer(currentPage, pageCount)`, `styles`, `ul`/`ol`, `table.layout`) foram conferidas no código publicado da 0.3.14 e no teste que roda, não na página.
- As páginas `spec.commonmark.org` e `github.github.com/gfm` (bloqueadas): li as mesmas especificações pelos arquivos `spec.txt` dos repositórios.
- A cobertura WinAnsi das 14 fontes padrão do PDF não foi relida; não importa, porque não as usamos.
- Como o Word para Mac e o Google Docs mostram a Calibri ausente: não testado (não há esses programas aqui). O DOCX foi aberto pelo XML e, quando havia, pelo LibreOffice.
- A CVE-2026-119743 e a CVE-2026-26801 só foram lidas no CHANGELOG do pdfmake, não no banco de CVEs.

## Implicação para o Suup

Confirma o plano, com um ajuste de lugar: a regra "as ferramentas importam só o core e o zod" (`packages/core/src/architecture.test.ts`) não deixa o pdfmake entrar em `packages/tools`. Então:

- `packages/core/src/documents.ts`: o nome `create_document`, o esquema da entrada e a costura `DocumentMaker` (quem monta).
- `packages/tools/src/create-document.ts`: a ferramenta (risco `read`), ao lado do `send_file`; valida, pede o arquivo à costura e o entrega pelo mesmo `FileSender` (mesmo limite de 25 MB, idempotente por chamada, cartão embaixo da próxima mensagem do bot).
- `packages/documents` (novo): pdfmake 0.3.14, docx 9.15.3, write-excel-file 4.1.1, mdast-util-from-markdown 2.1.0 com GFM; fontes Geist embutidas com a licença OFL ao lado.
- O runtime oferece `create_document` a todo bot que tem `send_file` (inclusive os de antes), e o prompt manda usá-la para PDF, Word e Excel, nunca o terminal nem Python.

## Atualização da implementação (24/11/2026)

### ABNT NBR 14724 (estilo `academico`)

Fontes: resultados de busca na web, 24/11/2026, que citam a NBR 14724:2024 (4ª edição, 16/12/2024, versão corrigida 01/04/2025) e manuais de bibliotecas universitárias: UFRGS (https://www.ufrgs.br/bibeco/apresentacao-grafica/), UFSCar (https://www.bls.ufscar.br/arquivos/apresentacao-geral-dos-trabalhos-academicos.pdf), UNESP Marília (https://www.marilia.unesp.br/Home/Biblioteca/tutorial-word---formatar-texto-2.pdf), FGV (https://sistema.bibliotecas-rj.fgv.br/sites/bibliotecas.fgv.br/files/formatacao_de_trabalho_academico_out_2023.pdf) e UNIP (https://www2.unip.br/presencial/servicos/biblioteca/assets/download/manual_de_normalizacao_abnt_2023.pdf). **Só li os trechos que a busca devolveu; as páginas em si não abriram nesta rede (o proxy bloqueia esses domínios), e a norma da ABNT é paga e não foi lida.**

- **Margens: 3 cm superior e esquerda, 2 cm inferior e direita** (anverso da folha). O "2,5 cm" do pedido não é o valor da norma; usamos 3/2/2/3.
- Texto em **12 pt** (Arial ou Times New Roman são as fontes que os manuais recomendam; nós usamos a Geist embutida, a norma não obriga uma família), **entrelinha 1,5**; citação direta com mais de três linhas, notas de rodapé e referências em espaço simples, citação longa recuada **4 cm** em tamanho menor (10 pt).
- **Recuo de 1,25 cm na primeira linha**: o manual da UNESP diz que a norma não o menciona e sugere o padrão do Word (1,25 cm). É convenção, não exigência literal; aplicamos.
- Número da página no alto, à direita, a partir da segunda folha (a contagem começa na primeira).
- Legenda de figura embaixo, com a fonte ("Figura N: … Fonte: …"): é o pedido do dono; no estilo `academico` uma figura sem fonte é recusada.
- Texto justificado.

Não verificado: se a edição vigente da sua instituição muda algum valor (muitas ainda citam a de 2011); o tamanho exato da legenda (usamos 10 pt).

### O que mudou do plano

- **Excel**: o `write-excel-file` grava a fórmula tal como recebida, e o OOXML guarda `<f>SUM(B2:B9)</f>` **sem o "="** inicial; o Suup tira o "=" antes de gravar e a conferência lê o XML. Não escreve página, filtro nem propriedades: um passo nosso com o `fflate` acrescenta `docProps/core.xml`, `pageMargins`, `pageSetup paperSize="9"` (A4), ajuste à largura e o filtro do cabeçalho. A fonte da planilha é a Calibri (planilha não embute fonte); a Geist só vale em PDF e Word.
- **Conferência do PDF**: `pdfjs-dist` (Apache-2.0) passa a ser dependência de execução, não só de teste. O texto extraído ignora o que está nas margens (o número da página no alto partiria um parágrafo que atravessa a folha). A fonte embutida é conferida por `missingFile` do pdf.js.
- **`geist` não é dependência**: seu peer `next` traria sharp e centenas de linhas a mais no `pnpm-lock.yaml`. O script `packages/documents/scripts/embed-fonts.mjs` lê o pacote desempacotado (`npm pack geist@1.9.0`).
- **Custo em tokens**: a ferramenta soma cerca de 1.000 tokens de definição por requisição de um bot com máquina (esquema de planilha incluído); os limites de tamanho ficam fora do esquema (`documentInputProblems`) para ele ficar curto.
- **Não verificado**: o Word da Microsoft e o Excel da Microsoft (só o LibreOffice abriu os arquivos); as fórmulas saem sem valor guardado, o Excel e o LibreOffice as calculam ao abrir.
