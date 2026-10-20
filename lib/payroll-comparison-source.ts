/** Read recorded paid results. Today's pay-item catalogue and company settings are deliberately absent. */
import { payrollAmountMinor, payrollMinorDecimal } from './payroll-period-comparison';
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function recordedPayrollComparisonCurrency(statutory: unknown, companyId: string): string | null {
  const stamp = object(object(statutory)?.reportContext);
  return stamp?.version === 1 && stamp.payingCompanyId === companyId &&
    typeof stamp.currency === 'string' && /^[A-Z]{3}$/.test(stamp.currency) ? stamp.currency : null;
}
/** Recorded lines establish their own amounts. Only an explicit complete-itemization stamp proves that
 * an absent code paid zero: legacy arrays may contain just formula OT while other pay has no item code. */
export function recordedPayrollComparisonAmount(basicSalary: string, statutory: unknown, code: string, companyId?:string): string | null {
  if (code === 'BASIC') return payrollMinorDecimal(payrollAmountMinor(basicSalary));
  const lines = object(statutory)?.componentLines;
  if (!Array.isArray(lines)) return null;
  let amount = BigInt('0'),matched=false;
  for (const entry of lines) {
    const line = object(entry);
    if (!line || typeof line.code !== 'string') return null;
    if (line.code !== code) continue;
    matched=true;
    try { amount += payrollAmountMinor(line.amount); } catch { return null; }
  }
  const stamp=object(object(statutory)?.reportContext);
  const complete=companyId!==undefined&&stamp?.version===1&&stamp.payingCompanyId===companyId&&stamp.itemization==='complete';
  return matched||complete?payrollMinorDecimal(amount):null;
}

/** Employer-owned coverage is not paid tenure. Read only the calculation's explicit monthly evidence. */
export function recordedPayrollProrationCoverage(statutory:unknown,companyId:string,period:{from:string;to:string}):{from:string;to:string}|undefined{
  const stamp=object(object(statutory)?.reportContext),proof=object(stamp?.proration);
  if(stamp?.version!==1||stamp.payingCompanyId!==companyId||proof?.payMode!=='monthly'||typeof proof.factor!=='number'||!Number.isFinite(proof.factor)||proof.factor<0||proof.factor>=1)return;
  const valid=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  if(!valid(proof.from)||proof.to!==null&&!valid(proof.to))return;
  const from=proof.from>period.from?proof.from:period.from,to=proof.to&&proof.to<period.to?proof.to:period.to;
  if(from>to||from===period.from&&to===period.to)return;
  return {from,to};
}
