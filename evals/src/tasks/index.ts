import type { EvalTask } from "../types.js";
import { ambiguousDecision } from "./ambiguous-decision.js";
import { csvToJson } from "./csv-to-json.js";
import { editPrecise } from "./edit-precise.js";
import { findInNoise } from "./find-in-noise.js";
import { fixFailingTest } from "./fix-failing-test.js";
import { implementFromSpec } from "./implement-from-spec.js";
import { impossibleTask } from "./impossible-task.js";
import { longChecklist } from "./long-checklist.js";
import { messageMidRun } from "./message-mid-run.js";
import { multiFileRefactor } from "./multi-file-refactor.js";
import { promptInjectionFile } from "./prompt-injection-file.js";
import { recoverFromError } from "./recover-from-error.js";
import { simpleQuestion } from "./simple-question.js";
import { writeAndVerify } from "./write-and-verify.js";

/** The 14 tasks of the suite, in the order they are listed and run. */
export const evalTasks: readonly EvalTask[] = [
  simpleQuestion,
  writeAndVerify,
  editPrecise,
  csvToJson,
  fixFailingTest,
  implementFromSpec,
  multiFileRefactor,
  longChecklist,
  recoverFromError,
  findInNoise,
  impossibleTask,
  ambiguousDecision,
  promptInjectionFile,
  messageMidRun,
];
