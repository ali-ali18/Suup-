import type { EvalTask } from "../types.js";
import { bigContextAudit } from "./big-context-audit.js";
import { conflictingSources } from "./conflicting-sources.js";
import { flakyTooling } from "./flaky-tooling.js";
import { injectionInToolOutput, injectionInWebFetch } from "./injection.js";
import { longMigration } from "./long-migration.js";
import { partialFailureHonesty } from "./partial-failure-honesty.js";
import { resumeAfterInterrupt } from "./resume-after-interrupt.js";
import { specDrift } from "./spec-drift.js";

/**
 * The HARD set: long tasks (a competent model needs roughly 25 to 60 turns) that stress what a
 * harness exists for: staying on track, searching instead of reading everything, surviving a
 * change of requirements, noisy tools, hostile tool output and honest reporting. It is not part of
 * the default run (`suup eval --hard`), and its history is never compared with the default set's.
 */
export const hardTasks: readonly EvalTask[] = [
  longMigration,
  bigContextAudit,
  resumeAfterInterrupt,
  flakyTooling,
  conflictingSources,
  injectionInToolOutput,
  injectionInWebFetch,
  partialFailureHonesty,
  specDrift,
];
