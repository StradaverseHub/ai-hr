/** Pure selection vocabulary shared by the scoped writer and its client control. */
export const TAX_SELECTION_SCHEMES=['resident','non_resident','rep','knowledge_worker','c_suite'] as const;

/**
 * r393 (685d2380 step 3b) — THE C-SUITE CITIZENSHIP RULE, as a pure predicate so it is stated once.
 * `saveTaxSelectionMYTx` refuses Position C-Suites (`citizenship_unknown`) unless the employee's EPF
 * citizenship is PR or non-citizen; it now asks this. The Create New Employee draft asks the SAME question
 * (through the client pack's `draftTaxResidencyGap`) before `hireEmployee`, because the scoped tax write
 * that would refuse runs only after the employee exists. Every other scheme has no citizenship condition.
 */
export const schemeCitizenshipOk=(scheme:string|null|undefined,citizenship:string|null|undefined):boolean=>
 scheme!=='c_suite'||['pr','non_citizen'].includes(citizenship??'');

/**
 * r393 (685d2380 step 3b) — would the draft's Income Tax Resident choice be refused at Activate? `residency`
 * is the draft's effective value (blank = not chosen, which is never a gap); `epfCitizenship` is what the
 * statutory row will hold (blank = the column default, 'citizen'). Returns the draft field to name, or null.
 */
export function draftTaxResidencyGap(residency:string|null|undefined,epfCitizenship:string|null|undefined):'taxResidency'|null{
 const r=(residency??'').trim();
 if(r==='')return null;
 if(!(TAX_SELECTION_SCHEMES as readonly string[]).includes(r))return 'taxResidency';
 return schemeCitizenshipOk(r,(epfCitizenship??'').trim()||'citizen')?null:'taxResidency';
}
