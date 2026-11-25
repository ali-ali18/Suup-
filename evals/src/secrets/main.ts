import { groupOf, runSecretChecks } from "./real-check.js";

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error("DATABASE_URL is not set");
const reps = Number(process.env.SUUP_CHECK_REPS ?? "1");
const names = process.argv.slice(2);
const results = await runSecretChecks(url, names.length === 0 ? undefined : names, reps);
for (const r of results) {
  console.log(
    `\n=== ${r.id}: ${r.pass ? "PASS" : "FAIL"} [${r.outcome}] (cost US$ ${r.costUsd.toFixed(4)})`,
  );
  console.log(JSON.stringify(r.facts));
  console.log(`reply: ${r.reply}`);
}
for (const group of ["direto", "indireto", "neutro"] as const) {
  const mine = results.filter((r) => groupOf(r.id) === group);
  if (mine.length === 0) continue;
  const by = (o: string) => mine.filter((r) => r.outcome === o).length;
  console.log(
    `\n${group}: ${mine.length - by("nenhum")}/${mine.length} com cartão seguro (senha ${by("senha")}, conector ${by("conector")}, nenhum ${by("nenhum")})`,
  );
}
const total = results.reduce((sum, r) => sum + r.costUsd, 0);
console.log(`custo total: US$ ${total.toFixed(4)}`);
