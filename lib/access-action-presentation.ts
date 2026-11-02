/** Public presentation metadata; grant and native authority remain in the canonical SQL owners. */
export const ACTION_MATRIX_DOMAINS={
 workforce:'matrixWorkforce',payroll:'matrixPayroll',performance_compensation:'matrixPerformanceCompensation',letters:'matrixLetters',organisation:'matrixOrganisation',settings:'matrixSettings',
 payroll_configuration:'matrixPayrollConfiguration',claims_configuration:'matrixClaimsConfiguration',claims:'matrixClaims',leave_configuration:'matrixLeaveConfiguration',leave:'matrixLeave',attendance_configuration:'matrixAttendanceConfiguration',attendance:'matrixAttendance',
} as const;
const labelPrefixes:Record<keyof typeof ACTION_MATRIX_DOMAINS,string>={workforce:'workforce',payroll:'payroll',performance_compensation:'performanceCompensation',letters:'letters',organisation:'organisation',settings:'settings',payroll_configuration:'payrollConfiguration',claims_configuration:'claimsConfiguration',claims:'claims',leave_configuration:'leaveConfiguration',leave:'leave',attendance_configuration:'attendanceConfiguration',attendance:'attendance'};
export function actionCapabilityLabelKey(id:string):string|null{
 const match=/^([a-z][a-z0-9_]*)\.(view|add|edit|delete|approve|issue)$/.exec(id);
 if(!match||!Object.hasOwn(labelPrefixes,match[1]))return null;
 return labelPrefixes[match[1] as keyof typeof labelPrefixes]+match[2][0].toUpperCase()+match[2].slice(1);
}
