/** Shared deterministic allowance vocabulary; no runtime or database dependencies. */
export const ALLOWANCE_METHODS_V2 = ['monthly', 'weekly', 'daily'] as const;
export type AllowancePeriodMethod = typeof ALLOWANCE_METHODS_V2[number];
export type AllowancePolicyType = 'earning' | 'deduction';
export const ALLOWANCE_EMPLOYEE_FIELDS = ['companyId', 'departmentId', 'businessUnitId', 'positionId', 'gradeId', 'employmentType', 'employmentCategory', 'status'] as const;
export type AllowanceEmployeeField = typeof ALLOWANCE_EMPLOYEE_FIELDS[number];
export const ALLOWANCE_METRICS = ['workingMinutes', 'actualMinutes', 'overtimeMinutes', 'lateMinutes', 'earlyOutMinutes', 'absentDays', 'attendanceDays', 'eligibleWorkingDays'] as const;
export type AllowanceMetric = typeof ALLOWANCE_METRICS[number];
export const ALLOWANCE_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'] as const;
export type AllowanceOperator = typeof ALLOWANCE_OPERATORS[number];
export const ALLOWANCE_DAY_KINDS = ['full', 'half', 'off', 'rest', 'holiday'] as const;
export type AllowanceDayKind = typeof ALLOWANCE_DAY_KINDS[number];
