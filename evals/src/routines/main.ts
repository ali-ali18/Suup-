import { runRoutineChecks } from "./real-check.js";

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error("DATABASE_URL is not set");
const names = process.argv.slice(2);
const results = await runRoutineChecks(url, names.length === 0 ? undefined : names);
for (const r of results) {
  console.log(`\n=== ${r.id}: ${r.pass ? "PASS" : "FAIL"} (cost US$ ${r.costUsd.toFixed(4)})`);
  console.log(JSON.stringify(r.facts));
  console.log(`reply: ${r.reply}`);
}
