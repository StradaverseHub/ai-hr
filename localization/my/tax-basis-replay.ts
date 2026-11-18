/** Explicit historical tax-input replay. Never executes compensation rules or computes a PCB deduction. */
import {classifyNonCashBenefit,createNonCashOwnershipReplay,readPcbNonCash,NonCashBenefitConfigurationError,type NonCashEntry,type NonCashEaEntry,type PcbNonCashSnapshot} from '../noncash-benefits';
import type {TaxBasisItem,TaxBasisValue} from '../../lib/payroll-tax-basis';
import type {StatutoryRuleset} from './statutory-tables';
export class TaxBasisReplayError extends Error {constructor(message:string){super(message);this.name='TaxBasisReplayError';}}
export type TaxBasisItemSetting={id:string;code:string;name:string;kind:string;includedInPcb:boolean;pcbRemunerationType:'normal'|'additional'|'optional_deduction'|null;pcbExemptionCode:string|null;isNonPayable:boolean;epfBonus2012:boolean;archivedAt?:unknown;displayCategory?:string|null;eaFormLine?:string|null};
export type TaxBasisSourceSlip={id:string;period:string;runOrder:number;sourceKind?:'import'|'native';sourceLines:{code:string;amount:number;direction:'earning'|'deduction'|'noncash';settingId?:string;rowNum?:number;nonCashSource?:{source:'recurring'|'one_off';sourceId?:string};previousTreatment?:string|null}[];statutory:Record<string,unknown>;expectedGross:number;expectedOtherDeductions:number};
export type TaxBasisReplayInput={year:number;upToMonth:number;slips:TaxBasisSourceSlip[];settings:TaxBasisItemSetting[];rulesByPeriod:Record<string,{rules:StatutoryRuleset;hash:string}>;openingExemptionUsed:Record<string,number>;nonCashPrefixComplete?:boolean};
export type TaxBasisReplayRow={payslipId:string;period:string;basis:TaxBasisValue};
function fail(message:string):never{throw new TaxBasisReplayError(message);}
const round=(n:number)=>Math.round(n*100)/100;
function money(value:unknown,label:string):number{if(typeof value!=='number'||!Number.isFinite(value)||value<0||!Number.isSafeInteger(Math.round(value*100))||Math.abs(value*100-Math.round(value*100))>1e-6)fail(`${label}: an exact non-negative monetary amount is required.`);return value as number;}
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** One annual ledger shared by normal/additional remuneration and every source item in stable run order. */
export function replayMyTaxBasis(input:TaxBasisReplayInput):TaxBasisReplayRow[]{
 if(!Number.isInteger(input.year)||input.year<1900||!Number.isInteger(input.upToMonth)||input.upToMonth<1||input.upToMonth>12)fail('Choose a valid assessment year and final month.');
 const settings=new Map<string,TaxBasisItemSetting>();
 for(const setting of input.settings){const code=setting.code.trim().toUpperCase();if(!code||settings.has(code))fail('Pay Item codes are missing or ambiguous.');settings.set(code,setting);}
 const used:Record<string,number>={};for(const [code,amount]of Object.entries(input.openingExemptionUsed))used[code]=money(amount,`Opening exemption ${code}`);
 const seen=new Set<string>(),order=new Set<string>();
 const slips=[...input.slips].sort((a,b)=>a.period.localeCompare(b.period)||a.runOrder-b.runOrder||a.id.localeCompare(b.id));
 if(!slips.length)fail('No saved history is available for this employee.');
 const nonCashReplay=createNonCashOwnershipReplay(input.nonCashPrefixComplete??true);
 return slips.map(slip=>{
  if(seen.has(slip.id))fail('A source payroll record appears more than once.');seen.add(slip.id);
  if(!new RegExp(`^${input.year}-(0[1-9]|1[0-2])$`).test(slip.period)||Number(slip.period.slice(5))>input.upToMonth)fail('A source period is outside the reviewed selection.');
  if(!Number.isInteger(slip.runOrder)||slip.runOrder<0||order.has(`${slip.period}:${slip.runOrder}`))fail('Payroll run order is missing or ambiguous.');order.add(`${slip.period}:${slip.runOrder}`);
  const resolution=input.rulesByPeriod[slip.period];
  if(!resolution?.hash||!resolution.rules.pcbExemptions)fail(`${slip.period}: year-specific exemption rules are unavailable.`);
  const declaredYears:string[]=resolution.rules.version.match(/20\d{2}/g)??[];
  if(declaredYears.length&&!declaredYears.includes(String(input.year)))fail(`${slip.period}: the resolved statutory rules belong to a different assessment year.`);
  const tables=resolution.rules.pcbExemptions;
  if(!Array.isArray(slip.sourceLines)||!slip.sourceLines.length)fail(`${slip.period}: original Pay Item lines are unavailable.`);
  // An owned noncash allocation must remain under its original owner; never tax an informational line.
  const nc=slip.statutory.pcbNonCash;
  if(nc!==undefined&&!readPcbNonCash(nc))fail(`${slip.period}: original noncash ownership is malformed.`);
  const nonCashEntries:NonCashEntry[]=[],nonCashEaEntries:NonCashEaEntry[]=[];
  let earned=0,deducted=0,normal=0,additional=0,exempt=0,declaredLp=0,pcbDeduct=0;
  const exemptionUsed:Record<string,number>={},oneOffExemptionUsed:Record<string,number>={},items:TaxBasisItem[]=[];
  const consume=(code:string,amount:number,table:'pcb'|'lp')=>{
   if(!Object.prototype.hasOwnProperty.call(tables[table],code))fail(`${slip.period}: exemption ${code} is unsupported for this assessment year.`);
   const cap=tables[table][code];if(!Number.isFinite(cap))fail('The exemption limit is malformed.');
   const allowed=round(Math.min(amount,cap<0?amount:Math.max(0,round(cap-(used[code]??0)))));
   if(allowed>0){used[code]=round((used[code]??0)+allowed);exemptionUsed[code]=round((exemptionUsed[code]??0)+allowed);}return allowed;
  };
  for(const line of slip.sourceLines){
   const amount=money(line.amount,`${slip.period} ${line.code}`),setting=settings.get(line.code.trim().toUpperCase());
   if(!setting||setting.archivedAt!=null||line.settingId!==undefined&&line.settingId!==setting.id)fail(`${slip.period}: ${line.code} has missing, archived or unsupported Pay Item ownership.`);
   if(line.direction==='noncash'){
    if(!setting.isNonPayable||line.settingId!==setting.id||!Number.isInteger(line.rowNum))fail(`${slip.period}: ${line.code} requires exact noncash source ownership.`);
    const kind=classifyNonCashBenefit({code:setting.code,kind:setting.kind,nonPayable:true,pcb:setting.includedInPcb,displayCategory:setting.displayCategory,eaFormLine:setting.eaFormLine,pcbRemunerationType:setting.pcbRemunerationType,epfBonus2012:setting.epfBonus2012});
    if(!kind)fail(`${slip.period}: ${line.code} has no supported BIK/VOLA classification.`);
    const itemExempt=setting.includedInPcb&&setting.pcbExemptionCode?consume(setting.pcbExemptionCode,amount,'pcb'):0;
    const taxable=setting.includedInPcb?round(amount-itemExempt):0;
    if(!line.nonCashSource&&slip.sourceKind!=='import')fail(`${slip.period}: ${line.code} original noncash source identity is unavailable.`);
    const source=line.nonCashSource??{source:'one_off' as const,sourceId:`${slip.id}:row:${line.rowNum}`};
    if(setting.includedInPcb)nonCashEntries.push({kind,code:setting.code,...source,entered:amount,exempt:itemExempt,taxable,...(setting.pcbExemptionCode?{exemptionCode:setting.pcbExemptionCode}:{})});
    nonCashEaEntries.push({kind,code:setting.code,...source,entered:amount,reportableAmount:setting.includedInPcb?taxable:amount,exemptAmount:itemExempt,eaFormLine:setting.eaFormLine??null,subjectPCB:setting.includedInPcb,...(setting.pcbExemptionCode?{exemptionCode:setting.pcbExemptionCode}:{})});
    exempt=round(exempt+itemExempt);items.push({code:setting.code,name:setting.name,amount,previousTreatment:line.previousTreatment??null,latestTreatment:`Non-cash ${kind.toUpperCase()} · ${setting.includedInPcb?'Taxable':'Non-Taxable'}`,taxable,exempt:itemExempt});continue;
   }
   if(setting.isNonPayable)fail(`${slip.period}: ${line.code} cannot be treated as cash.`);
   if(line.direction!=='earning'&&line.direction!=='deduction')fail('Source Pay Item direction is unavailable.');
   if((setting.kind==='deduction')!==(line.direction==='deduction'))fail(`${slip.period}: ${line.code} changed its monetary kind.`);
   if(line.direction==='earning')earned=round(earned+amount);else deducted=round(deducted+amount);
   let taxable=0,itemExempt=0,latestTreatment='Non-Taxable';
   const stream=setting.epfBonus2012?'additional':setting.pcbRemunerationType;
   if(setting.includedInPcb){
    if(!stream)fail(`${slip.period}: ${line.code} needs an explicit supported tax classification.`);
    if(stream==='optional_deduction'){
     if(!setting.pcbExemptionCode?.startsWith('LP_'))fail(`${slip.period}: ${line.code} needs a supported optional-deduction code.`);
     declaredLp=round(declaredLp+consume(setting.pcbExemptionCode,amount,'lp'));latestTreatment=`Optional deduction · ${setting.pcbExemptionCode}`;
    }else if(line.direction==='deduction'){pcbDeduct=round(pcbDeduct+amount);latestTreatment='Taxable remuneration deduction';}
    else{
     if(setting.pcbExemptionCode){if(!setting.pcbExemptionCode.startsWith('PCB_'))fail('The exemption classification conflicts with the remuneration stream.');itemExempt=consume(setting.pcbExemptionCode,amount,'pcb');}
     if(slip.sourceKind==='import'&&stream==='additional'&&setting.pcbExemptionCode&&itemExempt>0)oneOffExemptionUsed[setting.pcbExemptionCode]=round((oneOffExemptionUsed[setting.pcbExemptionCode]??0)+itemExempt);
     taxable=round(amount-itemExempt);if(stream==='normal')normal=round(normal+taxable);else additional=round(additional+taxable);
     latestTreatment=`${itemExempt===amount?'Tax-Exempt':'Taxable'} · ${stream}${setting.pcbExemptionCode?' · '+setting.pcbExemptionCode:''}`;
    }
   }else if(line.direction==='earning')itemExempt=amount;
   if(line.direction==='earning')exempt=round(exempt+itemExempt);
   items.push({code:setting.code,name:setting.name,amount,previousTreatment:line.previousTreatment??null,latestTreatment,taxable,exempt:itemExempt});
  }
  if(earned!==money(slip.expectedGross,'Original gross')||deducted!==money(slip.expectedOtherDeductions,'Original deductions'))fail(`${slip.period}: source Pay Item amounts do not reconcile to original payroll totals.`);
  if(pcbDeduct>normal)fail(`${slip.period}: taxable deductions exceed supported normal remuneration.`);normal=round(normal-pcbDeduct);
  let preservedLp=money(slip.statutory.lp??0,'Original relief');
  if(preservedLp>0){const detail=slip.statutory.lpDetail;if(!obj(detail)||typeof detail.tp1!=='number')fail(`${slip.period}: the original relief and Pay Item deduction split is unavailable.`);preservedLp=money(detail.tp1,'Saved TP1 relief');}
  const savedNonCash=readPcbNonCash(nc);
  let nonCash:PcbNonCashSnapshot;
  try{nonCash=nonCashReplay({period:slip.period,cashNormal:normal,owned:nonCashEntries,ownedEa:nonCashEaEntries,original:savedNonCash,completeSource:slip.sourceKind==='import'||savedNonCash!==null});}
  catch(error){fail(`${slip.period}: ${error instanceof NonCashBenefitConfigurationError?error.componentCode:'Noncash'} original month source ownership is incomplete or duplicated.`);}

  const basis:TaxBasisValue={version:1,period:slip.period,pcb:round(normal+additional),normal,additional,exempt,lp:round(preservedLp+declaredLp),exemptionUsed,items,rulesHash:resolution.hash,...(slip.sourceKind==='import'?{oneOffExemptionUsed}:{}),...((nonCash.eaEntries.length||savedNonCash)?{pcbNonCash:nonCash}:{})};
  return {payslipId:slip.id,period:slip.period,basis};
 });
}
