/** One ordered vocabulary for company display settings and every standard payslip output. */
export const PAYSLIP_INFORMATION_FIELDS = [
  'employee', 'employeeCode', 'identityNumber', 'taxNumber', 'epfNumber', 'socsoNumber',
  'department', 'position', 'jobGrade', 'employmentType', 'businessUnit', 'division',
  'branch', 'region', 'line', 'section', 'team', 'base', 'category', 'daysWorked', 'currency',
] as const;
export type PayslipInformationField = typeof PAYSLIP_INFORMATION_FIELDS[number];
export const DEFAULT_PAYSLIP_INFORMATION_FIELDS: readonly PayslipInformationField[] =
  PAYSLIP_INFORMATION_FIELDS.filter(k => !['businessUnit','division','branch','region','line','section','team','base','category'].includes(k));
/**
 * r389 (23bd49d9) — the company's saved setting IS the order. A stored `fields` array is the ordered list of
 * shown fields, read back exactly as saved: an unknown key is dropped (a renamed field never prints a raw
 * key), a repeated key keeps its FIRST place (a field never prints twice), and anything that is not an array
 * — no row yet — gives the defaults. Before r389 this re-filtered the catalogue, so the stored order was
 * ignored; every row the setter wrote then was already in catalogue order, which is why no existing payslip
 * changes until someone reorders.
 */
export function payslipInformationFields(raw: unknown): readonly PayslipInformationField[] {
  if (!Array.isArray(raw)) return DEFAULT_PAYSLIP_INFORMATION_FIELDS;
  const known = new Set<string>(PAYSLIP_INFORMATION_FIELDS);
  const seen = new Set<string>();
  const ordered: PayslipInformationField[] = [];
  for (const key of raw) {
    if (typeof key !== 'string' || !known.has(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key as PayslipInformationField);
  }
  return ordered;
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
