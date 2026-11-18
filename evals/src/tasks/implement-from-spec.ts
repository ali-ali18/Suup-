import { check, result, runPython, statusCheck } from "../kit.js";
import type { EvalTask } from "../types.js";

const SPEC = `# normalizar_telefone

Implemente \`normalizar_telefone(texto)\` em \`telefone.py\`. Aplique as regras nesta ordem:

1. \`texto\` precisa ser \`str\`; qualquer outro tipo levanta \`TypeError\`.
2. Remova todos os caracteres que não sejam dígitos (0 a 9).
3. Se sobrarem 12 ou 13 dígitos e os dois primeiros forem \`55\`, remova esses dois dígitos (código do país). Com 10 ou 11 dígitos nada é removido, mesmo que comecem com 55.
4. Agora devem restar 10 ou 11 dígitos; com qualquer outra quantidade, levante \`ValueError\`.
5. Os dois primeiros dígitos são o DDD e precisam estar entre 11 e 99 (inclusive); senão, \`ValueError\`.
6. Com 11 dígitos (celular), o terceiro dígito precisa ser \`9\`; senão, \`ValueError\`.
7. Formato de saída: com 10 dígitos, \`(DD) NNNN-NNNN\`; com 11 dígitos, \`(DD) 9NNNN-NNNN\`.

Exemplos: veja \`rodar_testes.py\` (\`python3 rodar_testes.py\`). Ele cobre só alguns casos.
`;

const STUB = `def normalizar_telefone(texto):
    """Veja ESPECIFICACAO.md."""
    raise NotImplementedError
`;

const SOLUTION = `import re


def normalizar_telefone(texto):
    """Veja ESPECIFICACAO.md."""
    if not isinstance(texto, str):
        raise TypeError("texto precisa ser str")
    digitos = re.sub(r"[^0-9]", "", texto)
    if len(digitos) in (12, 13) and digitos.startswith("55"):
        digitos = digitos[2:]
    if len(digitos) not in (10, 11):
        raise ValueError("quantidade de dígitos inválida")
    if not 11 <= int(digitos[:2]) <= 99:
        raise ValueError("DDD inválido")
    if len(digitos) == 11:
        if digitos[2] != "9":
            raise ValueError("celular precisa começar com 9")
        return f"({digitos[:2]}) {digitos[2:7]}-{digitos[7:]}"
    return f"({digitos[:2]}) {digitos[2:6]}-{digitos[6:]}"
`;

const RUNNER = `from telefone import normalizar_telefone

# (entrada, saída esperada ou a exceção esperada)
CASOS = [
    ("(11) 98765-4321", "(11) 98765-4321"),
    ("21 3456-7890", "(21) 3456-7890"),
    ("+55 (21) 3456-7890", "(21) 3456-7890"),
    ("3456-7890", ValueError),
    (None, TypeError),
]

falhas = 0
for entrada, esperado in CASOS:
    try:
        obtido = normalizar_telefone(entrada)
    except Exception as erro:  # noqa: BLE001
        obtido = type(erro)
    if obtido != esperado:
        falhas += 1
        print(f"FALHOU: {entrada!r} -> {obtido!r}, esperado {esperado!r}")
print(f"{len(CASOS) - falhas}/{len(CASOS)} casos ok")
raise SystemExit(1 if falhas else 0)
`;

type Hidden = { in: string | number | null; out?: string; err?: "ValueError" | "TypeError" };

/** Cases the visible runner does not have, each one a rule of the specification. */
const HIDDEN: Hidden[] = [
  { in: "5511987654321", out: "(11) 98765-4321" },
  { in: "551134567890", out: "(11) 3456-7890" },
  { in: "55 99999-9999", out: "(55) 99999-9999" },
  { in: "55 11 8765-4321", out: "(11) 8765-4321" },
  { in: "12 3456-7890", out: "(12) 3456-7890" },
  { in: "99 91234-5678", out: "(99) 91234-5678" },
  { in: "(10) 3456-7890", err: "ValueError" },
  { in: "0800 123 4567", err: "ValueError" },
  { in: "11 88765-4321", err: "ValueError" },
  { in: "441134567890", err: "ValueError" },
  { in: "5511887654321", err: "ValueError" },
  { in: "11 3456 7890 ramal 12", err: "ValueError" },
  { in: "123456789", err: "ValueError" },
  { in: "", err: "ValueError" },
  { in: "sem número", err: "ValueError" },
  { in: 11987654321, err: "TypeError" },
];

const HIDDEN_RUNNER = `
import json
from telefone import normalizar_telefone
casos = json.loads(${JSON.stringify(JSON.stringify(HIDDEN))})
erros = []
for caso in casos:
    try:
        obtido = normalizar_telefone(caso["in"])
    except Exception as erro:
        obtido = type(erro).__name__
    esperado = caso.get("out", caso.get("err"))
    if obtido != esperado:
        erros.append(f"{caso['in']!r}: obtido {obtido!r}, esperado {esperado!r}")
print(json.dumps(erros[:5], ensure_ascii=False))
raise SystemExit(1 if erros else 0)
`;

/** Implement a function from a written specification; the verifier runs extra cases. */
export const implementFromSpec: EvalTask = {
  id: "implement-from-spec",
  title: "Implementar uma função a partir de uma especificação escrita",
  category: "code",
  objective:
    "Implemente a função normalizar_telefone em telefone.py seguindo exatamente a especificação em ESPECIFICACAO.md. " +
    "Use `python3 rodar_testes.py` para conferir, lembrando que ele cobre só alguns dos casos da especificação.",
  criteria: [
    "rodar_testes.py passa em todos os casos.",
    "A função segue todas as regras de ESPECIFICACAO.md, inclusive as que o rodar_testes.py não cobre.",
  ],
  limits: { maxTurns: 16, maxCostUsd: 0.6, maxDurationMs: 300_000 },
  expect: { status: "done" },
  async setup(ws) {
    await ws.writeFile("ESPECIFICACAO.md", SPEC);
    await ws.writeFile("telefone.py", STUB);
    await ws.writeFile("rodar_testes.py", RUNNER);
  },
  async reference(ws) {
    await ws.writeFile("telefone.py", SOLUTION);
  },
  async verify(ctx) {
    const visible = await ctx.ws.exec("python3 rodar_testes.py 2>&1", { timeoutMs: 60_000 });
    const hidden = await runPython(ctx.ws, HIDDEN_RUNNER);
    return result([
      statusCheck(ctx, "done"),
      check("os casos visíveis passam", visible.exitCode === 0, visible.stdout.trim().slice(-300)),
      check(
        `os ${HIDDEN.length} casos ocultos da especificação passam`,
        hidden.exitCode === 0,
        (hidden.stdout.trim() || hidden.stderr.trim()).slice(0, 500),
      ),
    ]);
  },
};
