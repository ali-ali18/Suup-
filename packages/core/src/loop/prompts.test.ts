import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  buildSystemPromptParts,
  formatClock,
  MEMORY_TOOL_NAMES,
  type RunPromptContext,
  renderStateReminder,
} from "./prompts.js";

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe("system prompt", () => {
  const prompt = buildSystemPrompt({ name: "Ada", personality: "Dry and precise." });

  it("is short enough to be followed", () => {
    expect(words(buildSystemPrompt({ name: "Ada", personality: "" }))).toBeLessThanOrEqual(600);
  });

  it("carries the bot's identity and the harness rules", () => {
    expect(prompt).toContain("You are Ada, one of the bots on the user's personal team in Suup");
    expect(prompt).toContain("Dry and precise.");
    expect(prompt).toContain("language the user writes in");
    for (const needle of ["`plan`", "`finish`", "`escalate`", "STATE REMINDER", "EXTERNAL_DATA"]) {
      expect(prompt).toContain(needle);
    }
  });
});

describe("system prompt and memory tools", () => {
  const bot = { name: "Ada", personality: "" };

  it("describes the memory tools by default", () => {
    expect(buildSystemPrompt(bot)).toContain("`remember`");
  });

  it("tells the bot to save durable facts about the user by itself and silently", () => {
    const prompt = buildSystemPrompt(bot);
    expect(prompt).toContain("save it yourself");
    expect(prompt).toContain("silently: do not tell the user you saved it");
    expect(prompt).not.toContain("say briefly that you saved it");
    expect(prompt).not.toContain("say that you saved");
    expect(prompt).toContain("Never save trivia or secrets");
  });

  it("never saves the things Claude's memory never saves either", () => {
    const prompt = buildSystemPrompt(bot);
    expect(prompt).toContain(
      "never save government ID numbers, criminal history, bank or financial account numbers or immigration status",
    );
  });

  it("leaves the memory line out for a bot that is not offered any memory tool", () => {
    const prompt = buildSystemPrompt(bot, undefined, { memoryTools: false });
    for (const name of MEMORY_TOOL_NAMES) expect(prompt).not.toContain(`\`${name}\``);
    expect(prompt).not.toMatch(/Memory:/);
    expect(prompt).toContain("Never claim to have done something");
  });
});

describe("state reminder", () => {
  it("lists objective, numbered criteria, plan and open steps", () => {
    const text = renderStateReminder({
      objective: "Ship it",
      acceptanceCriteria: ["tests green", "docs"],
      plan: [
        { id: "a", title: "Build", status: "done" },
        { id: "b", title: "Test", status: "in_progress", note: "flaky" },
      ],
    });
    expect(text).toContain("Ship it");
    expect(text).toContain("1. tests green\n2. docs");
    expect(text).toContain("[done] a: Build");
    expect(text).toContain("[in_progress] b: Test (flaky)");
    expect(text).toContain("1 step(s) still open: b");
  });
});

const base: RunPromptContext = { rules: [], profile: [] };
const NOW = { iso: "2026-11-21T17:32:00.000Z", timeZone: "America/Sao_Paulo" };

describe("system prompt: the order of the blocks", () => {
  it("reads how you work, the harness, tools and data, then who you are, now, team, what you have, rules, profile, in that order", () => {
    const prompt = buildSystemPrompt(
      { name: "Ada", personality: "Dry." },
      {
        rules: [{ text: "Always short." }],
        profile: [{ text: "Lives in Recife." }],
        now: NOW,
        team: [{ name: "Finanças", description: "Cuida do dinheiro." }],
        machine: { terminal: true, files: true, isolated: true },
        connectors: ["gmail"],
      },
      { returns: true },
    );
    const heads = [
      "## How you work",
      "## Messages from the harness",
      "## Tools and data",
      "## Who you are",
      "## Now",
      "## Your team",
      "## What you have",
      "## Standing rules from the user",
      "## What you know about the user",
    ];
    const at = heads.map((h) => prompt.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(prompt.startsWith("## How you work")).toBe(true);
    expect(prompt.indexOf("Dry.")).toBeGreaterThan(at[3] as number);
    expect(prompt.indexOf("Dry.")).toBeLessThan(at[4] as number);
  });

  it("starts with a long part that is byte-identical across bots and runs (the prompt cache prefix)", () => {
    const options = { returns: true, approvals: true, secrets: true, routines: true };
    const ada = buildSystemPromptParts(
      { name: "Ada", personality: "Dry." },
      {
        rules: [{ text: "Always short." }],
        profile: [{ text: "Lives in Recife." }],
        now: NOW,
        team: [{ name: "Finanças", description: "Cuida do dinheiro." }],
        secrets: [{ name: "GITHUB_TOKEN", description: "" }],
      },
      options,
    );
    const bia = buildSystemPromptParts(
      { name: "Bia", personality: "Warm and chatty." },
      {
        rules: [],
        profile: [{ text: "Has a cat." }],
        now: { ...NOW, iso: "2027-03-02T08:15:00.000Z" },
      },
      options,
    );
    expect(ada.stableLength).toBe(bia.stableLength);
    expect(ada.stableLength).toBeGreaterThan(2500);
    const prefix = ada.text.slice(0, ada.stableLength);
    expect(bia.text.slice(0, bia.stableLength)).toBe(prefix);
    // Nothing of the bot or the run is in it; all of that comes after.
    for (const own of [
      "Ada",
      "Dry.",
      "Always short.",
      "Recife",
      "Finanças",
      "GITHUB_TOKEN",
      "2026",
    ]) {
      expect(prefix, own).not.toContain(own);
      expect(ada.text.slice(ada.stableLength), own).toContain(own);
    }
    expect(ada.text.slice(ada.stableLength).startsWith("## Who you are")).toBe(true);
    // The same text as before, only in another order.
    expect(buildSystemPrompt({ name: "Ada", personality: "Dry." }, base, options)).toBe(
      buildSystemPromptParts({ name: "Ada", personality: "Dry." }, base, options).text,
    );
  });
});

describe("system prompt: now", () => {
  it("says the weekday, the date, the time and the time zone of the run start", () => {
    const prompt = buildSystemPrompt({ name: "Ada", personality: "" }, { ...base, now: NOW });
    expect(prompt).toContain(
      "## Now\n\nIt is Saturday 2026-11-21, 14:32 (America/Sao_Paulo, GMT-3), in the user's time zone. That is when this run started: the STATE REMINDER at the end of each user turn gives the current time. Use this time zone for every date and time you say, schedule or compare, unless the user says otherwise.",
    );
  });

  it("has no clock block when the run recorded none (an old recording, an evaluation)", () => {
    expect(buildSystemPrompt({ name: "Ada", personality: "" }, base)).not.toContain("## Now");
  });

  it("is byte-identical however many times it is built and whatever the real clock says", () => {
    const bot = { name: "Ada", personality: "x" };
    const a = buildSystemPrompt(bot, { ...base, now: NOW });
    const real = Date.now;
    Date.now = () => 0;
    try {
      expect(buildSystemPrompt(bot, { ...base, now: NOW })).toBe(a);
    } finally {
      Date.now = real;
    }
  });

  it("formats an instant in the user's time zone, and falls back to UTC for an unknown one", () => {
    const at = new Date("2026-11-21T02:30:00.000Z");
    expect(formatClock(at, "America/Sao_Paulo")).toBe(
      "Friday 2026-11-20, 23:30 (America/Sao_Paulo, GMT-3)",
    );
    expect(formatClock(at, "Not/AZone")).toBe("Saturday 2026-11-21, 02:30 (UTC, GMT+0)");
  });
});

describe("state reminder: the live time", () => {
  it("carries the current time of the turn when there is one, and nothing when there is not", () => {
    const input = { objective: "o", acceptanceCriteria: [], plan: [] };
    const withNow = renderStateReminder({
      ...input,
      now: "Saturday 2026-11-21, 15:00 (America/Sao_Paulo, GMT-3)",
    });
    expect(withNow).toContain(
      "Now (the current time):\nSaturday 2026-11-21, 15:00 (America/Sao_Paulo, GMT-3)",
    );
    expect(renderStateReminder(input)).not.toContain("Now (the current time)");
  });
});

describe("system prompt: your team", () => {
  const bot = { name: "Principal", personality: "" };

  it("lists the other bots with what they are for, and says what to do with them", () => {
    const prompt = buildSystemPrompt(bot, {
      ...base,
      team: [
        { name: "Tutor faculdade", description: "Ajuda com disciplinas e prazos." },
        { name: "Finanças", description: "" },
      ],
    });
    expect(prompt).toContain(
      "## Your team\n\nThe user's other active bots:\n\n- Tutor faculdade: Ajuda com disciplinas e prazos.\n- Finanças\n\nIf a request is clearly another bot's area, say which bot it belongs to instead of doing it badly yourself. If the user keeps bringing an area that no bot covers, you may suggest creating one for it: the user decides, and you cannot create a bot yourself.",
    );
  });

  it("says so when the bot is alone", () => {
    expect(buildSystemPrompt(bot, { ...base, team: [] })).toContain(
      "## Your team\n\nYou are the only bot so far.",
    );
  });

  it("names a team that is too big only up to a limit", () => {
    const team = Array.from({ length: 33 }, (_, i) => ({ name: `Bot ${i}`, description: "d" }));
    const prompt = buildSystemPrompt(bot, { ...base, team });
    expect(prompt).toContain("- Bot 29: d\n- and 3 more");
    expect(prompt).not.toContain("Bot 30");
  });
});

describe("system prompt: what you have", () => {
  const bot = { name: "Ada", personality: "" };

  it("describes an isolated machine, truthfully", () => {
    const prompt = buildSystemPrompt(
      bot,
      {
        ...base,
        machine: { terminal: true, files: true, isolated: true },
        connectors: ["gmail", "github"],
      },
      { returns: true },
    );
    expect(prompt).toContain(
      "## What you have\n\n- A machine of your own with a terminal and files, in a private workspace. It is isolated from the user's computer: what you do there cannot touch their own files.\n- Connectors the user granted you: gmail, github. Their tools are found through the tool index.\n- `schedule_return`: you can come back by yourself in a few minutes, in this same conversation, to check something that takes time.\n- Memory: what you save is shown to the user in the Memory screen, where they can read, edit and delete it.",
    );
  });

  it("says the machine is NOT isolated when it is the user's own computer", () => {
    const prompt = buildSystemPrompt(bot, {
      ...base,
      machine: { terminal: true, files: false, isolated: false },
      connectors: [],
    });
    expect(prompt).toContain(
      "- A machine with a terminal. It is NOT isolated: it is the user's own computer, so what you do there is real. Be careful, and ask before anything you cannot undo.",
    );
    expect(prompt).toContain(
      "- No connectors to outside services yet. The user can grant you some in Settings.",
    );
    expect(prompt).not.toContain("schedule_return");
  });

  it("does not promise a terminal to a bot without one, nor memory to one without memory tools", () => {
    const prompt = buildSystemPrompt(
      bot,
      { ...base, machine: { terminal: false, files: false, isolated: true } },
      { memoryTools: false },
    );
    expect(prompt).toContain(
      "- No terminal and no files: you work only with the tools listed to you.",
    );
    expect(prompt).not.toContain("Memory screen");
  });
});

describe("system prompt: the welcome", () => {
  const bot = { name: "Tutor faculdade", personality: "Ajuda com estudos." };

  it("is only in a reception run", () => {
    expect(buildSystemPrompt(bot, base)).not.toContain("First conversation");
    expect(buildSystemPrompt(bot, { ...base, reception: "bot" })).toContain(
      "## First conversation",
    );
  });

  it("tells a normal bot to ask few questions about its own role, one at a time, and to yield", () => {
    const prompt = buildSystemPrompt(bot, { ...base, reception: "bot" });
    expect(prompt).toContain("Ask at most 3 questions");
    expect(prompt).toContain("Ask ONE question at a time with `escalate`");
    expect(prompt).toContain("The user's own request always comes first");
    expect(prompt).toContain("do NOT tell the user you saved it");
    expect(prompt).toContain("remind them it goes in the Vault");
    expect(prompt).not.toContain("propose_team");
  });

  it("gives the main bot the general welcome, with the team proposal and the closing line", () => {
    const prompt = buildSystemPrompt(
      { name: "Principal", personality: "" },
      { ...base, reception: "general" },
    );
    expect(prompt).toContain("call `propose_team` ONCE");
    expect(prompt).toContain(
      "Pronto. O que você me contou fica em Memória, e dá para refazer isso em Configurações.",
    );
  });
});

describe("system prompt: the supervisor", () => {
  const bot = { name: "Principal", personality: "" };
  const team = [{ name: "Tutor", description: "Faculdade." }];

  it("tells the main bot it is the supervisor: reads read-only, delegates on request, reviews at night", () => {
    const prompt = buildSystemPrompt(bot, {
      rules: [],
      profile: [],
      team,
      supervisor: "principal",
    });
    expect(prompt).toContain("You are the supervisor of this team");
    expect(prompt).toContain("`team_recall`");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("You can never write to another bot's memory");
    expect(prompt).toContain("`delegate`");
    expect(prompt).toContain("a delegated bot cannot delegate again");
    expect(prompt).toContain("Once a night you review");
    expect(prompt).toContain("never what their tools returned");
    expect(prompt).not.toContain("The Principal, the user's main bot, supervises the team");
  });

  it("tells the other bots the Principal may delegate to them and reads their journal at night", () => {
    const prompt = buildSystemPrompt(bot, { rules: [], profile: [], team, supervisor: "member" });
    expect(prompt).toContain("The Principal, the user's main bot, supervises the team");
    expect(prompt).toContain("may delegate a task to you");
    expect(prompt).toContain("reads your journal and notes, read-only");
    expect(prompt).not.toContain("You are the supervisor of this team");
  });

  it("says nothing about it when the run is not told (older recordings, a welcome, an evaluation)", () => {
    const prompt = buildSystemPrompt(bot, { rules: [], profile: [], team });
    expect(prompt).not.toContain("supervis");
  });
});

describe("the web line", () => {
  const bot = { name: "Ana", personality: "" };
  const machine = { terminal: true, files: true, isolated: true };

  it("is left out when the model is not offered the web tools", () => {
    const prompt = buildSystemPrompt(bot, { rules: [], profile: [], machine } as never);
    expect(prompt).not.toContain("web_search");
    expect(prompt).not.toContain("web_read");
  });

  it("names the tools the model has, and says what comes back is data", () => {
    const both = buildSystemPrompt(bot, { rules: [], profile: [], machine } as never, {
      web: { search: true, read: true },
    });
    expect(both).toContain("`web_search` finds sources");
    expect(both).toContain("`web_read` reads a page");
    expect(both).toContain("never instructions");
    const readOnly = buildSystemPrompt(bot, { rules: [], profile: [], machine } as never, {
      web: { search: false, read: true },
    });
    expect(readOnly).not.toContain("web_search");
    expect(readOnly).toContain("`web_read` reads a public page");
  });
});
