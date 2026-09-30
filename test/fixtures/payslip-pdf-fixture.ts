/**
 * 5b2a7f0f — THE ONE PAYSLIP FIXTURE, shared by `test/payslip-pdf.test.ts` and
 * `test/payslip-pdf-unicode.test.ts`.
 *
 * It was defined inside the first of those and is MOVED here unchanged, comments and all. Two copies of a
 * 68-field label object is how one of them quietly loses a field and the two test files stop rendering the
 * same document — which is the same failure `lib/payslip-pdf-strings.ts` exists to prevent for the two PDF
 * ROUTES. Not a `.test.ts`, so vitest's `test/**\/*.test.ts` include never collects it as a suite.
 */
import type { PayslipPdfData, PayslipPdfLabels } from '../../lib/payslip-pdf';

export const labels: PayslipPdfLabels = {
  title: 'Payslip',
  payPeriod: 'Pay period',
  employeeCode: 'Employee code',
  earnings: 'Earnings',
  basicSalary: 'Basic salary',
  allowances: 'Allowances',
  overtime: 'Overtime',
  bonus: 'Bonus',
  grossPay: 'Gross pay',
  deductions: 'Deductions',
  epf: 'EPF',
  socso: 'SOCSO',
  skbbk: 'SKBBK',
  eis: 'EIS',
  pcb: 'PCB',
  cp38: 'CP38',
  // 3a092cf0 — the zakat deduction row's label. Required, so tsc is what stops the document
  // dropping a line the screens print.
  zakat: 'Zakat',
  otherDeductions: 'Other deductions',
  // e2632276 — the two named absence lines that come OUT of "Other deductions".
  unpaidLeaveLine: 'Unpaid leave',
  absentLine: 'Absent',
  dayUnit: 'day',
  daysUnit: 'days',
  totalDeductions: 'Total deductions',
  netPay: 'Net pay',
  employerContributions: 'Employer contributions',
  totalEmployerCost: 'Total employer cost',
  generatedNote: 'This is a system-generated payslip.',
  claim: 'Claim',
  employerBorne: 'Paid by your employer on your behalf',
  employerBorneTotal: 'Total borne by employer',
  employerBorneNote: 'Reported in full to the authorities; not deducted from your pay.',
  documentSubtitle: 'Payroll payslip',
  // r360 — the caption the letterhead now prints in front of the registration number. This fixture says
  // what the REAL caller says: `payslipPdfStrings` resolves `admin.organization.regNo`, whose en value is
  // "Reg. no." (pinned across all six catalogues in test/individual-payslip.test.ts).
  companyReg: 'Reg. no.',
  // a96d320c — the shape the REAL caller now passes. `payslipPdfStrings` interpolates the localized
  // `payDateLine` with `englishLongDate(payDate)`, so the fixture says what the document says.
  paymentDate: 'Payment date: 30 June 2026',
  employmentInfo: 'Employment info',
  department: 'Department',
  position: 'Position',
  grade: 'Grade',
  employmentType: 'Employee type',
  daysWorked: 'Days worked',
  currency: 'Currency',
  ic: 'NRIC',
  passport: 'Passport',
  epfNumber: 'EPF number',
  socsoNumber: 'SOCSO / EIS number',
  taxNumber: 'Income tax number',
  totalEarnings: 'Total earnings',
  hrdf: 'HRDF',
  employerContributionsNote: 'For reference. Paid by the company.',
  paymentInformation: 'Payment information',
  paymentMethod: 'Payment method',
  bankName: 'Bank name',
  bankAccount: 'Bank account',
  ytdHeading: 'Year to date · 2026',
  ytdItem: 'Item',
  ytdCurrent: 'This run',
  ytdToDate: 'Year to date',
  detailNotRecorded: 'This payroll run recorded only the totals.',
  earningsContinued: 'Earnings (continued)',
  periodLabel: 'June 2026',
  // f35f758a — the Non-payable box's three REQUIRED labels. tsc is what stops one PDF route printing a
  // block the other one does not, and it caught this fixture the moment they were added.
  // a96d320c rev 3 — "Other", the word the reporter asked the column to be called now that it sits
  // beside Employer contributions instead of full width under NET PAY. This fixture says what the REAL
  // caller says: `me.payslip.nonPayableHeading` carries this value in all six locales (pinned in
  // test/individual-payslip.test.ts, which is the test that reads the catalogue).
  nonPayable: 'Other',
  nonPayableTotal: 'Total non-payable',
  nonPayableNote: 'Recorded for your reference only - these do not affect your gross or net pay.',
  // a96d320c — the rate-and-input vocabulary. REQUIRED on the type, and tsc caught this fixture the
  // moment the keys were added, which is the mechanism that stops one PDF route printing a block the
  // other one does not.
  hourUnit: 'hour',
  hoursUnit: 'hours',
  otLegs: {
    workday: 'Overtime - normal working day',
    rest_day: 'Overtime - rest day',
    rest_day_excess: 'Overtime - rest day, beyond normal hours',
    holiday: 'Overtime - public holiday',
    holiday_excess: 'Overtime - public holiday, beyond normal hours',
  },
};
export const data: PayslipPdfData = {
  employee: 'Aisyah Rahman',
  employeeCode: 'EMP-001',
  company: 'Demo Sdn Bhd',
  companyReg: '202301000001 (1400001-A)',
  payPeriod: '2026-06',
  basic: 6500,
  allowance: 500,
  overtime: 120,
  bonus: 0,
  claim: 0,
  gross: 7120,
  epfEmployee: 715,
  socsoEmployee: 24.75,
  socsoSkbbk: 0,
  eisEmployee: 9.9,
  pcb: 350,
  cp38: 0,
  // 3a092cf0 — no election on this fixture, so no zakat row: the document it renders is
  // byte-for-byte the one it rendered before the line existed.
  zakat: 0,
  // 3a092cf0 — this base fixture is a POST-fix slip (its total counts zakat). The legacy case is
  // exercised explicitly below, because that is the one that regressed history.
  zakatCountedInTotal: true,
  otherDeductions: 0,
  // e2632276 — no stamp on this fixture ⇒ the pre-feature path: no named lines, residual === otherDeductions.
  // 970e4143 — and no CP38, so no CP38 row. ⚠️ A CASE THAT RAISES `cp38` MUST RAISE `otherDeductions` WITH
  // IT and leave `totalDeductions` alone: the kernel folds the applied CP38 INTO other_deductions
  // (core/payroll.ts `slipExtraDeduct`), so `cp38: 50` beside `otherDeductions: 0` and a total bumped by 50
  // encodes the OPPOSITE model and is how the one arithmetic assertion over this document stayed blind to a
  // double count that was on every affected payslip.
  absence: { unpaidLeave: null, absent: null, cp38: { amount: 0, show: false }, residual: 0, showResidual: false, any: false },
  totalDeductions: 1099.65,
  net: 6020.35,
  epfEmployer: 925,
  socsoEmployer: 86.65,
  eisEmployer: 9.9,
  employerCost: 8141.55,
  daysWorked: 21,
  employerBorne: [],
  employerBorneTotal: 0,
  currency: 'MYR',
};
