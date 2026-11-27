// Owns the small, deterministic folders the chat-task cases point at (KOD-68). They exist so a bot
// that looks before it decides finds real work there (a project with failing tests, forty CSV
// files), never so it can finish it: the cases measure where the work goes, not the work.

export type Files = Record<string, string>;

/** Joins seed folders under a prefix of their own. */
export function under(prefix: string, files: Files): Files {
  return Object.fromEntries(
    Object.entries(files).map(([path, body]) => [`${prefix}/${path}`, body]),
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Forty sales CSV files; a few rows carry a negative value or an impossible date. */
export function sales(count = 40): Files {
  const files: Files = {};
  for (let f = 1; f <= count; f++) {
    const rows = ["data,cliente,produto,valor"];
    for (let r = 1; r <= 15; r++) {
      const day = (f * 7 + r) % 28 || 28;
      const bad = (f * 13 + r) % 37;
      const date =
        bad === 0 ? `2026-02-${30 + (r % 2)}` : `2026-${pad2((f % 12) + 1)}-${pad2(day)}`;
      const value = bad === 5 ? -((f * r) % 90) - 1 : ((f * 31 + r * 17) % 900) + 10;
      rows.push(`${date},Cliente ${(f * r) % 23},Produto ${(f + r) % 11},${value}`);
    }
    files[`vendas/vendas-${pad2(f)}.csv`] = `${rows.join("\n")}\n`;
  }
  return files;
}

/** Thirty access logs with 500s spread over a few endpoints. */
export function logs(count = 30): Files {
  const endpoints = ["/api/pedidos", "/api/clientes", "/api/estoque", "/api/login", "/api/frete"];
  const files: Files = {};
  for (let f = 1; f <= count; f++) {
    const lines: string[] = [];
    for (let l = 0; l < 40; l++) {
      const code = (f * 7 + l * 3) % 17 === 0 ? 500 : (f + l) % 9 === 0 ? 404 : 200;
      const ep = endpoints[(f + l) % endpoints.length];
      lines.push(
        `2026-11-${pad2(((f + l) % 7) + 14)}T${pad2(l % 24)}:${pad2((f * l) % 60)}:00Z GET ${ep} ${code} ${(l * 37) % 900}ms`,
      );
    }
    files[`logs/app-${pad2(f)}.log`] = `${lines.join("\n")}\n`;
  }
  return files;
}

/** A small Node project whose tests fail on two bugs. */
export function failingProject(): Files {
  return {
    "package.json": `${JSON.stringify({ name: "loja", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    "src/preco.js":
      "export function comDesconto(preco, pct) {\n  return preco - preco * pct;\n}\n\nexport function frete(peso) {\n  if (peso > 10) return 30;\n  return 15;\n}\n",
    "src/carrinho.js":
      "export function total(itens) {\n  let soma = 0;\n  for (let i = 1; i < itens.length; i++) soma += itens[i].preco * itens[i].qtd;\n  return soma;\n}\n",
    "test/preco.test.js":
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { comDesconto, frete } from "../src/preco.js";\n\ntest("10% de desconto", () => assert.equal(comDesconto(200, 10), 180));\ntest("frete de 10 kg", () => assert.equal(frete(10), 30));\n',
    "test/carrinho.test.js":
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { total } from "../src/carrinho.js";\n\ntest("soma todos os itens", () => assert.equal(total([{ preco: 5, qtd: 2 }, { preco: 3, qtd: 1 }]), 13));\n',
  };
}

/** Source files written with callbacks, with a test, for a refactor. */
export function callbackProject(): Files {
  const files: Files = {
    "package.json": `${JSON.stringify({ name: "relatorios", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  };
  for (const name of ["clientes", "pedidos", "estoque", "notas", "frete", "usuarios"]) {
    files[`src/${name}.js`] =
      `import fs from "node:fs";\n\nexport function ler${name}(caminho, pronto) {\n  fs.readFile(caminho, "utf8", (erro, texto) => {\n    if (erro) return pronto(erro);\n    pronto(null, texto.split("\\n").filter(Boolean));\n  });\n}\n`;
  }
  files["test/clientes.test.js"] =
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { lerclientes } from "../src/clientes.js";\n\ntest("lê linhas", (_, done) => {\n  lerclientes(new URL("../package.json", import.meta.url), (erro, linhas) => {\n    assert.equal(erro, null);\n    assert.ok(linhas.length > 0);\n    done();\n  });\n});\n';
  return files;
}

/** Twelve small modules, only two with tests. */
export function untestedFunctions(): Files {
  const files: Files = {
    "package.json": `${JSON.stringify({ name: "util", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  };
  const bodies = [
    [
      "cpf",
      "export function soDigitos(t) {\n  return [...String(t)].filter((c) => c >= '0' && c <= '9').join('');\n}\n",
    ],
    ["moeda", "export function reais(n) {\n  return `R$ ${n.toFixed(2).replace('.', ',')}`;\n}\n"],
    ["datas", "export function diasEntre(a, b) {\n  return Math.round((b - a) / 86400000);\n}\n"],
    ["texto", "export function titulo(t) {\n  return t.charAt(0).toUpperCase() + t.slice(1);\n}\n"],
    ["listas", "export function unicos(l) {\n  return [...new Set(l)];\n}\n"],
    [
      "numeros",
      "export function media(l) {\n  return l.reduce((a, b) => a + b, 0) / l.length;\n}\n",
    ],
    [
      "frete",
      "export function faixa(kg) {\n  return kg <= 1 ? 'leve' : kg <= 10 ? 'medio' : 'pesado';\n}\n",
    ],
    [
      "estoque",
      "export function falta(atual, minimo) {\n  return Math.max(0, minimo - atual);\n}\n",
    ],
    [
      "cep",
      "export function formatarCep(c) {\n  const d = String(c).padStart(8, '0');\n  return `${d.slice(0, 5)}-${d.slice(5)}`;\n}\n",
    ],
    ["telefone", "export function ddd(t) {\n  return String(t).slice(0, 2);\n}\n"],
    [
      "pedido",
      "export function status(p) {\n  return p.pago ? (p.enviado ? 'enviado' : 'pago') : 'aberto';\n}\n",
    ],
    ["desconto", "export function aplicar(preco, pct) {\n  return preco * (1 - pct / 100);\n}\n"],
  ];
  for (const [name, body] of bodies) files[`src/${name}.js`] = body as string;
  files["test/cpf.test.js"] =
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { soDigitos } from "../src/cpf.js";\n\ntest("tira pontos", () => assert.equal(soDigitos("123.456"), "123456"));\n';
  files["test/moeda.test.js"] =
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { reais } from "../src/moeda.js";\n\ntest("vírgula", () => assert.equal(reais(2.5), "R$ 2,50"));\n';
  return files;
}

/** Thirty Markdown pages that link to each other. */
export function markdownDocs(count = 30): Files {
  const files: Files = {};
  for (let i = 1; i <= count; i++) {
    const next = (i % count) + 1;
    files[`docs/pagina-${pad2(i)}.md`] =
      `# Página ${i}\n\nTexto da página ${i} sobre o processo ${i % 6}.\n\n- Veja também [a página ${next}](pagina-${pad2(next)}.md)\n- Volte ao [início](pagina-01.md)\n`;
  }
  return files;
}

/** Twenty-five order files and the rules they must follow. */
export function orders(count = 25): Files {
  const files: Files = {
    "regras.md":
      "# Regras dos pedidos\n\n1. `id` é obrigatório e único.\n2. `itens` tem pelo menos um item, cada um com `sku` e `qtd` > 0.\n3. `total` é a soma de `qtd * preco` dos itens (tolerância de 1 centavo).\n4. `cep` tem 8 dígitos.\n",
  };
  for (let i = 1; i <= count; i++) {
    const itens = [
      { sku: `SKU-${i}`, qtd: i % 7 === 0 ? 0 : (i % 3) + 1, preco: 10 + i },
      { sku: `SKU-${i + 50}`, qtd: 1, preco: 5 },
    ];
    const total = itens.reduce((s, it) => s + it.qtd * it.preco, 0) + (i % 5 === 0 ? 3 : 0);
    files[`pedidos/pedido-${pad2(i)}.json`] = `${JSON.stringify(
      {
        id: i % 11 === 0 ? i - 1 : i,
        cep: i % 4 === 0 ? "1234" : `8${String(1000000 + i)}`,
        itens,
        total,
      },
      null,
      2,
    )}\n`;
  }
  return files;
}

/** Six monthly stock sheets with drops and price changes. */
export function stockSheets(): Files {
  const months = ["jan", "fev", "mar", "abr", "mai", "jun"];
  const files: Files = {};
  months.forEach((month, m) => {
    const rows = ["sku,produto,quantidade,preco"];
    for (let p = 1; p <= 80; p++) {
      if ((p + m) % 19 === 0) continue;
      const price = 10 + p + ((p * (m + 1)) % 9 === 0 ? p * 0.15 : 0);
      rows.push(`P${pad2(p)},Produto ${p},${(p * 7 + m * 3) % 120},${price.toFixed(2)}`);
    }
    files[`estoque-${month}.csv`] = `${rows.join("\n")}\n`;
  });
  return files;
}

export const smallConfig: Files = {
  "config.json": `${JSON.stringify({ app: "painel", porta: 8087, debug: false }, null, 2)}\n`,
};

export const smallPackage: Files = {
  "package.json": `${JSON.stringify({ name: "painel", devDependencies: { typescript: "5.9.3", vitest: "4.0.8" } }, null, 2)}\n`,
};

export function clientsCsv(): Files {
  const rows = ["nome,cidade"];
  for (let i = 1; i <= 57; i++) rows.push(`Cliente ${i},Cidade ${i % 9}`);
  return { "clientes.csv": `${rows.join("\n")}\n` };
}
