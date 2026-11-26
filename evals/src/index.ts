export {
  BATTERY,
  BATTERY_CLASSES,
  BATTERY_RULE_IDS,
  BATTERY_RULES,
  type BatteryCase,
  type BatteryClass,
  type BatteryReport,
  type CaseResult,
  type ClassSummary,
  formatBatteryReport,
  JUDGED_BATTERY,
  JUDGED_CLASSES,
  type JudgedCase,
  type JudgedClass,
  type JudgedClassSummary,
  type JudgedReport,
  type JudgedResult,
  type RunBatteryOptions,
  runBattery,
  runJudgedBattery,
} from "./auto-review/index.js";
export { abntPdf, documentTasks, reportPdf, salesXlsx } from "./documents/index.js";
export { stamp } from "./fmt.js";
export { hardTasks } from "./hard/index.js";
export {
  appendHistory,
  compareWithPrevious,
  DEFAULT_HISTORY_FILE,
  type HistoryEntry,
  historyEntries,
  historyEntrySchema,
  readHistory,
  recordHistory,
  suiteId,
  type TaskSet,
  taskSetOf,
} from "./history.js";
export {
  type ConsolidationCaseResult,
  type ConsolidationEvalReport,
  formatConsolidationReport,
  type RunConsolidationEvalOptions,
  runConsolidationEval,
} from "./memory/consolidation.js";
export {
  CONSOLIDATION_CASES,
  type ConsolidationCase,
  FAKE_PASSWORD,
  INJECTED_ORDER,
} from "./memory/consolidation-cases.js";
export {
  formatRecallReport,
  type QuestionResult,
  type RecallReport,
  runRecallBenchmark,
  TOP_K,
  type VariantReport,
} from "./memory/recall.js";
export { type EventMetrics, eventMetrics } from "./metrics.js";
export { qualificationTasks } from "./qualify/index.js";
export { ORDER_FILE, registerOrderTool } from "./qualify/register-order-tool.js";
export {
  CELL_ORIGINS,
  type CellOrigin,
  type CellResult,
  diagnosticCommands,
  type EvalReport,
  evalReportSchema,
  type HistoryNote,
  isQualified,
  isSkipped,
  type ModelSummary,
  ORIGIN_MEANING,
  parseReport,
  renderMarkdown,
  summarizeModel,
} from "./report.js";
export {
  type EvalPlan,
  type EvalProgress,
  EvalSetupError,
  type PlannedCell,
  planEval,
  type RunEvalOptions,
  runEval,
  toolsOfferedTo,
} from "./runner.js";
export { evalTasks } from "./tasks/index.js";
export {
  EVAL_CATEGORIES,
  type EvalCategory,
  type EvalCheck,
  type EvalLimits,
  type EvalTask,
  type InboxScriptItem,
  type VerifyContext,
  type VerifyResult,
} from "./types.js";
