import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellJoin, shellQuote } from "../src/index.js";

/** Runs `printf %s <quoted>` in a real sh and returns what the shell made of it. */
function roundTrip(arg: string): string {
  return execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(arg)}`], { encoding: "utf8" });
}

const hostile = [
  "",
  "plain",
  "with space",
  "it's",
  "'",
  "''",
  `'"'"'`,
  '"double"',
  "$(touch /tmp/suup-should-not-exist)",
  "`touch /tmp/suup-should-not-exist`",
  "$HOME $" + "{HOME} $0 $@ $*",
  "a;b && c || d | e > f < g &",
  "line1\nline2\n",
  "tab\there",
  "\\ back\\slash \\' \\n",
  "-rf --no-such-flag -e",
  "*.txt [a-z] ?x {a,b} ~root !!",
  "unicode é 中 \u{1F600}",
  "# not a comment",
  "\r\n",
];

describe("shellQuote", () => {
  for (const arg of hostile) {
    it(`round-trips ${JSON.stringify(arg)} through a real shell`, () => {
      expect(roundTrip(arg)).toBe(arg);
    });
  }

  it("never lets the shell execute embedded commands", () => {
    const marker = `/tmp/suup-quote-test-${process.pid}`;
    const out = execFileSync(
      "/bin/sh",
      [
        "-c",
        `rm -f ${marker}; printf %s ${shellQuote(`$(touch ${marker}); \`touch ${marker}\``)}; test ! -e ${marker} && echo clean`,
      ],
      { encoding: "utf8" },
    );
    expect(out.endsWith("clean\n")).toBe(true);
  });

  it("rejects NUL bytes", () => {
    expect(() => shellQuote("a\0b")).toThrow(/NUL/);
  });

  it("joins arguments as separate words", () => {
    const joined = shellJoin(["a b", "c'd", "$x"]);
    const out = execFileSync("/bin/sh", ["-c", `for a in ${joined}; do printf '[%s]' "$a"; done`], {
      encoding: "utf8",
    });
    expect(out).toBe("[a b][c'd][$x]");
  });
});
