/** Correction destinations for the existing Personnel owners. Links grant no access. */
const TABS = {
  missingCompensation: 'payroll', zeroBasic: 'payroll', unpayablePayMode: 'payroll',
  tp3YearMismatch: 'payroll', staleBasicComponent: 'payroll', currencyMismatch: 'payroll',
  // Payroll contains the recorded salary arrangement/remarks and the person's payable setup;
  // this neutral notice does not assert that a deliberate no-pay month is an error to repair.
  nothingPayable: 'payroll',
  missingStatutory: 'bankStatutory', missingBank: 'bankStatutory', hrdfSubjectUnregistered: 'bankStatutory',
} as const;
export type PayrollPrecheckIssue = keyof typeof TABS;
export function payrollPrecheckProfileHref(employmentId:string,issue:PayrollPrecheckIssue):string {
  return `/admin/personnel/${encodeURIComponent(employmentId)}?tab=${TABS[issue]}`;
}
