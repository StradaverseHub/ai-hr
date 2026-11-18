/** Canonical confirmation-date precedence used by the employment status owner. */
export type EmploymentConfirmationDates = {
  finalConfirmationDate?: string | null; confirmationDate?: string | null;
  probationEndDate?: string | null; provisionalEndOn?: string | null;
};
export function employmentConfirmationDate(source: EmploymentConfirmationDates): string | null {
  return source.finalConfirmationDate ?? source.confirmationDate ?? source.probationEndDate ?? source.provisionalEndOn ?? null;
}
