/** Pure selection vocabulary shared by the scoped writer and its client control. */
export const TAX_SELECTION_SCHEMES=['resident','non_resident','rep','knowledge_worker','c_suite','custom_fixed','custom_rate'] as const;

/**
 * ADR 0183 (board d8dc0a8c) — the two HR-chosen custom PCB methods. Each carries one HR-entered number on the
 * employer-scoped selection: custom_fixed an RM amount, custom_rate a percentage. Neither is a residency, so
 * neither is offered where no number can be entered (Create New Employee draft, Excel imports).
 */
export const CUSTOM_PCB_SCHEMES=['custom_fixed','custom_rate'] as const;
export type CustomPcbScheme=(typeof CUSTOM_PCB_SCHEMES)[number];
export const isCustomPcbScheme=(scheme:unknown):scheme is CustomPcbScheme=>
 typeof scheme==='string'&&(CUSTOM_PCB_SCHEMES as readonly string[]).includes(scheme);
/** The custom number as saved: RM for custom_fixed, percent for custom_rate; null for every other scheme. */
export type CustomPcbValue={amount:number|null;rate:number|null};
/**
 * Reads the HR-entered number for a custom scheme. Plain decimal text only (no grouping, sign or exponent), at
 * most two decimals; an amount above RM0 that fits numeric(12,2), a rate above 0% and at most 100%. Any other
 * scheme must arrive without a number. Returns null when the input is not acceptable — the writer refuses then.
 */
export function customPcbValueOf(scheme:string,raw:unknown):CustomPcbValue|null{
 const text=raw==null?'':String(raw).trim();
 if(!isCustomPcbScheme(scheme))return text===''?{amount:null,rate:null}:null;
 if(!/^\d{1,10}(\.\d{1,2})?$/.test(text))return null;
 const value=Number(text);
 if(!Number.isFinite(value)||value<=0)return null;
 if(scheme==='custom_rate')return value<=100?{amount:null,rate:value}:null;
 return {amount:value,rate:null};
}

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
 // A custom PCB method needs its HR-entered number, which only the employee's Income Tax card can carry.
 if(isCustomPcbScheme(r)||!(TAX_SELECTION_SCHEMES as readonly string[]).includes(r))return 'taxResidency';
 return schemeCitizenshipOk(r,(epfCitizenship??'').trim()||'citizen')?null:'taxResidency';
}
