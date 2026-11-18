// spec-drift
// Seed sources of a hard task, embedded as text (generated once from real files that were run).

export const DRIFT_SEED: Record<string, string> = {
  "spec/01-base.md": `# agrupar: especificação base

\`agrupar.py\` totaliza vendas por categoria a partir de um CSV.

## 1. Uso

    python3 agrupar.py [--ordem=nome|total] [--formato=texto|csv|json] [--minimo=N] ARQUIVO

1.1 \`ARQUIVO\` é o caminho de um CSV. O nome \`-\` significa ler da entrada padrão.
1.2 As opções podem vir antes ou depois de \`ARQUIVO\`. Sem \`--formato\`, o formato é \`texto\`.

## 2. Entrada

2.1 O separador é ponto e vírgula (\`;\`). A primeira linha de dados do arquivo é o cabeçalho e deve ser
exatamente \`produto;categoria;qtd;preco\` (depois de tirar os espaços das pontas de cada campo).
2.2 Linhas em branco e linhas que começam com \`#\` são ignoradas, em qualquer posição (inclusive antes do cabeçalho).
Elas contam na numeração das linhas do arquivo (a primeira linha física é a linha 1).
2.3 \`qtd\` é um inteiro maior ou igual a 0. \`preco\` é um decimal com ponto e até 2 casas, maior ou igual a 0
(\`12.5\`, \`3\`, \`0.99\` são válidos).
2.4 Espaços nas pontas de cada campo são ignorados.

## 3. Cálculo

3.1 O valor de uma linha é \`qtd\` vezes \`preco\`, em centavos (um inteiro exato).
3.2 Linhas com a mesma categoria são agrupadas sem distinguir maiúsculas de minúsculas; o nome exibido é o da
primeira ocorrência no arquivo.
3.3 O \`total\` de uma categoria é a soma dos valores das suas linhas; \`itens\` é o número de linhas dela
(não a soma de \`qtd\`).
3.4 Ordem: por padrão, alfabética pelo nome da categoria, sem distinguir maiúsculas de minúsculas.
\`--ordem=nome\` é a mesma coisa. \`--ordem=total\` ordena do maior total para o menor, e o empate se desfaz pelo nome.

## 4. Rodapé

4.1 No formato \`texto\`, depois da tabela, vem uma linha \`TOTAL GERAL: <soma dos totais das categorias exibidas>\`.
4.2 Nos formatos \`csv\` e \`json\` não há rodapé.

## 5. Dinheiro

5.1 Todo total em reais é escrito com vírgula e 2 casas, sem separador de milhar: \`1234,50\`, \`0,99\`, \`0,00\`.
(As exceções, se houver, estão na seção do formato.)
`,
  "spec/02-formatos.md": `# agrupar: formatos de saída

## 2.1 Formato \`texto\` (padrão)

Uma linha por categoria: o nome alinhado à esquerda, preenchido com espaços até a largura do maior nome exibido,
depois DOIS espaços, depois o total (com vírgula, como em 5.1) alinhado à direita, na largura do maior total
exibido. Não sobram espaços no fim das linhas. Exemplo, com \`--ordem=nome\`:

    Frutas    1234,50
    Limpeza     89,90

(depois vem o rodapé, conforme a seção 4 do documento base).

## 2.2 Formato \`csv\`

Primeira linha \`categoria;total;itens\`; depois uma linha por categoria, \`nome;total;itens\`, com o total como em 5.1.
Por exemplo: \`Frutas;1234,50;3\`.

## 2.3 Formato \`json\`

Uma lista JSON de objetos, um por categoria, na ordem da saída:
\`{"categoria": "Frutas", "total": 1234.5, "itens": 3}\`, em que \`total\` é um **número** JSON, em reais.

## 2.4 Opção \`--minimo=N\`

Mantém só as categorias cujo **total**, em reais, é maior ou igual a \`N\` (\`N\` é um decimal com ponto, como
\`100\` ou \`49.9\`). As categorias que ficam seguem a ordem normal e o rodapé considera só as exibidas.
`,
  "spec/03-erros.md": `# agrupar: erros e códigos de saída

Mensagens de erro vão para a saída de erro (stderr); em caso de erro que aborta, nada é escrito na saída padrão.

3.1 Arquivo inexistente: \`erro: arquivo não encontrado: <caminho>\`, código de saída 2.

3.2 Linha de dados inválida (número de campos diferente de 4, \`qtd\` inválida ou \`preco\` inválido): aborta com
\`erro: linha <n>: <motivo>\`, código de saída 3. \`<n>\` é o número da linha física no arquivo (a primeira é a 1) e
\`<motivo>\` é \`número de campos inválido\`, \`qtd inválida\` ou \`preco inválido\`.

3.3 Cabeçalho diferente de \`produto;categoria;qtd;preco\`: \`erro: cabeçalho inválido\`, código de saída 3.
Se o arquivo não tiver cabeçalho nenhum (só linhas ignoradas ou vazio), o erro é o mesmo.

3.4 Opção desconhecida, ou com valor inválido (\`--ordem=x\`, \`--formato=x\`, \`--minimo=abc\`):
\`erro: opção inválida: <a opção como foi digitada>\`, código de saída 64.
Sem \`ARQUIVO\`: \`uso: agrupar.py [--ordem=nome|total] [--formato=texto|csv|json] [--minimo=N] ARQUIVO\`, código 64.

3.5 Arquivo só com o cabeçalho (nenhuma linha de dados): não é erro. A saída não tem categorias e o código é 0.
`,
  "spec/04-emendas.md": `# agrupar: emendas

Estas emendas **prevalecem** sobre o que estiver escrito nos outros documentos. Onde elas não falam,
valem os outros.

**Emenda 1.** Substitui a seção 2.3 de \`02-formatos.md\`: no formato \`json\`, \`total\` deixa de ser um número e
passa a ser uma **string** com ponto e exatamente 2 casas decimais (\`"1234.50"\`, \`"0.99"\`). \`categoria\` e \`itens\`
não mudam.

**Emenda 2.** Substitui a seção 3.2 de \`03-erros.md\`: uma linha de dados inválida **não aborta mais**. Ela é ignorada,
com o aviso \`aviso: linha <n> ignorada: <motivo>\` em stderr (mesmos \`<n>\` e \`<motivo>\` de antes), e o processamento
continua; a saída normal sai completa e o código é 0. Exceção: se houver linhas inválidas e **nenhuma** linha válida,
nada é escrito na saída padrão e o código é 3 (os avisos continuam indo para stderr).

**Emenda 3.** Substitui o último item da seção 3.4 de \`01-base.md\` e a palavra "padrão" dessa seção: a ordem padrão
(sem \`--ordem\`) passa a ser do maior total para o menor, com empate pelo nome. \`--ordem=total\` continua igual e
\`--ordem=nome\` continua alfabética.

**Emenda 4.** Substitui a seção 2.4 de \`02-formatos.md\`: \`--minimo=N\` passa a valer para **itens**, e não para o
total: mantém só as categorias com pelo menos \`N\` itens (\`N\` é um inteiro maior ou igual a 0; qualquer outro valor é
opção inválida, como em 3.4 de \`03-erros.md\`).

**Emenda 5.** Acrescenta à seção 4.1 de \`01-base.md\`: o rodapé do formato \`texto\` passa a ser
\`TOTAL GERAL: <soma> (<n> categorias)\`, em que \`<n>\` é o número de categorias exibidas; com exatamente uma, escreve-se
\`(1 categoria)\`. Com nenhuma, \`(0 categorias)\`.
`,
  "vendas-exemplo.csv": `# vendas de exemplo
produto;categoria;qtd;preco
Maca;Frutas;3;4.5
Pera;frutas;1;10
Sabao;Limpeza;2;3.95
Arroz;Graos;5;12
`,
};

export const DRIFT_REFERENCE = `"""Totaliza vendas por categoria (ver spec/)."""
import json
import re
import sys

USO = "uso: agrupar.py [--ordem=nome|total] [--formato=texto|csv|json] [--minimo=N] ARQUIVO"
CABECALHO = ["produto", "categoria", "qtd", "preco"]
PRECO = re.compile(r"^[0-9]+(\\.[0-9]{1,2})?$")


def reais(centavos):
    return str(centavos // 100) + "," + format(centavos % 100, "02d")


def erro(texto, codigo):
    sys.stderr.write(texto + "\\n")
    return codigo


def preco_em_centavos(texto):
    inteiro, _, frac = texto.partition(".")
    return int(inteiro) * 100 + int((frac + "00")[:2])


def ler_linhas(caminho):
    if caminho == "-":
        return sys.stdin.read().split("\\n")
    with open(caminho, encoding="utf-8") as arquivo:
        return arquivo.read().split("\\n")


def principal(argv):
    ordem, formato, minimo, arquivo = "total", "texto", None, None
    for arg in argv:
        if arg.startswith("--ordem="):
            ordem = arg[8:]
            if ordem not in ("nome", "total"):
                return erro("erro: opção inválida: " + arg, 64)
        elif arg.startswith("--formato="):
            formato = arg[10:]
            if formato not in ("texto", "csv", "json"):
                return erro("erro: opção inválida: " + arg, 64)
        elif arg.startswith("--minimo="):
            valor = arg[9:]
            if not re.fullmatch(r"[0-9]+", valor):
                return erro("erro: opção inválida: " + arg, 64)
            minimo = int(valor)
        elif arg.startswith("-") and arg != "-":
            return erro("erro: opção inválida: " + arg, 64)
        else:
            arquivo = arg
    if arquivo is None:
        return erro(USO, 64)
    try:
        linhas = ler_linhas(arquivo)
    except FileNotFoundError:
        return erro("erro: arquivo não encontrado: " + arquivo, 2)

    cabecalho_visto = False
    grupos = {}
    nomes = {}
    avisos = []
    validas = 0
    invalidas = 0
    for numero, bruta in enumerate(linhas, 1):
        linha = bruta.strip()
        if linha == "" or linha.startswith("#"):
            continue
        campos = [c.strip() for c in linha.split(";")]
        if not cabecalho_visto:
            if campos != CABECALHO:
                return erro("erro: cabeçalho inválido", 3)
            cabecalho_visto = True
            continue
        motivo = None
        if len(campos) != 4:
            motivo = "número de campos inválido"
        elif not re.fullmatch(r"[0-9]+", campos[2]):
            motivo = "qtd inválida"
        elif not PRECO.match(campos[3]):
            motivo = "preco inválido"
        if motivo is not None:
            avisos.append("aviso: linha " + str(numero) + " ignorada: " + motivo)
            invalidas += 1
            continue
        validas += 1
        chave = campos[1].lower()
        nomes.setdefault(chave, campos[1])
        total, itens = grupos.get(chave, (0, 0))
        grupos[chave] = (total + int(campos[2]) * preco_em_centavos(campos[3]), itens + 1)
    if not cabecalho_visto:
        return erro("erro: cabeçalho inválido", 3)
    for aviso in avisos:
        sys.stderr.write(aviso + "\\n")
    if invalidas > 0 and validas == 0:
        return 3

    linhas_saida = [(nomes[c], t, i) for c, (t, i) in grupos.items()]
    if ordem == "nome":
        linhas_saida.sort(key=lambda x: x[0].lower())
    else:
        linhas_saida.sort(key=lambda x: (-x[1], x[0].lower()))
    if minimo is not None:
        linhas_saida = [x for x in linhas_saida if x[2] >= minimo]

    if formato == "json":
        lista = [
            {"categoria": n, "total": str(t // 100) + "." + format(t % 100, "02d"), "itens": i}
            for n, t, i in linhas_saida
        ]
        sys.stdout.write(json.dumps(lista, ensure_ascii=False) + "\\n")
    elif formato == "csv":
        sys.stdout.write("categoria;total;itens\\n")
        for n, t, i in linhas_saida:
            sys.stdout.write(n + ";" + reais(t) + ";" + str(i) + "\\n")
    else:
        largura_nome = max([len(n) for n, _, _ in linhas_saida] or [0])
        largura_total = max([len(reais(t)) for _, t, _ in linhas_saida] or [0])
        for n, t, _ in linhas_saida:
            sys.stdout.write(n.ljust(largura_nome) + "  " + reais(t).rjust(largura_total) + "\\n")
        soma = sum(t for _, t, _ in linhas_saida)
        qtd = len(linhas_saida)
        rotulo = "1 categoria" if qtd == 1 else str(qtd) + " categorias"
        sys.stdout.write("TOTAL GERAL: " + reais(soma) + " (" + rotulo + ")\\n")
    return 0


if __name__ == "__main__":
    sys.exit(principal(sys.argv[1:]))
`;

export const DRIFT_STALE = `"""Totaliza vendas por categoria (ver spec/)."""
import json
import re
import sys

USO = "uso: agrupar.py [--ordem=nome|total] [--formato=texto|csv|json] [--minimo=N] ARQUIVO"
CABECALHO = ["produto", "categoria", "qtd", "preco"]
PRECO = re.compile(r"^[0-9]+(\\.[0-9]{1,2})?$")


def reais(centavos):
    return str(centavos // 100) + "," + format(centavos % 100, "02d")


def erro(texto, codigo):
    sys.stderr.write(texto + "\\n")
    return codigo


def preco_em_centavos(texto):
    inteiro, _, frac = texto.partition(".")
    return int(inteiro) * 100 + int((frac + "00")[:2])


def ler_linhas(caminho):
    if caminho == "-":
        return sys.stdin.read().split("\\n")
    with open(caminho, encoding="utf-8") as arquivo:
        return arquivo.read().split("\\n")


def principal(argv):
    ordem, formato, minimo, arquivo = "nome", "texto", None, None
    for arg in argv:
        if arg.startswith("--ordem="):
            ordem = arg[8:]
            if ordem not in ("nome", "total"):
                return erro("erro: opção inválida: " + arg, 64)
        elif arg.startswith("--formato="):
            formato = arg[10:]
            if formato not in ("texto", "csv", "json"):
                return erro("erro: opção inválida: " + arg, 64)
        elif arg.startswith("--minimo="):
            valor = arg[9:]
            if not re.fullmatch(r"[0-9]+(\\.[0-9]+)?", valor):
                return erro("erro: opção inválida: " + arg, 64)
            minimo = float(valor)
        elif arg.startswith("-") and arg != "-":
            return erro("erro: opção inválida: " + arg, 64)
        else:
            arquivo = arg
    if arquivo is None:
        return erro(USO, 64)
    try:
        linhas = ler_linhas(arquivo)
    except FileNotFoundError:
        return erro("erro: arquivo não encontrado: " + arquivo, 2)

    cabecalho_visto = False
    grupos = {}
    nomes = {}
    avisos = []
    validas = 0
    invalidas = 0
    for numero, bruta in enumerate(linhas, 1):
        linha = bruta.strip()
        if linha == "" or linha.startswith("#"):
            continue
        campos = [c.strip() for c in linha.split(";")]
        if not cabecalho_visto:
            if campos != CABECALHO:
                return erro("erro: cabeçalho inválido", 3)
            cabecalho_visto = True
            continue
        motivo = None
        if len(campos) != 4:
            motivo = "número de campos inválido"
        elif not re.fullmatch(r"[0-9]+", campos[2]):
            motivo = "qtd inválida"
        elif not PRECO.match(campos[3]):
            motivo = "preco inválido"
        if motivo is not None:
            return erro("erro: linha " + str(numero) + ": " + motivo, 3)
        validas += 1
        chave = campos[1].lower()
        nomes.setdefault(chave, campos[1])
        total, itens = grupos.get(chave, (0, 0))
        grupos[chave] = (total + int(campos[2]) * preco_em_centavos(campos[3]), itens + 1)
    if not cabecalho_visto:
        return erro("erro: cabeçalho inválido", 3)
    for aviso in avisos:
        sys.stderr.write(aviso + "\\n")
    if invalidas > 0 and validas == 0:
        return 3

    linhas_saida = [(nomes[c], t, i) for c, (t, i) in grupos.items()]
    if ordem == "nome":
        linhas_saida.sort(key=lambda x: x[0].lower())
    else:
        linhas_saida.sort(key=lambda x: (-x[1], x[0].lower()))
    if minimo is not None:
        linhas_saida = [x for x in linhas_saida if x[1] >= minimo * 100]

    if formato == "json":
        lista = [
            {"categoria": n, "total": t / 100, "itens": i}
            for n, t, i in linhas_saida
        ]
        sys.stdout.write(json.dumps(lista, ensure_ascii=False) + "\\n")
    elif formato == "csv":
        sys.stdout.write("categoria;total;itens\\n")
        for n, t, i in linhas_saida:
            sys.stdout.write(n + ";" + reais(t) + ";" + str(i) + "\\n")
    else:
        largura_nome = max([len(n) for n, _, _ in linhas_saida] or [0])
        largura_total = max([len(reais(t)) for _, t, _ in linhas_saida] or [0])
        for n, t, _ in linhas_saida:
            sys.stdout.write(n.ljust(largura_nome) + "  " + reais(t).rjust(largura_total) + "\\n")
        soma = sum(t for _, t, _ in linhas_saida)
        sys.stdout.write("TOTAL GERAL: " + reais(soma) + "\\n")
    return 0


if __name__ == "__main__":
    sys.exit(principal(sys.argv[1:]))
`;

export const DRIFT_HIDDEN = `import json
import os
import subprocess
import sys
import tempfile

SCRIPT = os.path.abspath("agrupar.py")
CAB = "produto;categoria;qtd;preco\\n"
DADOS = CAB + "Maca;Frutas;3;4.5\\nPera;frutas;1;10\\nSabao;Limpeza;2;3.95\\nDetergente;limpeza;1;2.05\\nBanana;FRUTAS;12;0.99\\nArroz;Graos;5;12\\nFeijao;Graos;0;8\\n"
USO = "uso: agrupar.py [--ordem=nome|total] [--formato=texto|csv|json] [--minimo=N] ARQUIVO"

resultados = {}
contagem = {}
total_de_casos = 0


def rodar(args, arquivos=None, entrada=None):
    with tempfile.TemporaryDirectory() as pasta:
        for nome, texto in (arquivos or {}).items():
            with open(os.path.join(pasta, nome), "w", encoding="utf-8", newline="") as f:
                f.write(texto)
        p = subprocess.run(
            [sys.executable, SCRIPT, *args],
            cwd=pasta,
            input=entrada,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=20,
        )
        return p.returncode, p.stdout, p.stderr


def linhas(texto):
    partes = texto.split("\\n")
    if partes and partes[-1] == "":
        partes.pop()
    return partes


def caso(tag, nome, args, arquivos=None, entrada=None, codigo=0, saida=None, erro=None, tabela=False, json_saida=None, campos=None):
    global total_de_casos
    total_de_casos += 1
    contagem[tag] = contagem.get(tag, 0) + 1
    try:
        c, out, err = rodar(args, arquivos, entrada)
        problemas = []
        if c != codigo:
            problemas.append("código " + str(c) + " em vez de " + str(codigo))
        if saida is not None:
            obtido = linhas(out)
            if tabela and obtido:
                obtido = obtido[:-1]
            if obtido != saida:
                problemas.append("saída " + repr(obtido) + " em vez de " + repr(saida))
        if json_saida is not None:
            try:
                dados = json.loads(out)
                if campos is not None:
                    dados = [{k: d[k] for k in campos} for d in dados]
                if dados != json_saida:
                    problemas.append("json " + repr(dados) + " em vez de " + repr(json_saida))
            except Exception as e:
                problemas.append("json inválido: " + str(e)[:60])
        if erro is not None and linhas(err) != erro:
            problemas.append("stderr " + repr(linhas(err)) + " em vez de " + repr(erro))
    except Exception as e:
        problemas = ["exceção: " + str(e)[:80]]
    lista = resultados.setdefault(tag, [])
    if problemas:
        lista.append(nome + ": " + "; ".join(problemas)[:200])


F = {"v.csv": DADOS}

# --- regras que as emendas não tocam ---
caso("base", "texto alinhado (ordem=nome)", ["--ordem=nome", "v.csv"], F, saida=["Frutas   35,38", "Graos    60,00", "Limpeza   9,95"], tabela=True)
caso("base", "csv ordem=nome", ["--formato=csv", "--ordem=nome", "v.csv"], F, saida=["categoria;total;itens", "Frutas;35,38;3", "Graos;60,00;2", "Limpeza;9,95;2"])
caso("base", "csv ordem=total", ["--formato=csv", "--ordem=total", "v.csv"], F, saida=["categoria;total;itens", "Graos;60,00;2", "Frutas;35,38;3", "Limpeza;9,95;2"])
caso("base", "empate de total desfeito pelo nome", ["--formato=csv", "--ordem=total", "t.csv"], {"t.csv": CAB + "b;b;1;1\\na;A;1;1\\nc;C;1;2\\n"}, saida=["categoria;total;itens", "C;2,00;1", "A;1,00;1", "b;1,00;1"])
caso("base", "agrupa sem distinguir caixa; nome da primeira ocorrência", ["--formato=csv", "--ordem=nome", "c.csv"], {"c.csv": CAB + "x;frutas;1;1\\ny;Frutas;1;1\\nz;FRUTAS;1;1\\n"}, saida=["categoria;total;itens", "frutas;3,00;3"])
caso("base", "itens conta linhas, não unidades", ["--formato=csv", "g.csv"], {"g.csv": CAB + "x;K;100;1\\ny;K;0;1\\n"}, saida=["categoria;total;itens", "K;100,00;2"])
caso("base", "comentários e linhas em branco, inclusive antes do cabeçalho", ["--formato=csv", "k.csv"], {"k.csv": "# registro de março\\n\\n" + CAB + "# meio\\n\\nx;A;1;1\\n"}, saida=["categoria;total;itens", "A;1,00;1"])
caso("base", "lê da entrada padrão com -", ["--formato=csv", "-"], entrada=CAB + "x;A;2;1.5\\n", saida=["categoria;total;itens", "A;3,00;1"])
caso("base", "opções depois do arquivo", ["v.csv", "--formato=csv", "--ordem=nome"], F, saida=["categoria;total;itens", "Frutas;35,38;3", "Graos;60,00;2", "Limpeza;9,95;2"])
caso("base", "espaços nas pontas dos campos", ["--formato=csv", "s.csv"], {"s.csv": " produto ; categoria ; qtd ; preco \\n  x ;  A  ; 2 ; 1.25 \\n"}, saida=["categoria;total;itens", "A;2,50;1"])
caso("base", "preços 3, 0.99 e 12.5", ["--formato=csv", "--ordem=total", "p.csv"], {"p.csv": CAB + "a;P;1;3\\nb;Q;1;0.99\\nc;R;2;12.5\\n"}, saida=["categoria;total;itens", "R;25,00;1", "P;3,00;1", "Q;0,99;1"])
caso("base", "total grande sem separador de milhar", ["--formato=csv", "m.csv"], {"m.csv": CAB + "a;G;1;1234567.89\\n"}, saida=["categoria;total;itens", "G;1234567,89;1"])
caso("base", "arquivo inexistente", ["nao-existe.csv"], codigo=2, saida=[], erro=["erro: arquivo não encontrado: nao-existe.csv"])
caso("base", "cabeçalho inválido", ["h.csv"], {"h.csv": "produto;cat;qtd;preco\\nx;A;1;1\\n"}, codigo=3, saida=[], erro=["erro: cabeçalho inválido"])
caso("base", "sem cabeçalho nenhum", ["e.csv"], {"e.csv": "# só um comentário\\n\\n"}, codigo=3, saida=[], erro=["erro: cabeçalho inválido"])
caso("base", "valor inválido de --ordem", ["--ordem=x", "v.csv"], F, codigo=64, saida=[], erro=["erro: opção inválida: --ordem=x"])
caso("base", "opção desconhecida", ["--foo", "v.csv"], F, codigo=64, saida=[], erro=["erro: opção inválida: --foo"])
caso("base", "valor inválido de --formato", ["--formato=xml", "v.csv"], F, codigo=64, saida=[], erro=["erro: opção inválida: --formato=xml"])
caso("base", "--minimo=abc", ["--minimo=abc", "v.csv"], F, codigo=64, saida=[], erro=["erro: opção inválida: --minimo=abc"])
caso("base", "sem arquivo", ["--formato=csv"], codigo=64, saida=[], erro=[USO])
caso("base", "só o cabeçalho: csv só com a primeira linha", ["--formato=csv", "o.csv"], {"o.csv": CAB}, saida=["categoria;total;itens"])
caso("base", "json: categoria e itens na ordem pedida", ["--formato=json", "--ordem=nome", "v.csv"], F, json_saida=[{"categoria": "Frutas", "itens": 3}, {"categoria": "Graos", "itens": 2}, {"categoria": "Limpeza", "itens": 2}], campos=["categoria", "itens"])

# --- Emenda 1: json com total em string ---
caso("E1", "total como string com 2 casas", ["--formato=json", "--ordem=nome", "v.csv"], F, json_saida=[{"categoria": "Frutas", "total": "35.38", "itens": 3}, {"categoria": "Graos", "total": "60.00", "itens": 2}, {"categoria": "Limpeza", "total": "9.95", "itens": 2}])
caso("E1", "total pequeno e total inteiro", ["--formato=json", "--ordem=nome", "j.csv"], {"j.csv": CAB + "a;A;1;0.05\\nb;B;2;6\\n"}, json_saida=[{"categoria": "A", "total": "0.05", "itens": 1}, {"categoria": "B", "total": "12.00", "itens": 1}])

# --- Emenda 2: linha inválida não aborta ---
RUIM = "# topo\\n" + CAB + "\\nx;A;1;1\\ny;B;um;2\\nz;C;1\\nw;D;1;1,5\\nv;E;2;2\\n"
caso("E2", "linhas inválidas são ignoradas com aviso, numeradas pela linha física", ["--formato=csv", "--ordem=nome", "r.csv"], {"r.csv": RUIM}, saida=["categoria;total;itens", "A;1,00;1", "E;4,00;1"], erro=["aviso: linha 5 ignorada: qtd inválida", "aviso: linha 6 ignorada: número de campos inválido", "aviso: linha 7 ignorada: preco inválido"])
caso("E2", "só linhas inválidas: código 3 e nada na saída", ["--formato=csv", "q.csv"], {"q.csv": CAB + "x;A;-1;1\\ny;B;1;x\\n"}, codigo=3, saida=[], erro=["aviso: linha 2 ignorada: qtd inválida", "aviso: linha 3 ignorada: preco inválido"])
caso("E2", "cabeçalho inválido continua abortando", ["--formato=csv", "z.csv"], {"z.csv": "a;b;c;d\\nx;A;1;1\\n"}, codigo=3, saida=[], erro=["erro: cabeçalho inválido"])

# --- Emenda 3: ordem padrão por total ---
caso("E3", "sem --ordem, do maior total para o menor", ["--formato=csv", "v.csv"], F, saida=["categoria;total;itens", "Graos;60,00;2", "Frutas;35,38;3", "Limpeza;9,95;2"])
caso("E3", "sem --ordem, o menor nome não vem primeiro se o total é menor", ["--formato=csv", "t.csv"], {"t.csv": CAB + "b;b;1;5\\na;A;1;1\\nc;C;1;5\\n"}, saida=["categoria;total;itens", "b;5,00;1", "C;5,00;1", "A;1,00;1"])

# --- Emenda 4: --minimo vale para itens ---
caso("E4", "--minimo=3 mantém só quem tem 3 itens ou mais", ["--formato=csv", "--minimo=3", "v.csv"], F, saida=["categoria;total;itens", "Frutas;35,38;3"])
caso("E4", "--minimo=2 mantém todas aqui, --minimo=4 nenhuma", ["--formato=csv", "--minimo=4", "v.csv"], F, saida=["categoria;total;itens"])
caso("E4", "--minimo=0 mantém todas", ["--formato=csv", "--minimo=0", "--ordem=nome", "v.csv"], F, saida=["categoria;total;itens", "Frutas;35,38;3", "Graos;60,00;2", "Limpeza;9,95;2"])
caso("E4", "--minimo decimal agora é opção inválida", ["--minimo=2.5", "v.csv"], F, codigo=64, saida=[], erro=["erro: opção inválida: --minimo=2.5"])

# --- Emenda 5: rodapé com a contagem ---
caso("E5", "rodapé com 3 categorias", ["v.csv"], F, saida=["Graos    60,00", "Frutas   35,38", "Limpeza   9,95", "TOTAL GERAL: 105,33 (3 categorias)"])
caso("E5", "rodapé no singular", ["u.csv"], {"u.csv": CAB + "a;Uma;1;2\\n"}, saida=["Uma  2,00", "TOTAL GERAL: 2,00 (1 categoria)"])
caso("E5", "rodapé sem categorias", ["o.csv"], {"o.csv": CAB}, saida=["TOTAL GERAL: 0,00 (0 categorias)"])

print(json.dumps({"falhas": {k: v[:4] for k, v in resultados.items()}, "casos": contagem, "total": total_de_casos}))
`;
