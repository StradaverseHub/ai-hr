/** Independent approved UI contract, intentionally not read from the production options declaration.
 * Manual percentage and historical top-up remain distinct choices with distinct saved meanings. */
export const EXPECTED_EPF_UI_CHOICES = [
  {value:'auto',message:'epfModeAuto'},
  {value:'manual_percentage',message:'epfModeManualPercentage'},
  {value:'voluntary_percentage',message:'epfModeVoluntaryPercentage'},
  {value:'semi_auto',message:'epfModeSemiAuto'},
  {value:'manual_employee_amount',message:'epfModeManualEmployeeAmount'},
  {value:'manual_employer_amount',message:'epfModeManualEmployerAmount'},
  {value:'manual_both_amount',message:'epfModeManualBothAmount'},
  {value:'none',message:'epfModeExempt'},
] as const;
