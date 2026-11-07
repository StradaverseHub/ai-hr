/** Reserved report-only names cannot collide with configured Pay Item codes. */
export const RECORDED_PAYROLL_TOTALS = {
 '@total/allowance':'Recorded Allowance Total','@total/overtime':'Recorded Overtime Total','@total/bonus':'Recorded Bonus Total','@total/otherDeductions':'Recorded Other Deductions',
 '@total/netPay':'Net Pay','@total/grossPay':'Gross Pay','@total/totalDeductions':'Total Deductions','@total/employerCost':'Employer Cost',
 '@statutory/epfEmployee':'EPF Employee','@statutory/epfEmployer':'EPF Employer','@statutory/socsoEmployee':'SOCSO Employee','@statutory/socsoEmployer':'SOCSO Employer',
 '@statutory/eisEmployee':'EIS Employee','@statutory/eisEmployer':'EIS Employer','@statutory/pcb':'PCB','@statutory/cp38':'CP38','@statutory/zakat':'Zakat','@statutory/hrdf':'HRDF','@statutory/lp':'Levy','@statutory/socsoSkbbk':'SOCSO SKBBK',
} as const;
export const isRecordedPayrollTotal=(code:string)=>Object.prototype.hasOwnProperty.call(RECORDED_PAYROLL_TOTALS,code);
/** Internal report keys are never presented as configured Pay Item codes. */
export const payrollReconciliationItemLabel=(code:string)=>RECORDED_PAYROLL_TOTALS[code as keyof typeof RECORDED_PAYROLL_TOTALS]??code;
