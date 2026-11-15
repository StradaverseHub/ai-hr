/**
 * Shared automation conditions (ADR 2026-11-15-probation-shared-automation, build step 1; handoff A1).
 *
 * One evaluator for workflow-level "Only if" conditions and step-level "Only run this step if" conditions, used by
 * every module's catalogue. Pure and dependency-free.
 *
 * Semantics:
 *  - `is` matches when the case value equals ANY selected value; `isNot` when it equals NONE of them. With one value
 *    this is exactly the equality the V9 and Contract staff engines apply today (`fact === value` / `fact !== value`).
 *  - `lt`, `lte`, `gte` compare numbers and take exactly one value. A non-numeric case value never matches.
 *  - A field the trigger cannot supply (`undefined`) never matches, for any operator, and says why. A field the trigger
 *    supplies but that is empty is `null` and compares as the empty string, which keeps today's behaviour where, for
 *    example, Contract staff "decision is not Renew" matches a case with no decision yet. Module adapters must pass
 *    `null` (not `undefined`) for supplied-but-empty facts.
 */
export const AUTOMATION_CONDITION_OPS = ['is', 'isNot', 'lt', 'lte', 'gte'] as const;
export type AutomationConditionOp = typeof AUTOMATION_CONDITION_OPS[number];
export type AutomationCondition = { field: string; op: AutomationConditionOp; values: string[] };
/** The case value for a field: a string, `null` when supplied but empty, `undefined` when this trigger cannot supply it. */
export type AutomationFactValue = string | null | undefined;
export type AutomationConditionResult = { condition: AutomationCondition; ok: boolean; actual: string | null; unavailable: boolean };

export const MAX_CONDITION_VALUES = 200;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const numericOp = (op: AutomationConditionOp) => op === 'lt' || op === 'lte' || op === 'gte';

/** Lift a single-value condition from the V9 or Contract staff schema without changing its meaning. */
export function fromSingleValueCondition(condition: { field: string; op: AutomationConditionOp; value: string }): AutomationCondition {
  return { field: condition.field, op: condition.op, values: [condition.value] };
}

/** Save-time problems for one condition. Empty means valid. Field availability is checked against the catalogue elsewhere. */
export function automationConditionProblems(condition: AutomationCondition): string[] {
  const problems: string[] = [];
  if (!condition.field.trim()) problems.push('Choose a field.');
  if (!(AUTOMATION_CONDITION_OPS as readonly string[]).includes(condition.op)) problems.push('Choose how to compare.');
  if (!Array.isArray(condition.values) || condition.values.length === 0) problems.push('Choose at least one value.');
  else if (condition.values.length > MAX_CONDITION_VALUES) problems.push(`Choose at most ${MAX_CONDITION_VALUES} values.`);
  else if (new Set(condition.values).size !== condition.values.length) problems.push('Each value can be chosen once.');
  if (numericOp(condition.op) && (condition.values.length !== 1 || !NUMERIC.test(condition.values[0] ?? ''))) problems.push('Enter one number to compare with.');
  return problems;
}

export function evaluateAutomationCondition(condition: AutomationCondition, value: AutomationFactValue): AutomationConditionResult {
  if (value === undefined) return { condition, ok: false, actual: null, unavailable: true };
  const actual = value ?? '';
  let ok: boolean;
  if (condition.op === 'is') ok = condition.values.includes(actual);
  else if (condition.op === 'isNot') ok = !condition.values.includes(actual);
  else {
    const target = condition.values.length === 1 && NUMERIC.test(condition.values[0]) ? Number(condition.values[0]) : NaN;
    const current = NUMERIC.test(actual) ? Number(actual) : NaN;
    ok = !Number.isNaN(target) && !Number.isNaN(current) && (condition.op === 'lt' ? current < target : condition.op === 'lte' ? current <= target : current >= target);
  }
  return { condition, ok, actual: value, unavailable: false };
}

/** All conditions must match. An empty list matches every case. Returns each result for the dry run and case activity. */
export function evaluateAutomationConditions(conditions: readonly AutomationCondition[], read: (field: string) => AutomationFactValue): { ok: boolean; results: AutomationConditionResult[] } {
  const results = conditions.map(condition => evaluateAutomationCondition(condition, read(condition.field)));
  return { ok: results.every(result => result.ok), results };
}

/** Plain-language summary, e.g. "Outcome is Confirm or Extend", "Part is not any of Part 1, Part 2". */
export function describeAutomationCondition(condition: AutomationCondition, label: (field: string) => string = field => field): string {
  const values = condition.values;
  const list = values.length === 0 ? '(nothing selected)' : values.length === 1 ? values[0] : condition.op === 'isNot' ? 'any of ' + values.join(', ') : values.join(' or ');
  const verb = { is: 'is', isNot: 'is not', lt: 'is less than', lte: 'is at most', gte: 'is at least' }[condition.op];
  return `${label(condition.field)} ${verb} ${list}`;
}
