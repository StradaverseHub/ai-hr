/** One ordered vocabulary for company display settings and every standard payslip output. */
export const PAYSLIP_INFORMATION_FIELDS = [
  'employee', 'employeeCode', 'identityNumber', 'taxNumber', 'epfNumber', 'socsoNumber',
  'department', 'position', 'jobGrade', 'employmentType', 'businessUnit', 'division',
  'branch', 'region', 'line', 'section', 'team', 'base', 'category', 'daysWorked', 'currency',
] as const;
export type PayslipInformationField = typeof PAYSLIP_INFORMATION_FIELDS[number];
export const DEFAULT_PAYSLIP_INFORMATION_FIELDS: readonly PayslipInformationField[] =
  PAYSLIP_INFORMATION_FIELDS.filter(k => !['businessUnit','division','branch','region','line','section','team','base','category'].includes(k));
export function payslipInformationFields(raw: unknown): readonly PayslipInformationField[] {
  return Array.isArray(raw) ? PAYSLIP_INFORMATION_FIELDS.filter(k => raw.includes(k)) : DEFAULT_PAYSLIP_INFORMATION_FIELDS;
}
export function selectPayslipInformation(
  data: Partial<Record<PayslipInformationField, unknown>>,
  settings: unknown,
  labels: Record<PayslipInformationField, string>,
): { key: PayslipInformationField; label: string; value: string }[] {
  return payslipInformationFields(settings).flatMap(key => {
    const value = data[key];
    if (value == null || String(value).trim() === '') return [];
    return [{ key, label: labels[key], value: String(value).trim() }];
  });
}

/** One row-major profile order for review and both PDF outputs; header facts stay in the header. */
export function payslipProfileRows(
  informationRows: readonly {label:string;value:string}[],
  extra:{paymentMethod?:string|null;bankName?:string|null;bankAccount?:string|null;cycle?:string|null},
  labels:{paymentMethod:string;bankName:string;bankAccount:string;cycle:string},
):{label:string;value:string}[]{
  return [...informationRows.map(({label,value})=>({label,value})),
    ...(['paymentMethod','bankName','bankAccount','cycle'] as const).flatMap(key=>{
      const value=extra[key]?.trim();return value?[{label:labels[key],value}]:[];
    })];
}
