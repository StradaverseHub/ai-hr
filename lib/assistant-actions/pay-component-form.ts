/** Capture only actual human controls. Structured rule JSON is the native editor's hidden output,
 * not a free-form JSON input. Invalid JSON never silently becomes a fixed pay code. */
import {REVIEWED_PAY_COMPONENT_ACTION,ReviewedPayComponentHumanContent} from './reviewed-pay-component-contract';
export function capturePayComponentHumanForm(form:FormData){
 const text=(name:string)=>{const values=form.getAll(name);if(values.length>1||values.some(value=>typeof value!=='string'))throw Error('Pay-code form unavailable');return String(values[0]??'');},flag=(name:string)=>{const value=text(name);if(value!==''&&value!=='on')throw Error('Pay-code form unavailable');return value==='on';};
 const kind=text('kind'),pcb=flag('includedInPcb'),label=text('label').trim(),rawRule=text('rule'),rule=rawRule?JSON.parse(rawRule):null;
 if(rule?.kind==='per_hour')rule.onlyPullHoursWithinShiftSchedule=flag('onlyPullHoursWithinShiftSchedule');
 return ReviewedPayComponentHumanContent.parse({action:REVIEWED_PAY_COMPONENT_ACTION,contractVersion:1,confirmCatalogCreate:flag('confirmCatalogCreate'),input:{
 code:text('code').trim().toUpperCase(),name:text('name').trim()||label,label,description:text('description').trim()||null,kind,
 includedInEpf:flag('includedInEpf'),includedInSocsoEis:flag('includedInSocsoEis'),includedInPcb:pcb,includedInHrdfBase:flag('includedInHrdfBase'),isNonPayable:kind==='non_payable',prorates:flag('prorates'),
 eaFormLine:text('eaFormLine')||null,roundingMethod:text('roundingMethod'),rule,epfBonus2012:flag('epfBonus2012'),
 pcbRemunerationType:pcb?text('pcbRemunerationType')||null:null,pcbExemptionCode:pcb?text('pcbExemptionCode')||null:null,
 displayCategory:text('displayCategory')||null,orpOvertime:flag('orpOvertime'),orpUnpaidLeave:flag('orpUnpaidLeave'),
 }});
}
