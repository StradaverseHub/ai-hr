/** Read-only reference examples for the Pay Formula Builder (feedback 02472802). Code-owned constants:
 * no database rows, no seed and no tenant writes. "Use as template" only pre-fills a new, unsaved draft;
 * nothing exists until the user saves it under their own Formula ID through savePayFormula. */
export const PAY_FORMULA_TEMPLATE_KEYS=['UNPAID_LEAVE','OT_1_5','OT_2_0','OT_3_0','ABSENT'] as const;
export type PayFormulaTemplateKey=typeof PAY_FORMULA_TEMPLATE_KEYS[number];
const quoted=(text:string)=>'"'+text.replace(/[\r\n]+/g,' ').replaceAll('"','""')+'"';
const daily='Return {#Basic} / {#CalendarDays} * {#Input}';
/** The reporter's overtime wording, including both "return 0" steps for Basic above RM4,000. */
const overtime=(rate:string,note:string)=>[
 'Dim Gross As Decimal = {#Basic} + {#FixedAllowances}',
 'If {#Basic} <= 4000 Then',
 '    {#Explain}('+quoted(note)+' & Gross / 26 / 8)',
 '    Return Gross / 26 / 8 * '+rate+' * {#Input}',
 'ElseIf {#Basic} > 4000 Then',
 '    Return 0',
 'Else',
 '    Return 0',
 'End If',
].join('\n');
const SOURCES:Readonly<Record<PayFormulaTemplateKey,(note:string)=>string>>={
 UNPAID_LEAVE:()=>daily,
 OT_1_5:note=>overtime('1.5',note),
 OT_2_0:note=>overtime('2.0',note),
 OT_3_0:note=>overtime('3.0',note),
 ABSENT:()=>daily,
};
export const isPayFormulaTemplateKey=(value:unknown):value is PayFormulaTemplateKey=>typeof value==='string'&&(PAY_FORMULA_TEMPLATE_KEYS as readonly string[]).includes(value);
/** `note` is the translated text shown by the overtime examples' Explain line (for example "Hourly rate: "). */
export function payFormulaTemplateSource(key:PayFormulaTemplateKey,note:string):string{return SOURCES[key](note);}
