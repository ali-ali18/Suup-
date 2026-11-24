# Pesquisa: o bot entrega arquivos no chat, e a máquina dos bots faz documentos

Data da pesquisa: 24/11/2026. Valida os itens do dono de 24/11/2026: "Ele tinha que me mandar o doc aqui no chat" (o bot fez `/workspace/pesquisa/historia_biblioteca.pdf` e só escreveu o caminho) e "sh: pip: not found" (a máquina não tinha `pip` nem `reportlab`). Ver [CONFIGURACAO.md](../CONFIGURACAO.md) ("O que a máquina tem") e [API.md](../API.md) (`GET /v1/files/:id`).

## Pergunta

Como guardar um arquivo que o bot fez na máquina dele de um jeito durável no app embutido e na VPS (e coberto pelo backup que já existe); como dizer o tipo de um arquivo sem padrão de texto (docs/REGRAS.md §1); como o app de desktop (Tauri 2) salva com a janela do sistema e abre com o programa do sistema; como o navegador baixa com o nome certo; e o que a imagem Debian precisa para `pip` funcionar?

## Fontes

Lidas em 24/11/2026 com `curl` (raw.githubusercontent.com). As páginas `peps.python.org`, `packages.debian.org`, `rfc-editor.org` e `crates.io` não abriram nesta rede (bloqueadas pelo proxy).

- PostgreSQL, documentação, `doc/src/sgml/datatype.sgml` (tipo `bytea`), ramo `master`: https://raw.githubusercontent.com/postgres/postgres/master/doc/src/sgml/datatype.sgml
- WHATWG, MIME Sniffing Standard, fonte `mimesniff.bs`: https://raw.githubusercontent.com/whatwg/mimesniff/main/mimesniff.bs
- Tauri 2, plugin de diálogo: https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/plugin/dialog.mdx e o código `plugins/dialog/src/lib.rs`: https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/dialog/src/lib.rs
- Tauri 2, plugin `opener`: https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/plugin/opener.mdx
- Tauri 2, "Calling Rust from the frontend" (corpo cru de um comando): https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/develop/calling-rust.mdx
- PEP 668, "Marking Python base environments as externally managed": https://raw.githubusercontent.com/python/peps/main/peps/pep-0668.rst
- pip, "Configuration": https://raw.githubusercontent.com/pypa/pip/main/docs/html/topics/configuration.md
- Verificação empírica (não é fonte escrita, mas é o que rodou): a imagem `docker/sandbox` construída com `BASE_IMAGE=ubuntu:24.04` (os espelhos do Debian são bloqueados nesta rede, docs/IMPLANTACAO.md) e `packages/sandbox/test/egress-pip.test.ts` com o proxy de saída real e o PyPI real.

## Fatos verificados

- **bytea** guarda sequências de bytes arbitrários, inclusive zero e não imprimíveis (datatype.sgml, seção "Binary Data Types", 24/11/2026). Um valor longo vai para fora da linha (TOAST) e o `pg_dump` o leva junto: o backup do banco (docs/IMPLANTACAO.md, `pg_dump`) já cobre o que estiver numa tabela. *(A parte do `pg_dump` vem do comportamento conhecido do `pg_dump`, que copia todas as tabelas; não reli a página dele: ver "não verificado".)*
- **Assinaturas de tipo** (mimesniff.bs, "Matching an image type pattern" e "Matching an archive type pattern", 24/11/2026): PNG começa com `89 50 4E 47 0D 0A 1A 0A`; ZIP com `50 4B 03 04`; PDF com `25 50 44 46 2D` ("%PDF-"); a norma também lista GIF, JPEG, WebP (RIFF....WEBP), MP3, OGG, MP4, gzip e RAR por bytes fixos no começo. O algoritmo compara **bytes exatos** (com máscara), não texto.
- **Diálogo de salvar em Rust** (dialog.mdx e lib.rs, 24/11/2026): `app.dialog().file().set_file_name(nome).blocking_save_file()` devolve `Option<FilePath>`; `None` quando a pessoa fecha a janela. A versão `blocking_` não pode rodar na thread principal (a documentação manda usar a versão com callback ou rodar fora dela; um comando `async` do Tauri roda fora).
- **Abrir com o programa do sistema** (opener.mdx, 24/11/2026): `app.opener().open_path(caminho, None::<&str>)` abre com o programa padrão; `reveal_item_in_dir` mostra no gerenciador de arquivos. O app já usa o `opener` (para links).
- **Corpo cru num comando** (calling-rust.mdx, 24/11/2026): `tauri::ipc::Request` dá o corpo (`InvokeBody::Raw`) e os cabeçalhos; do JavaScript, `invoke(nome, Uint8Array, { headers })`.
- **PEP 668** (pep-0668.rst, 24/11/2026): um Python de distribuição marca o ambiente como "externally managed" (arquivo `EXTERNALLY-MANAGED`); o `pip` então recusa instalar, inclusive `pip install --user`, a menos que se passe `--break-system-packages` (ou a configuração equivalente). O Debian 12 e o Ubuntu 24.04 trazem o arquivo.
- **pip.conf** (configuration.md, 24/11/2026): o arquivo global do Linux é `/etc/pip.conf` (seção `[global]`); toda opção de linha de comando pode ir nele pelo nome longo (`break-system-packages = true`, `user = true`).
- **Empírico** (24/11/2026): com `python3-pip`, `python3-venv`, `python3-reportlab`, `python3-docx`, `python3-openpyxl` e `file`, a imagem gera um PDF que `file -b --mime-type` chama de `application/pdf`; `pip install tabulate` pelo proxy de saída do Suup (lista só com `pypi.org` e `files.pythonhosted.org`) instala em `/home/bot/.local/`; um índice fora da lista é recusado e o resultado do comando diz `request_network_access`. O `pandoc` do Ubuntu 24.04 ocupa 190 MB (`du -sh /usr/bin/pandoc`); a imagem foi de 290 MB para 726 MB com ele e para 486 MB sem ele. `pip install pypandoc_binary` dá o `pandoc` quando preciso.

## Inferências

- Guardar o arquivo **no banco** (`bytea`, até 25 MB) é a opção mais simples e durável para os dois modos: o app embutido e a VPS usam o mesmo Postgres, o backup que já existe (dump do banco) leva os arquivos, não há pasta nova a montar, copiar ou limpar, e a autorização do download é a mesma da API. O custo (banco maior) é aceitável no tamanho de um assistente pessoal; uma pasta de dados seria uma segunda coisa para o backup.
- O **tipo** do arquivo sai por estrutura: primeiro os bytes iniciais comparados com assinaturas fixas (tabela de bytes, igualdade exata), depois a extensão do nome numa tabela (igualdade exata da extensão em minúsculas). Um ZIP é desambiguado pela extensão (`.docx`, `.xlsx`, `.pptx` são ZIP). Nada de regex.
- O download no Tauri fica **em Rust**, como todo pedido do app (o `http_fetch` já só fala com o servidor configurado): o comando baixa o arquivo e salva onde a pessoa escolheu (diálogo) ou numa pasta do app e abre com o programa do sistema. Assim 25 MB não atravessam a ponte JavaScript/Rust.
- No navegador, o `fetch` com o token traz o arquivo e um `<a download>` com um `blob:` o salva com o nome certo. "Abrir" num `blob:` do mesmo endereço do app executaria HTML do bot no app: no navegador só há "Baixar".
- A resposta do servidor leva `Content-Disposition: attachment` (nunca `inline`), `X-Content-Type-Options: nosniff` e uma CSP `sandbox`, para que um HTML ou SVG do bot nunca rode na origem do servidor.
- O `pip` da imagem: `/etc/pip.conf` com `break-system-packages = true` e `user = true` faz o `pip install` comum funcionar e instalar em `~/.local` (no volume, dono `bot`), sem tocar nos pacotes do sistema. É exatamente o risco que a PEP 668 quer evitar (quebrar o Python do sistema) que a instalação no usuário evita.

## O que não foi verificado

- Os nomes dos pacotes no **Debian 12** (o padrão da imagem): `packages.debian.org` e os espelhos do Debian não abriram nesta rede; a imagem foi construída e testada com `BASE_IMAGE=ubuntu:24.04`, que tem os mesmos nomes. O CI constrói a imagem Debian e acusa um nome que falte.
- RFC 6266 (`Content-Disposition`) e RFC 8187 (`filename*=UTF-8''...`): `rfc-editor.org` bloqueado. O cabeçalho segue a forma conhecida (`attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>`), testada só pelo navegador do Playwright (Chromium).
- A página do `pg_dump` não foi relida.
- O diálogo nativo de salvar e o `open_path` não foram exercitados de verdade (não há janela nesta máquina): o código compila (`cargo check`) e o Playwright cobre o caminho do navegador.

## Implicação para o Suup

- Ferramenta `send_file` (risco `read`: o arquivo vai para o chat do próprio dono, no servidor dele), tabela `files` (migração 0030) com o conteúdo em `bytea`, a mensagem do bot leva `attachments`, `GET /v1/files/:id` com autenticação e `Content-Disposition`, e o cartão de arquivo no chat ("Abrir" e "Salvar" no app; "Baixar" no navegador).
- Imagem da máquina: `python3-pip`, `python3-venv`, `python3-reportlab`, `python3-docx`, `python3-openpyxl`, `file` e o `/etc/pip.conf`; **sem** `pandoc` (tamanho), com o caminho do `pypandoc_binary` documentado.
