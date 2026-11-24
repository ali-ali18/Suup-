# Pesquisa: como os assistentes geram documentos (PDF, Word, Excel)

**Pergunta.** Como os principais assistentes (Claude, ChatGPT, Grok) geram arquivos PDF, Word e Excel: escrevendo código livre (com guias e validações), usando ferramentas ou templates fixos, ou um híbrido? Quais guardas são fixas, e como a saída é verificada antes de ser entregue?

**Motivo.** O Suup tem duas rotas: (A) a ferramenta `create_document`, que monta o arquivo no servidor com um estilo fixo; (B) código livre, em que o bot escreve Python na sandbox (reportlab, python-docx, openpyxl) e envia o arquivo. O dono teme que (A) tire liberdade do bot e cita o Grok como exemplo de geração livre, com guardas só de A4, UTF-8 e margens.

**Data de acesso de todas as fontes:** 24/11/2026. Cada fato traz a marcação **[lido]** (texto lido nesta pesquisa) ou **[não verificado]** (não encontrado ou não lido em fonte primária).

---

## Fontes

Só fontes primárias: documentação oficial, repositórios oficiais e páginas de ajuda oficiais.

| Id | Fonte | URL | Data da fonte |
|---|---|---|---|
| S1 | Anthropic, Agent Skills: visão geral | https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview | não indicada na página |
| S2 | Anthropic, Agent Skills: início rápido (Skills pré-construídas na API) | https://docs.claude.com/en/docs/agents-and-tools/agent-skills/quickstart | não indicada na página |
| S3 | Anthropic, Skill authoring best practices (cópia em markdown) | https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices.md (canônica: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) | não indicada na página |
| S4 | Anthropic, "Introducing Agent Skills" | https://www.anthropic.com/news/skills | página cita atualização de 18/12/2025 |
| S5 | Anthropic, "Claude can now create and edit files" | https://www.anthropic.com/news/create-files | não indicada na página (o texto ainda fala em prévia para planos Max, Team e Enterprise) |
| S6 | Claude Help Center, "Create and edit files with Claude" | https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude | "Updated November 5, 2026" (marcação de data da página) |
| S7 | Anthropic, Code execution tool (API) | https://docs.claude.com/en/docs/agents-and-tools/tool-use/code-execution-tool | não indicada na página |
| S8 | Repositório anthropics/skills, README | https://raw.githubusercontent.com/anthropics/skills/main/README.md | não indicada |
| S9 | anthropics/skills, `skills/pdf/SKILL.md`, `skills/pdf/REFERENCE.md`, `skills/pdf/LICENSE.txt` | https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md (e os outros dois na mesma pasta) | não indicada |
| S10 | anthropics/skills, `skills/docx/SKILL.md`; `skills/docx/scripts/office/validate.py` (cabeçalho lido); `skills/docx/LICENSE.txt` | https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md | não indicada |
| S11 | anthropics/skills, `skills/xlsx/SKILL.md` | https://raw.githubusercontent.com/anthropics/skills/main/skills/xlsx/SKILL.md | não indicada |
| S12 | OpenAI Help, "Data analysis with ChatGPT" | https://help.openai.com/en/articles/8437071-data-analysis-with-chatgpt | não indicada na página |
| S13 | OpenAI API docs, "Code Interpreter" (também em https://platform.openai.com/docs/guides/tools-code-interpreter, mesmo conteúdo) | https://developers.openai.com/api/docs/guides/tools-code-interpreter | não indicada na página |
| S14 | OpenAI Help, "ChatGPT release notes" (entradas citadas abaixo) | https://help.openai.com/en/articles/6825453-chatgpt-release-notes | entradas de 28/05/2026, 09/07/2026 e 16/10/2026 |
| S15 | xAI Docs, "Code Execution" tool | https://docs.x.ai/developers/tools/code-execution (markdown: https://docs.x.ai/developers/tools/code-execution.md) | não indicada na página |
| S16 | xAI Docs, cookbook "Receipts to Spreadsheet" | https://docs.x.ai/cookbook/examples/receipts-to-spreadsheet.md | não indicada |
| S17 | xAI Docs, índice de documentação (llms.txt) | https://docs.x.ai/llms.txt | não indicada |
| S18 | xAI Docs, Grok Build, "Sandbox" (CLI, não é geração de documentos) | https://docs.x.ai/build/features/sandbox.md | não indicada |

---

## Fatos verificados

### 1. Anthropic / Claude

**Produto de arquivos (S6, S5).**

- [lido, S6] "Claude can execute code to create and work with files directly in your conversations."
- [lido, S6] "Claude will generate the file, which you can then download directly from the conversation."
- [lido, S6] Tipos listados: "Excel spreadsheets (.xlsx), PowerPoint presentations (.pptx), Word documents (.docx), and PDF files." Limite de "30MB per file".
- [lido, S6] Rede é configurável pelo plano. Team: "Allow network egress to package managers only (default)". Com a opção desligada: "Claude operates with pre-installed packages only, with no internet access."
- [lido, S6] Não há no artigo descrição de verificação automática do arquivo antes do download.
- [lido, S5] O anúncio diz que a Anthropic deu ao Claude "access to a private computer environment where it can write code and run programs to produce the files and analyses you need." (Texto de lançamento; o artigo de ajuda, S6, é mais recente e descreve a configuração de rede.)

**Sandbox e bibliotecas (S7).**

- [lido, S7] "The container has no internet access, so Claude can't download packages at runtime: only the pre-installed libraries are available."
- [lido, S7] Bibliotecas pré-instaladas citadas, entre outras: openpyxl, xlsxwriter, python-pptx, python-docx, pypdf, pdfplumber, reportlab[pycairo], Img2pdf.
- [lido, S7] Sobre assinatura: "Text files, PDFs, and office documents are not signed because they are not supported formats for signing." (Credenciais C2PA só valem para imagem, vídeo e áudio.)

**Skills (S1, S2, S4).**

- [lido, S1] "Skills can contain three types of content, each loaded at a different time": metadados, instruções (SKILL.md) e recursos/código.
- [lido, S1] Código: "Executable scripts (fill_form.py, validate.py) that Claude runs using bash, providing deterministic operations without loading their code into context."
- [lido, S1] Pré-construídas de documento: "PowerPoint (pptx)", "Excel (xlsx)", "Word (docx)", "PDF (pdf)"; "The pre-built document Skills (PowerPoint, Excel, Word, PDF) are not available in Claude Code."
- [lido, S1] Limites na API: "Skills on the API run in a sandboxed container with no network access and no runtime package installation."
- [lido, S4] "Skills are folders that include instructions, scripts, and resources that Claude can load when needed." E: "Skills can include executable code for tasks where traditional programming is more reliable than token generation."
- [lido, S1] Na API, a Skill roda no container da ferramenta de execução de código: "Using Skills through the API requires the code execution tool, whose container Skills run in." [lido, S2] No início rápido, a chamada leva `container.skills` (com o `skill_id`, por exemplo `pptx`) e `tools` com `code_execution`.

**O que as Skills de documento contêm (S9, S10, S11).**

- **PDF (S9).** Instruções com exemplos de pypdf, pdfplumber e reportlab; um comando de ferramentas de linha (pdftotext, qpdf). Texto sobre um erro conhecido: "**IMPORTANT**: Never use Unicode subscript/superscript characters (...) in ReportLab PDFs. The built-in fonts do not include these glyphs, causing them to render as solid black boxes." [lido] Não há passo de validação do PDF gerado, nem instrução para embutir fontes no reportlab. No `REFERENCE.md` há `pdf-lib` com `embedFont(StandardFonts.Helvetica)` [lido]; se essa chamada embute a fonte no arquivo ou só a referencia, não verificado nesta pesquisa. Licença: o `LICENSE.txt` da pasta começa com "Apache License Version 2.0, January 2004" [lido].
- **DOCX (S10).**
  - Biblioteca: "`docx` is preinstalled — do not run `npm install` first".
  - Armadilhas, como regras de uso e não como guardas: "**Page size defaults to A4.** For US Letter set `page: { size: { width: 12240, height: 15840 } }`"; tabelas com larguras duplas; "Never use `\n`"; lista com marcadores por configuração, não o caractere "•".
  - Verificação: "After writing a `.docx`, render it and look at it:" (converter para PDF com LibreOffice, gerar JPEG com pdftoppm e olhar as imagens).
  - Edição de arquivo existente: `python scripts/office/validate.py out.docx --original doc.docx   # XSD checks`. Cabeçalho do script lido [lido]: valida XML contra os XSD, com `--auto-repair` para alguns problemas.
- **XLSX (S11).**
  - Requisitos: "**Professional font** (Arial, Times New Roman) throughout, unless the user says otherwise."; "**Zero formula errors.** Never ship while `recalc.py` reports `errors_found`"; "Use formulas, never hardcoded results."; "**Follow the user's spec literally.**"
  - Proibições: "Never use `XLOOKUP`, `XMATCH`, `SORT`, `FILTER`, `UNIQUE`, or `SEQUENCE`." (o LibreOffice do ambiente não calcula essas funções).
  - Verificação: `python scripts/recalc.py output.xlsx` (recalcula numa cópia e devolve JSON com `status` e `errors_found`). A própria Skill avisa: "A green recalc proves your formulas *evaluate*, not that they are *right*."
- **Cabeçalho da Skill (S3, boas práticas).** "Match the level of specificity to the task's fragility and variability." Liberdade alta para decisões que dependem do contexto; baixa, com "specific scripts, few or no parameters", quando "Operations are fragile and error-prone" ou "Consistency is critical". Padrão recomendado: "Run validator → fix errors → repeat", e "Only proceed when validation passes".

### 2. OpenAI / ChatGPT

- [lido, S12] "For some data-analysis tasks, ChatGPT writes and runs Python code in a stateful Jupyter notebook environment."
- [lido, S12] "The Python environment used for data analysis cannot make external web requests or API calls."
- [lido, S12] "When ChatGPT uses Python for analysis, review the generated code, outputs, and assumptions before relying on the result." (A verificação, segundo a ajuda, é do usuário.)
- [lido, S13] "The Code Interpreter tool allows models to write and run Python code in a sandboxed environment" e a lista de usos inclui "Generating files with data and images of graphs".
- [lido, S13] "A container is a fully sandboxed virtual machine that the model can run Python code in." Memória configurável, por exemplo `"memory_limit": "4g"`.
- [lido, S13] "Files and images generated by the model are returned as annotations on the assistant's message. `container_file_citation` annotations point to files created in the container." O arquivo é baixado depois pelo endpoint de conteúdo de arquivo do container.
- [lido, S14, entrada de 16/10/2026] Slides, dentro do ChatGPT Work: "On the web, export to PowerPoint, PDF, or Google Slides."
- [lido, S14, entrada de 28/05/2026] "With this update, canvas will no longer be available in GPT-5.5 Instant or GPT-5.5 Thinking. Writing and coding functionality is now supported directly in chat responses through writing blocks and code blocks."
- [lido, S14, entrada de 09/07/2026] "Skills are now generally available" (Enterprise e Edu; a página não descreve o conteúdo de uma Skill).
- [não verificado] Lista de bibliotecas pré-instaladas no código do ChatGPT; guardas fixas de página, fonte ou codificação para PDF e Word; se o ChatGPT gera .docx ou .pdf por código livre ou por ferramenta de exportação (a página de ajuda de análise de dados não descreve isso, e a página de canvas dada como "help.openai.com/.../6567356-canvas" retornou 404).

### 3. xAI / Grok

- [lido, S15] "The code execution tool enables Grok to write and execute Python code in real-time."
- [lido, S15] "Code runs in a sandboxed Python environment with common libraries pre-installed". Citadas: NumPy, Pandas, Matplotlib, SciPy.
- [lido, S15] "File I/O: Limited file system access for security reasons" e "No access to external networks or file systems".
- [lido, S15] A página mostra execução de código para cálculo e análise; não descreve geração de arquivo de saída para o usuário.
- [lido, S16] Exemplo oficial "Receipts to Spreadsheet": o modelo lê recibos com saída estruturada, e a validação é feita com um schema: "`z.toJSONSchema()` turns it into the JSON Schema that the API holds Grok's output to, so the output always parses..." O código da aplicação grava `output/receipts.csv`. Ou seja, no exemplo oficial, o arquivo é escrito pelo código da aplicação, e não pelo modelo.
- [lido, S17] O índice de documentação não lista nenhuma página sobre geração de PDF, Word ou Excel.
- [não verificado] Geração de documentos pelo Grok no app ou na API, e a afirmação do dono de que o Grok "gera tudo na hora com código" e tem como guardas só A4, UTF-8 e margens. As páginas oficiais do x.ai e do help.x.ai não foram acessíveis nesta pesquisa (detalhe em "O que não foi verificado").

### Comparação

| | Claude (Anthropic) | ChatGPT (OpenAI) | Grok (xAI) |
|---|---|---|---|
| Como gera | Código livre do modelo (Python, ou Node com `docx`), num container sem rede, guiado pelas Skills | Código livre do modelo (Python) numa sandbox, com arquivos devolvidos como anotações | Código livre do modelo (Python) numa sandbox; nenhuma geração de arquivo documentada |
| Ferramenta ou template fixo de documento | Não documentada. As Skills são instruções, exemplos e scripts de apoio, mas quem escreve o documento é o modelo | Não documentada nas páginas lidas | Não documentada nas páginas lidas |
| Guardas fixas | Não impostas pela plataforma: estão nos textos das Skills (armadilhas e requisitos, por exemplo "Professional font" no xlsx e fórmulas sem erro). A Skill de docx só avisa que o padrão é A4 | Sem guardas de página, fonte ou codificação documentadas | Sem rede e sem acesso ao sistema de arquivos; bibliotecas pré-instaladas |
| Verificação antes da entrega | Depende de o modelo seguir a Skill: renderizar e olhar (docx), recalcular e zerar erros (xlsx), validar XML (docx). Nenhum passo automático no envio [inferência a partir de S6 e das Skills] | O usuário revisa código e saída (S12). Nenhum passo automático documentado | Não documentada; no exemplo oficial, validação de schema da saída do modelo |

---

## Inferências

Estas conclusões saem dos fatos acima. Não são afirmações das fontes.

1. **O padrão público dos três é código livre numa sandbox, não ferramenta fixa de documento.** Nenhuma das páginas lidas descreve um "create_document" dos fornecedores. A forma mais elaborada é a da Anthropic: código livre, com Skills que trazem instruções, armadilhas e scripts para as partes frágeis.
2. **O híbrido da Anthropic é "livre para o conteúdo, rígido para o que quebra".** A própria Anthropic (S3) manda usar baixa liberdade, com scripts, onde a operação é frágil. Isso sustenta um híbrido, mas o que ela chama de guarda é, na maior parte, texto que o modelo lê e pode ignorar.
3. **As guardas da Anthropic não cobrem o problema que o teste do Suup achou.** A Skill de PDF não manda embutir fontes e usa `reportlab` com fontes padrão nos exemplos (S9). Pelo texto da documentação da PDFKit no ramo `feat/ferramenta-documento` (`docs/pesquisas/ferramenta-de-documento.md`), as 14 fontes padrão do PDF não são embutidas. Para o reportlab, isso não foi verificado nesta pesquisa. Ou seja: copiar a Skill da Anthropic não resolve o achado do teste; é preciso uma regra explícita do Suup.
4. **Verificação por instrução e verificação por código são coisas diferentes.** As Skills da Anthropic mandam validar, mas a validação só acontece se o modelo a executar. Nenhum dos três documenta uma checagem automática feita pelo produto antes da entrega. Para propriedades que se podem conferir por código (fontes embutidas, tamanho de página, codificação, margens), a checagem no envio é a forma mais segura. É uma conclusão de engenharia, não uma prática documentada dos fornecedores.
5. **O temor do dono é parcialmente confirmado.** Os grandes assistentes dão liberdade de código. Mas o padrão deles não é "só guardas de A4 e UTF-8": a liberdade vem junto com instruções, scripts de validação e, no caso da Anthropic, requisitos de conteúdo (fonte, fórmulas sem erro, validação XML).
6. **O teste interno do Suup não é contradito pelas fontes.** A tabela de custo e acerto do teste (6/6 corretas, metade do custo e do tempo, 3 de 4 PDFs sem fontes embutidas) não é comprovada por fonte primária; é dado interno, e os números não foram localizados na documentação do repositório (ver abaixo).

---

## O que não foi verificado

- **Resultado do teste de documentos do Suup.** O dono citou uma seção em `docs/TESTES-REAIS.md` com os números (6/6, metade do custo, 3 de 4 PDFs sem fontes embutidas). Essa seção **não existe** em `docs/TESTES-REAIS.md` nesta checkout (branch `feat/fase-4`). Também não existe no ramo `feat/ferramenta-documento`, cujo commit `b19c2e3` ("comparação da ferramenta de documento contra o script do bot") diz que o resultado iria para `TESTES-REAIS.md` e `MELHORIAS.md`. Nenhum dos dois traz os números. Usei os números só como informação do dono, não como fato verificado.
- **Grok (xAI) e o app Grok.** Nenhuma página oficial sobre geração de documento pelo Grok foi lida. `https://x.ai/news` e `https://x.ai/grok` retornaram 403 (o proxy não permitiu o acesso); `help.x.ai` não respondeu (código 000). A afirmação do dono sobre as guardas do Grok fica **não verificada**.
- **ChatGPT, geração de arquivos no app.** Não foi achada página oficial que descreva a geração de .docx ou .pdf pelo ChatGPT. Não foi achada lista de bibliotecas pré-instaladas no code interpreter. As páginas `help.openai.com/en/articles/9260637-code-interpreter` e `help.openai.com/en/articles/6567356-canvas` retornaram 404.
- **Skills da Anthropic, arquivos não lidos.** A API do GitHub (`api.github.com`) retornou 403 e não foi possível listar a árvore do repositório. Não foram lidos `docx/scripts/` além de `validate.py`, nem `xlsx/scripts/recalc.py`, nem as Skills de pptx. A existência de `xlsx/scripts/recalc.py` é citada pela própria Skill, mas não confirmada. Em https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/docx-js.md e outros caminhos "soltos" tentados, a resposta foi 404.
- **Verificação automática das Skills.** Não foi lido o código dos scripts de validação de xlsx, nem o que `soffice.py` faz exatamente.
- **Reportlab e fontes padrão.** Não foi consultada a documentação oficial do reportlab (host fora da lista desta pesquisa). Por isso o comportamento de fontes padrão no reportlab é **não verificado**.
- **Licenças.** Os `LICENSE.txt` de pdf, docx e xlsx começam com Apache License 2.0 (lido); o texto completo e qualquer NOTICE não foram conferidos. Isto não é parecer jurídico.

---

## Implicação para o Suup

**Contradição com o plano.** A rota planejada (`docs/PLANO.md`, no ramo `feat/ferramenta-documento`: "monta PDF, Word e Excel no processo do servidor (create_document)") é a de ferramenta fixa. As fontes não sustentam essa rota como padrão do setor. Por `docs/pesquisas/README.md`, isso pede decisão do dono antes de código. Esta pesquisa não altera código nem commita nada.

**O que as fontes sustentam.** A ideia de "código livre por padrão, com uma Skill pequena (instruções e um auxiliar com guardas fixas) e verificação automática no `send_file`, deixando `create_document` como atalho" é **compatível com o padrão da Anthropic**, que é código livre, instruções e scripts de validação. As fontes não sustentam "ferramenta fixa como padrão". Também não sustentam "código livre sem guarda", porque nenhum dos três faz isso sem instrução ou validação.

**Ajustes que eu recomendaria à ideia.**

1. **Separar o que é livre do que é fixo.** O conteúdo, o layout e o texto ficam com o bot. Propriedades que se conferem por código (fontes embutidas, tamanho de página, codificação UTF-8, margens, fórmulas sem erro no xlsx) ficam no auxiliar do Suup, e não só no texto da Skill. Isso responde ao temor do dono, porque o bot continua escrevendo o código e escolhendo o desenho.
2. **Verificação no envio, pelo harness.** No `send_file`, o Suup confere o arquivo antes de entregar (fontes embutidas, páginas, codificação, fórmulas com erro). Se falhar, devolve o erro ao bot para corrigir. Isso não depende de o modelo lembrar de validar, e cobre o achado de fontes do teste.
3. **Regra explícita de fonte.** A Skill do Suup deve dizer para embutir fontes (não usar as fontes padrão do PDF) e a verificação deve checar isso. Copiar a Skill da Anthropic não basta, porque ela não traz essa regra.
4. **Manter `create_document` como atalho**, e não como caminho único. Fica o ganho medido de custo e tempo (dado do dono, não verificado no repositório) para documentos padrão, e o bot usa código livre quando o pedido sai do padrão.
5. **Antes de decidir, medir.** Rodar os mesmos quatro casos do teste nas duas rotas (ferramenta, e código livre com auxiliar e verificação no envio) e comparar fontes embutidas, acerto e custo. A pesquisa não substitui esse teste. Os números do teste precisam ser localizados ou refeitos, porque não estão no repositório.
6. **Licença.** Se o Suup for reaproveitar trechos das Skills da Anthropic, o `LICENSE.txt` (Apache 2.0) exige conferência do texto completo antes.

**Pergunta ao dono.** Você quer a ideia "livre por padrão + Skill + verificação no envio + atalho", ou prefere manter a ferramenta fixa como padrão e usar código livre só como exceção? As fontes apoiam a primeira, com a ressalva de que as guardas precisam ser código, não texto. Antes de mudar o plano, confirmar onde estão os números do teste de documentos.
