/** ad6ed930 — 'after_leaving_date': the row's Effective Date is after the employee's last day (`leftOn`). */
export type PayItemRepriceReason='formula_failed'|'not_positive'|'zero_divisor'|'input_missing'|'no_longer_calculates'|'after_leaving_date';
/** The updated Pay Item formula could not price one or more of an employee's transactions. Never a silent fallback to
 * the previous figure: a reprocess maps it to a Configuration incomplete outcome (core/payroll.ts) and keeps the run
 * marked; a whole-run processing job fails with this message and the run returns to draft. */
export class PayItemFormulaRepriceError extends Error{
 constructor(public readonly employmentId:string,public readonly componentId:string,public readonly code:string,public readonly itemName:string,
  public readonly dates:string[],public readonly reason:PayItemRepriceReason,public readonly detail:string|null,public readonly leftOn:string|null=null,
  public readonly employee?:{name:string;code:string|null}){
  const why={formula_failed:'The formula could not be calculated for these inputs.',not_positive:'The formula did not produce a positive amount.',
   zero_divisor:'The formula divides by zero for these inputs.',input_missing:'The transaction has no Hours, Days or Quantity the formula needs.',
   no_longer_calculates:'The Pay Item no longer calculates its amount from a formula.',after_leaving_date:''}[reason];
  // ad6ed930 — a date after the last day is not a formula fault: say so, with the date, and do not send HR to Pay Items.
  super(reason==='after_leaving_date'&&leftOn
   ?`${itemName} (${code}): ${dates.length} transaction${dates.length===1?' is':'s are'} dated after this employee's last day (${dates.join(', ')}). This employee left on ${leftOn}. Choose an effective date on or before that day.`
   :`${itemName} (${code}): the updated formula could not calculate ${dates.length} transaction${dates.length===1?'':'s'} (${dates.join(', ')}). ${why}${detail?` ${detail}`:''} Correct the formula in Payroll > Settings > Pay Items and process again.`);
  this.name='PayItemFormulaRepriceError';
 }
}
