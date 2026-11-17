/** Employment and Movement use the same period value/unit pairs. Absent means untouched. */
export const MOVEMENT_EMPLOYMENT_PERIODS = [
  { value: 'probationValue', unit: 'probationUnit', label: 'probationPeriod' },
  { value: 'extendedProbationValue', unit: 'extendedProbationUnit', label: 'extendedProbationPeriod' },
  { value: 'noticeBeforeConfirmationValue', unit: 'noticeBeforeConfirmationUnit', label: 'noticeBeforeConfirmation' },
  { value: 'noticeAfterConfirmationValue', unit: 'noticeAfterConfirmationUnit', label: 'noticeAfterConfirmation' },
] as const;
export type MovementEmploymentPeriodField = typeof MOVEMENT_EMPLOYMENT_PERIODS[number]['value' | 'unit'];
export const MOVEMENT_EMPLOYMENT_PERIOD_FIELDS: readonly MovementEmploymentPeriodField[] =
  MOVEMENT_EMPLOYMENT_PERIODS.flatMap(period => [period.value, period.unit]);
export type MovementEmploymentPeriods = Partial<Record<MovementEmploymentPeriodField, string | null>>;

/** Normalize numeric database values before comparing them with form or audit values. */
export function movementPeriodValue(value: string | number | null | undefined): string | null {
  return value == null || value === '' ? null : String(value);
}

/** Match the employment owner's numeric/unit normalization before diffing or freezing intent. */
export function normalizedMovementEmploymentPeriods(input: MovementEmploymentPeriods): MovementEmploymentPeriods {
  const normalized: MovementEmploymentPeriods = {};
  for (const period of MOVEMENT_EMPLOYMENT_PERIODS) {
    for (const field of [period.value, period.unit]) {
      if (input[field] === undefined) continue;
      const value = input[field]?.trim() || null;
      normalized[field] = field === period.unit ? value?.toLowerCase() ?? null
        : value !== null && Number.isInteger(Number(value)) && Number(value) >= 0 ? String(Number(value)) : value;
    }
  }
  return normalized;
}
