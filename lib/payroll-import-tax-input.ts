/** Deterministic imported-source ownership. No employee profile, pay calculation or write capability. */
import {classifyNonCashBenefit} from '../localization/noncash-benefits';
import type {ImportCodeEntry} from './payroll-history-import-schema';
import type {TaxBasisItemSetting} from '../localization/country-pack';
export type ImportedTaxLine={rowNum:number;originalCode:string;code:string;settingId:string;amount:number;direction:'earning'|'deduction'|'noncash';nonCashSource?:{source:'recurring'|'one_off';sourceId?:string}};
export type ImportedTaxSetting=TaxBasisItemSetting&{displayCategory?:string|null;eaFormLine?:string|null};
export class ImportedTaxSourceError extends Error{constructor(message:string){super(message);this.name='ImportedTaxSourceError';}}
export const SYSTEM_BASIC_TAX_SETTING:ImportedTaxSetting={id:'system-basic-salary',code:'BASIC',name:'Basic salary',kind:'allowance',includedInPcb:true,pcbRemunerationType:'normal',pcbExemptionCode:null,isNonPayable:false,epfBonus2012:false,archivedAt:null};
const up=(s:string)=>s.trim().toUpperCase();
export function importedTaxInput(rows:readonly{rowNum:number;code:string;amount:number}[],codes:ReadonlyMap<string,ImportCodeEntry>,settings:readonly ImportedTaxSetting[]):ImportedTaxLine[]{
 const result:ImportedTaxLine[]=[];
 for(const row of rows){
  const entry=codes.get(up(row.code));if(!entry)throw new ImportedTaxSourceError(`Row ${row.rowNum}: ${row.code} has no active import mapping.`);
  if(['epf_employee','epf_employer','socso_employee','socso_employer','socso_skbbk','eis_employee','eis_employer','pcb','cp38','zakat','lp','hrdf','gross','net'].includes(entry.destination))continue;
  const target=entry.targetCode??entry.code,candidates=settings.filter(setting=>up(setting.code)===up(target));
  // BASIC is an explicit built-in salary-field owner, not a fallback for an arbitrary earning.
  const setting=candidates.length===0&&entry.basicSalaryOwner===true?SYSTEM_BASIC_TAX_SETTING:candidates.length===1?candidates[0]:null;
  if(!setting||setting.archivedAt!=null)throw new ImportedTaxSourceError(`Row ${row.rowNum}: ${row.code} has missing, archived or ambiguous Pay Item ownership (${target}).`);
  if(!Number.isFinite(row.amount)||row.amount<0||!Number.isSafeInteger(Math.round(row.amount*100))||Math.abs(row.amount*100-Math.round(row.amount*100))>1e-6)throw new ImportedTaxSourceError(`Row ${row.rowNum}: ${row.code} has an inexact amount.`);
  if(setting.isNonPayable){
   let benefit;try{benefit=classifyNonCashBenefit({code:setting.code,kind:setting.kind,nonPayable:true,pcb:setting.includedInPcb,displayCategory:setting.displayCategory,eaFormLine:setting.eaFormLine,pcbRemunerationType:setting.pcbRemunerationType,epfBonus2012:setting.epfBonus2012});}catch{throw new ImportedTaxSourceError(`Row ${row.rowNum}: ${row.code} has conflicting BIK/VOLA ownership.`);}
   if(!benefit)throw new ImportedTaxSourceError(`Row ${row.rowNum}: ${row.code} has no supported BIK/VOLA ownership.`);
  }
  const direction=setting.isNonPayable?'noncash':setting.kind==='deduction'?'deduction':'earning';
  if(!setting.isNonPayable&&((entry.destination==='other_deduction')!==(direction==='deduction')))throw new ImportedTaxSourceError(`Row ${row.rowNum}: ${row.code} import direction conflicts with its Pay Item.`);
  result.push({rowNum:row.rowNum,originalCode:row.code,code:setting.code,settingId:setting.id,amount:row.amount,direction});
 }
 return result;
}
