/**
 * Item 1859cce0 — the contract-period rule, owned in ONE place.
 *
 * `setEmploymentInfo` (core/org.ts) refuses a save that breaks it, and the employee import's file check
 * (core/import.ts analyze) applies the same rule before anything is written, so a Contract row with a missing
 * or inverted date is reported against its row and column instead of cancelling the import while saving.
 * Pure: no database or server imports, so the client and tests can use it too.
 */
export type ContractPeriodColumn='contract_start_date'|'contract_end_date';
export type ContractPeriodIssueCode='required'|'before_hire'|'end_not_after_start';
export type ContractPeriodIssue={column:ContractPeriodColumn;code:ContractPeriodIssueCode;message:string};

/** English text kept identical to the refusals `setEmploymentInfo` has always thrown. */
export const CONTRACT_PERIOD_MESSAGES:Record<ContractPeriodIssueCode,string>={
 required:'Contract start date and contract end date are required for a contract employee.',
 before_hire:'Contract start date cannot be earlier than the hire date.',
 end_not_after_start:'Contract end date must be later than the contract start date.',
};

/**
 * Every way the resulting contract period can be refused, one issue per column.
 *
 * `requireBoth` is the caller's decision: the import requires both dates for every Contract row; the Personnel
 * save requires them only when the submit carries the contract block (so a probation-only save never
 * retro-blocks). Dates are YYYY-MM-DD strings, compared as text (calendar order).
 */
export function contractPeriodIssues(p:{contract:boolean;requireBoth:boolean;hiredOn?:string|null;start?:string|null;end?:string|null}):ContractPeriodIssue[]{
 const issues:ContractPeriodIssue[]=[];
 const start=p.start||null,end=p.end||null,hire=p.hiredOn||null;
 if(p.contract&&p.requireBoth){
  if(!start)issues.push({column:'contract_start_date',code:'required',message:CONTRACT_PERIOD_MESSAGES.required});
  if(!end)issues.push({column:'contract_end_date',code:'required',message:CONTRACT_PERIOD_MESSAGES.required});
 }
 if(start&&hire&&start<hire)issues.push({column:'contract_start_date',code:'before_hire',message:CONTRACT_PERIOD_MESSAGES.before_hire});
 if(start&&end&&end<=start)issues.push({column:'contract_end_date',code:'end_not_after_start',message:CONTRACT_PERIOD_MESSAGES.end_not_after_start});
 return issues;
}
