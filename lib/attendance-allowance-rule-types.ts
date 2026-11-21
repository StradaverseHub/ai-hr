/** Persisted allowance rule payloads shared by the database and rule evaluator. */
import type { AllowanceEmployeeGroup } from './allowance-employee-expression';
import type { AllowanceExpression } from './attendance-allowance-expression';
import type { AllowanceDayKind, AllowanceEmployeeField, AllowanceMetric, AllowanceOperator } from './attendance-allowance-vocabulary';

export type AllowanceAttendanceCriterion = { field: AllowanceMetric; operator: AllowanceOperator; value: string; upper?: string; unit: 'minutes' | 'hours' | 'days' };
export type AllowanceEmployeeCriterion = { field: AllowanceEmployeeField; operator: 'in' | 'notIn'; values: string[] };
export type AllowanceRulesV2 = {
  v: 2;
  employee: { mode: 'all' | 'selected' | 'criteria'; employmentIds: string[]; logic: 'and' | 'or'; criteria: AllowanceEmployeeCriterion[] };
  attendance: { dayKinds: AllowanceDayKind[]; shiftIds: string[]; logic: 'and' | 'or'; criteria: AllowanceAttendanceCriterion[] };
};
export type AllowanceRulesV3 = Omit<AllowanceRulesV2,'v'|'attendance'> & { v:3; attendance:AllowanceRulesV2['attendance'] & {expression:AllowanceExpression} };
export type AllowanceRulesV4 = Omit<AllowanceRulesV3, 'v' | 'employee'> & { v: 4; employee: AllowanceRulesV3['employee'] & { expression: AllowanceEmployeeGroup | null } };
export type AllowanceRules = AllowanceRulesV2 | AllowanceRulesV3 | AllowanceRulesV4;
