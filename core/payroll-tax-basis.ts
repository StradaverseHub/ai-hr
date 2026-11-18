/** Authorized, explicit historical tax-input corrections; original payslips are immutable inputs. */
import {importedTaxSettingsTx,importedTaxNeedsOpening,importedTaxRulesStatesTx,importedTaxSettingEvidence} from './payroll-import-tax-source';
import {maintenanceTaxInput} from '../lib/payroll-history-maintenance-tax-input';
import {effectiveHistoryItems} from '../lib/payroll-history-maintenance-lineage';
import type {HistoryRevisionRow} from '../lib/payroll-history-revisions';
import {importedTaxInput,SYSTEM_BASIC_TAX_SETTING,type ImportedTaxSetting} from '../lib/payroll-import-tax-input';
import {readPcbNonCash} from '../localization/noncash-benefits';
import {resolveTaxOpeningEvidence} from '../lib/payroll-tax-opening-evidence';
import {resolveImportCodes} from './payroll-history-import';
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {requirePackFor} from '../localization/registry';
import type {StatutoryRuleset} from '../localization/country-pack';
import {readHistoryField} from '../lib/payroll-history-import-schema';
import {PayrollTaxBasisError,type TaxBasisSelection,type TaxBasisPreview,type TaxBasisEmployee,type TaxBasisMonth,type TaxBasisValue,type TaxBasisBatch} from '../lib/payroll-tax-basis';
import {assertModuleGate} from './module-gate';
import {lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx,lockPayrollHistoryWriteTx} from './payroll-history-lock';
import {resolvePayrollPermission,parsePayrollHistorySource,markBatchNeedsRecalc} from '../packs/payroll/service';
import {taxBasisSourceRowsTx,hashTaxBasisSource as importedSourceHash,readEffectiveTaxBasesTx,validatedTaxBasis} from './payroll-tax-basis-read';
const uuidArray=(ids:string[])=>sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_key,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function fail(s:string):never{throw new PayrollTaxBasisError(s);}
const nonCashInputs=(value:unknown)=>{const saved=readPcbNonCash(value);return saved?{owned:saved.owned,entries:saved.ownedEntries.map(({sourceId,source,...entry})=>entry),ea:saved.ownedEaEntries.map(({sourceId,source,...entry})=>entry)}:{owned:{bik:0,vola:0},entries:[],ea:[]};};
const round=(n:number)=>Math.round(n*100)/100;
const money=(v:unknown):number|null=>{if(typeof v!=='number'&&typeof v!=='string')return null;if(typeof v==='string'&&!v.trim())return null;const n=Number(v);return Number.isFinite(n)&&n>=0&&Number.isSafeInteger(Math.round(n*100))&&Math.abs(n*100-Math.round(n*100))<1e-6?n:null;};
function validateSelection(v:TaxBasisSelection){if(!v||!uuid.test(v.companyId)||!Number.isInteger(v.year)||v.year<1900||v.year>2999||!Number.isInteger(v.upToMonth)||v.upToMonth<1||v.upToMonth>12||v.employmentIds!==null&&(!Array.isArray(v.employmentIds)||!v.employmentIds.length||v.employmentIds.length>1000||v.employmentIds.some(id=>!uuid.test(id))||new Set(v.employmentIds).size!==v.employmentIds.length))fail('Choose a company, assessment year, final month and valid employees.');}
async function permission(tx:Tx,ctx:SessionContext,companyId:string,write=false){
 assertModuleGate(ctx,'payroll');
 if(write&&!await resolvePayrollPermission(tx,ctx,'payroll.tax-basis.view',companyId))fail('Income-tax recalculation access is unavailable for this company.');
 if(!ctx.userId||!await resolvePayrollPermission(tx,ctx,write?'payroll.tax-basis.recalculate':'payroll.tax-basis.view',companyId))fail('Income-tax recalculation access is unavailable for this company.');
 const [authority]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() and app.can_admin_payroll_for(${companyId}::uuid) as ok`);
 if(!authority?.ok)fail('Your payroll authority changed. Sign in again.');
}
type Settings=ImportedTaxSetting;
async function settingsTx(tx:Tx,lock=false){if(lock)await tx.execute(sql`select id from pay_component order by id for share`);return importedTaxSettingsTx(tx);}
const basicSetting=SYSTEM_BASIC_TAX_SETTING;
type SourceSlip={id:string;period:string;runOrder:number;gross:string;deductions:string;basic:string;allowance:string;overtime:string;bonus:string;statutory:Record<string,unknown>;historyAttemptId:string|null;cycleId:string|null};
type InputLine={code:string;amount:number;direction:'earning'|'deduction'|'noncash';settingId?:string;rowNum?:number;nonCashSource?:{source:'recurring'|'one_off';sourceId?:string};previousTreatment?:string|null};
type SourceCache=Map<string,{retained:{name:string;sourceHash:string;rows:HistoryRevisionRow[]};rows:Awaited<ReturnType<typeof parsePayrollHistorySource>>}>&{codes?:Awaited<ReturnType<typeof resolveImportCodes>>;slips?:Map<string,SourceSlip[]>;country?:string;rules?:Map<string,Awaited<ReturnType<ReturnType<typeof requirePackFor>['payroll']['loadRulesetResolved']>>>;sourceHashes?:Map<string,string>;effective?:Awaited<ReturnType<typeof readEffectiveTaxBasesTx>>|null;superseded?:Map<string,string[]>;rulesStates?:Awaited<ReturnType<typeof importedTaxRulesStatesTx>>};
async function linesTx(tx:Tx,slip:SourceSlip,employmentId:string,companyId:string,settings:Settings[],cache:SourceCache,ctx:SessionContext):Promise<InputLine[]>{
 if(slip.historyAttemptId){
  let cached=cache.get(slip.historyAttemptId);
  if(!cached){const [retained]=await tx.execute<{name:string;content:Buffer;sourceHash:string;rows:HistoryRevisionRow[]}>(sql`select a.source_name as name,a.source_content as content,a.source_hash as "sourceHash",a.plan->'rows' as rows from payroll_history_import_attempt a where a.id=${slip.historyAttemptId}::uuid`);
  if(!retained||createHash('sha256').update(retained.content).digest('hex')!==retained.sourceHash)fail(`${slip.period}: retained import source is unavailable or changed.`);
  cached={retained,rows:await parsePayrollHistorySource(retained.name,retained.content)};cache.set(slip.historyAttemptId,cached);}
  const {retained,rows}=cached;
  const plans=retained.rows.filter(r=>r.companyId===companyId&&r.employmentId===employmentId&&r.period===slip.period&&r.cycleId===slip.cycleId);
  if(plans.length!==1||!Array.isArray(plans[0].rowNums)||!plans[0].rowNums.length)fail(`${slip.period}: original source row binding is unavailable.`);
  const merged=slip.statutory.historyMaintenance;
  if(object(merged)){
   const accepted=plans[0];
   if(merged.version!==1||!Array.isArray(merged.items)||!accepted.contributions||canonical(merged.items)!==canonical(effectiveHistoryItems(accepted.contributions))||!accepted.values||accepted.valueHash!==hash(accepted.values)||canonical(accepted.values.statutory)!==canonical(slip.statutory)||accepted.values.basicSalary!==slip.basic||accepted.values.allowance!==slip.allowance||accepted.values.overtimePay!==slip.overtime||accepted.values.bonus!==slip.bonus||accepted.values.grossPay!==slip.gross||accepted.values.otherDeductions!==slip.deductions)fail(`${slip.period}: accepted merged item ownership does not match its immutable source.`);
   const stamp=slip.statutory.importedTaxBasis;
   return maintenanceTaxInput(effectiveHistoryItems(accepted.contributions),settings,object(stamp)?stamp.lines:undefined);
  }
  cache.codes??=await resolveImportCodes(ctx,tx);
  const sourceRows=plans[0].rowNums.map(rowNum=>{const row=rows[rowNum-2];if(!row)fail(`${slip.period}: an original source row is missing.`);const amount=money(readHistoryField(row,'amount').replace(/[,_\s]/g,''));if(amount===null)fail(`${slip.period}: an original amount is not exact.`);return{rowNum,code:readHistoryField(row,'doe_code'),amount};});
  const lines=importedTaxInput(sourceRows,cache.codes,settings);
  const stamp=slip.statutory.importedTaxBasis;
  if(object(stamp)&&Array.isArray(stamp.lines))for(const line of lines){const saved=stamp.lines.find((saved:unknown)=>object(saved)&&saved.rowNum===line.rowNum);if(!object(saved)||saved.settingId!==line.settingId||saved.code!==line.code||saved.amount!==line.amount)fail(`${slip.period}: original Pay Item identity changed for ${line.originalCode}. Review its import mapping.`);if(line.direction==='noncash'){if(!object(saved.nonCashSource)||saved.nonCashSource.source!=='one_off'||typeof saved.nonCashSource.sourceId!=='string'||!/^import:[a-f0-9]{64}$/.test(saved.nonCashSource.sourceId))fail(`${slip.period}: original noncash source ownership is unavailable.`);line.nonCashSource={source:'one_off',sourceId:saved.nonCashSource.sourceId};}}
  return lines;

 }
 // Ordinary results must have complete itemized cash evidence. Basic is its saved paid field,
 // not today's compensation. Noncash and unsupported statutory provenance are refused by the pack.
 const componentLines=slip.statutory.componentLines;
 if(!Array.isArray(componentLines))fail(`${slip.period}: original Pay Item detail was not saved.`);
 const out:InputLine[]=[];let basicIncluded=false;
 for(const raw of componentLines){
  if(!object(raw)||typeof raw.code!=='string'||!Array.isArray(raw.buckets))fail(`${slip.period}: original Pay Item ownership is incomplete.`);
  const setting=settings.find(s=>s.code===raw.code);if(!setting)fail(`${slip.period}: ${raw.code} has no exact current Pay Item.`);
  let amount=0,direction:'earning'|'deduction'|null=null;
  for(const b of raw.buckets){if(!object(b)||typeof b.bucket!=='string'||!['wage','ot','bonus','reimburse','deduct'].includes(b.bucket))fail('Original cash bucket is unsupported.');const n=money(b.amount);if(n===null)fail('Original cash amount is malformed.');const next=b.bucket==='deduct'?'deduction':'earning';if(direction&&direction!==next)fail('A source item mixes monetary directions.');direction=next;amount=round(amount+n);}
  if(direction===null)fail('Original Pay Item contribution is unavailable.');
  if(raw.code==='BASIC')basicIncluded=true;
  out.push({code:raw.code,amount,direction});
 }
 const nc=readPcbNonCash(slip.statutory.pcbNonCash);
 if(nc)for(const [index,entry] of nc.ownedEaEntries.entries()){const setting=settings.find(setting=>setting.code===entry.code);if(!setting)fail(`${slip.period}: ${entry.code} original noncash Pay Item is unavailable.`);out.push({code:entry.code,amount:entry.entered,direction:'noncash',settingId:setting.id,rowNum:1000000+index,nonCashSource:{source:entry.source,...(entry.sourceId?{sourceId:entry.sourceId}:{})}});}
 if(!basicIncluded&&Number(slip.basic)!==0){if(settings.some(s=>s.code==='BASIC'&&s.id!=='system-basic-salary'))fail(`${slip.period}: the original basic Pay Item identity is unavailable.`);out.unshift({code:'BASIC',amount:Number(slip.basic),direction:'earning'});}
 return out;
}
async function employeeTx(tx:Tx,ctx:SessionContext,selection:TaxBasisSelection,who:{id:string;employeeNo:string;name:string},settings:Settings[],settingsHash:string,cache:SourceCache=new Map()):Promise<TaxBasisEmployee>{
 let pcbComparison:TaxBasisEmployee['pcbComparison'];
 const blocked=(reason:string):TaxBasisEmployee=>({...who,...(pcbComparison?{pcbComparison}:{}),status:'blocked',reason,recordCount:0,beforeTaxable:null,difference:null,taxable:null,beforeExempt:null,exempt:null,months:[]});
 try{
  const slips=cache.slips?.get(who.id)??await tx.execute<SourceSlip>(sql`select p.id,b.pay_period as period,(row_number() over(partition by b.pay_period order by b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id))::integer as "runOrder",p.gross_pay as gross,p.basic_salary as basic,p.allowance,p.overtime_pay as overtime,p.bonus,p.other_deductions as deductions,p.statutory,case when app.payroll_history_native_baseline(p.id) then null else b.history_import_attempt_id end as "historyAttemptId",b.payroll_cycle_id as "cycleId" from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=${who.id}::uuid and b.company_id=${selection.companyId}::uuid and b.pay_period like ${selection.year+'-%'} and b.status in ('processed','closed') order by b.pay_period,b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id`);
  const cutoff=selection.year+'-'+String(selection.upToMonth).padStart(2,'0'),included=slips.filter(s=>s.period<=cutoff);
  if(included.some(slip=>slip.historyAttemptId)){const paid=included.map(slip=>money(slip.statutory.pcb));pcbComparison={state:'unavailable',originalPaid:paid.some(value=>value===null)?null:round(paid.reduce<number>((sum,value)=>sum+(value??0),0)),missingInputs:['originalStatutoryInputs','originalTaxCategoryAndReliefs','originalPriorEmployerIncome']};}
  if(!included.length)return blocked('No saved payroll history exists in the selected period.');
  // A changed exemption/relief prefix cannot silently reallocate a later saved month.
  const country=cache.country??(await tx.execute<{country:string}>(sql`select country from company where id=${selection.companyId}::uuid`))[0].country;
  const pack=requirePackFor(country);if(!pack.payroll.replayTaxBasis)fail('This country pack does not support historical income-tax corrections.');
  const ruleStates=cache.rulesStates??await importedTaxRulesStatesTx(tx,[...new Set(included.map(slip=>slip.period))]);
  const rulesByPeriod:Record<string,{rules:StatutoryRuleset;hash:string}>={},rulesEvidence:Record<string,unknown>={};
  for(const period of [...new Set(included.map(s=>s.period))]){
   cache.rules??=new Map();
   const resolved=cache.rules.get(period)??await pack.payroll.loadRulesetResolved(tx,{asOf:period+'-01'});cache.rules.set(period,resolved);
   if(!resolved.version.startsWith(String(selection.year)+'.'))fail(`${period}: verified assessment-year rules are unavailable.`);
   rulesByPeriod[period]={rules:resolved.ruleset,hash:hash(resolved)};rulesEvidence[period]={version:resolved.version,source:resolved.source,effectiveFrom:resolved.effectiveFrom,packVersion:resolved.packVersion,signedKeyId:resolved.signedKeyId,pcbExemptions:resolved.ruleset.pcbExemptions};
  }
  const input:Parameters<typeof pack.payroll.replayTaxBasis>[0]['slips']=[];
  for(const slip of included)input.push({id:slip.id,period:slip.period,runOrder:slip.runOrder,sourceKind:slip.historyAttemptId?'import' as const:'native' as const,sourceLines:await linesTx(tx,slip,who.id,selection.companyId,settings,cache,ctx),statutory:slip.statutory,expectedGross:Number(slip.gross),expectedOtherDeductions:Number(slip.deductions)});
  const hashes=cache.sourceHashes??new Map((await taxBasisSourceRowsTx(tx,slips.map(slip=>slip.id))).map(source=>[source.id,importedSourceHash(source)]));
  const capped=input.some(row=>importedTaxNeedsOpening(row.sourceLines.map((line,index)=>({...line,originalCode:line.code,rowNum:line.rowNum??index,settingId:line.settingId??settings.find(setting=>setting.code===line.code)?.id??''})),settings,rulesByPeriod[row.period].rules));
  const opening=resolveTaxOpeningEvidence({year:selection.year,employmentId:who.id,companyId:selection.companyId,required:capped,requiredSourceIds:included.map(slip=>slip.id),sources:slips.map(slip=>({id:slip.id,sourceHash:hashes.get(slip.id)!,statutory:slip.statutory}))});
  const partialMonths=()=>input.map(row=>({payslipId:row.id,period:row.period,items:row.sourceLines.map(line=>{const setting=settings.find(setting=>setting.code===line.code)!;return{code:line.code,name:setting.name,amount:line.amount,direction:line.direction,includedInPcb:setting.includedInPcb,remunerationType:setting.pcbRemunerationType,exemptionCode:setting.pcbExemptionCode};})}));
  const heldDetail=(reason:string,field:string,affects:string[]):TaxBasisEmployee=>({...blocked(reason),recordCount:included.length,partialMonths:partialMonths(),missingEvidence:[{field,affects,reason}]});
  if(opening.state!=='known')return heldDetail(opening.reason,'priorEmployerExemptionUsage',['taxableWages','exemptWages','optionalDeductions','pcbComparison']);
  const openingExemptionUsed=opening.used;
  let replay:ReturnType<typeof pack.payroll.replayTaxBasis>;
  try{replay=pack.payroll.replayTaxBasis({year:selection.year,upToMonth:selection.upToMonth,slips:input,settings,rulesByPeriod,openingExemptionUsed});}
  catch(error){
   if(!(error instanceof Error)||error.name!=='TaxBasisReplayError')throw error;
   const noncash=/noncash/i.test(error.message),deduction=/relief|deduction split/i.test(error.message);
   return heldDetail(error.message,noncash?'nonCashSourceOwnership':deduction?'optionalDeductionOwnership':'historicalTaxInputs',noncash?['noncashWages','pcbComparison']:deduction?['optionalDeductions','pcbComparison']:['taxableWages','exemptWages','pcbComparison']);
  }
  let effective:Awaited<ReturnType<typeof readEffectiveTaxBasesTx>>|null=null;
  // A fresh correction may explicitly supersede a stale source. It must still be exactly reconstructible.
  try{effective=cache.effective!==undefined?cache.effective:await readEffectiveTaxBasesTx(tx,ctx,included.map(s=>s.id));}catch(error){if(!(error instanceof PayrollTaxBasisError)||!error.message.startsWith('Saved payroll changed')&&!error.message.startsWith('Imported wage inputs require review'))throw error;}
  let superseded=cache.superseded;
  if(!superseded){
   superseded=new Map();
   const rows=await tx.execute<{sourceId:string;id:string}>(sql`select current_source.id as "sourceId",r.id from payslip current_source join payroll_batch b on b.id=current_source.batch_id join payroll_tax_basis_revision r on r.company_id=b.company_id and r.employment_id=current_source.employment_id and r.period=b.pay_period where current_source.id=any(${uuidArray(included.map(slip=>slip.id))}) and (r.payslip_id=current_source.id or r.payslip_id in(select previous.id from payroll_history_import_snapshot previous join payroll_history_import_snapshot current on current.record_id=previous.record_id where current.id=current_source.id)) order by current_source.id,r.id`);
   for(const row of rows)superseded.set(row.sourceId,[...(superseded.get(row.sourceId)??[]),row.id]);
  }
  const months:TaxBasisMonth[]=[];let ytdTaxable=0,ytdExempt=0;
  for(const row of replay){
   const source=included.find(s=>s.id===row.payslipId)!;
   const prior=effective?.get(source.id)?.basis,st=source.statutory;
   const imported=object(st.importedTaxBasis)&&st.importedTaxBasis.state==='ready'?validatedTaxBasis(st.importedTaxBasis.basis):null;
   const previous=prior??imported;
   const beforeTaxable=previous?.pcb??(object(st.bases)?money(st.bases.pcb):null),beforeExempt=previous?money(previous.exempt):object(st.exemptionUsed)?round(Object.entries(st.exemptionUsed).filter(([code])=>code.startsWith('PCB_')).reduce((n,[,v])=>n+(money(v)??0),0)):null;
   const exempt=money(row.basis.exempt);if(exempt===null)fail('The country pack did not return exact exemption evidence.');
   const old=(superseded.get(source.id)??[]).map(id=>({id}));
   const items=row.basis.items.map((item,index)=>{const saved=previous?.items[index];return {...item,previousTreatment:saved?.code===item.code&&saved.amount===item.amount?saved.latestTreatment:item.previousTreatment};});
   const basis:TaxBasisValue={...validatedTaxBasis(row.basis),items,supersedes:old.map(r=>r.id),settingsHash,appliedSettings:settings.filter(setting=>row.basis.items.some(item=>item.code===setting.code)),rulesEvidence:rulesEvidence[row.period],rulesState:ruleStates.get(row.period)};
   ytdTaxable=round(ytdTaxable+basis.pcb);ytdExempt=round(ytdExempt+exempt);
   const beforeNormal=previous?.normal??(object(st.pcbNonCash)?money(st.pcbNonCash.cashNormal):null);
   const beforeAdditional=previous?.additional??money(source.bonus);
   const payrollInputsChanged=round(basis.pcb-(beforeTaxable??Number(source.gross)))!==0
    ||beforeNormal!==null&&round(Number(basis.normal)-Number(beforeNormal))!==0
    ||beforeAdditional!==null&&round(Number(basis.additional)-Number(beforeAdditional))!==0
    ||hash(previous?.exemptionUsed??(object(st.exemptionUsed)?st.exemptionUsed:{}))!==hash(basis.exemptionUsed)
    ||round(Number(previous?.lp??st.lp??0))!==round(Number(basis.lp??0))
    ||hash(nonCashInputs(previous?.pcbNonCash??st.pcbNonCash))!==hash(nonCashInputs(basis.pcbNonCash));
   months.push({payrollInputsChanged,payslipId:source.id,period:source.period,sourceHash:hashes.get(source.id)!,beforeTaxable,taxable:basis.pcb,difference:beforeTaxable===null?null:round(basis.pcb-beforeTaxable),beforeExempt,exempt,ytdTaxable,ytdExempt,items:basis.items,basis});
  }
  const comparison=(basis:TaxBasisValue)=>({pcb:basis.pcb,normal:basis.normal,additional:basis.additional,exempt:basis.exempt,lp:basis.lp,nonCash:nonCashInputs(basis.pcbNonCash),exemptionUsed:basis.exemptionUsed,settings:importedTaxSettingEvidence(basis.appliedSettings),rulesState:basis.rulesState,rulesEvidence:basis.rulesEvidence,items:basis.items.map(({previousTreatment,name,...item})=>item)});
  const changed=months.some(month=>{const source=included.find(slip=>slip.id===month.payslipId)!,stamp=source.statutory.importedTaxBasis;const previous=effective?.get(month.payslipId)?.basis??(object(stamp)&&stamp.state==='ready'?{...validatedTaxBasis(stamp.basis),appliedSettings:stamp.settings,rulesState:stamp.rulesState,rulesEvidence:stamp.rulesEvidence}:null);return !previous||hash(comparison(previous))!==hash(comparison(month.basis));});
  const beforeTaxable=months.some(m=>m.beforeTaxable===null)?null:round(months.reduce((n,m)=>n+m.beforeTaxable!,0)),taxable=round(months.reduce((n,m)=>n+m.taxable,0)),beforeExempt=months.some(m=>m.beforeExempt===null)?null:round(months.reduce((n,m)=>n+m.beforeExempt!,0)),exempt=round(months.reduce((n,m)=>n+m.exempt,0));
  if(changed&&slips.some(s=>s.period>cutoff)){
   const altersAllocation=months.some(m=>Object.keys(m.basis.exemptionUsed).length>0||object(included.find(s=>s.id===m.payslipId)!.statutory.exemptionUsed)&&Object.keys(included.find(s=>s.id===m.payslipId)!.statutory.exemptionUsed as object).length>0);
   if(altersAllocation)return {...blocked('Later saved months depend on annual exemption allocation. Extend the selected final month and preview again.'),recordCount:months.length,beforeTaxable,taxable,difference:beforeTaxable===null?null:round(taxable-beforeTaxable),beforeExempt,exempt,months};
  }
  return {...who,...(pcbComparison?{pcbComparison}:{}),status:changed?'ready':'unchanged',reason:null,recordCount:months.length,beforeTaxable,taxable,difference:beforeTaxable===null?null:round(taxable-beforeTaxable),beforeExempt,exempt,months};
 }catch(error){if(error instanceof PayrollTaxBasisError||error instanceof Error&&['TaxBasisReplayError','ImportedTaxSourceError','NonCashBenefitConfigurationError'].includes(error.name))return blocked(error.message);throw error;}
}
async function computeTx(tx:Tx,ctx:SessionContext,selection:TaxBasisSelection):Promise<Omit<TaxBasisPreview,'previewId'|'previewHash'|'createdAt'|'expiresAt'>>{
 await permission(tx,ctx,selection.companyId);
 const [company]=await tx.execute<{name:string;country:string}>(sql`select legal_name as name,country from company where id=${selection.companyId}::uuid and archived_at is null`);if(!company)fail('Company is unavailable.');
 const settings=await settingsTx(tx);if(!settings.some(s=>s.code.toUpperCase()==='BASIC'))settings.push(basicSetting);const settingsHash=hash(settings);
 const employees=await tx.execute<{id:string;employeeNo:string;name:string}>(sql`select id,"employeeNo",name from app.payroll_tax_basis_subjects(${selection.companyId}::uuid,${selection.year},${selection.upToMonth}) ${selection.employmentIds===null?sql``:sql`where id=any(${uuidArray(selection.employmentIds)})`} order by "employeeNo",id limit 1001`);
 if(selection.employmentIds!==null&&employees.length!==selection.employmentIds.length)fail('An employee is unavailable, belongs to another company, or has no history in the selected period.');
 if(employees.length>1000)fail('Select up to 1,000 employees per preview. Split a larger company into selected employee groups.');
 const results:TaxBasisEmployee[]=[],cache:SourceCache=new Map(),started=Date.now();
 cache.country=company.country;cache.slips=new Map(employees.map(employee=>[employee.id,[]]));cache.sourceHashes=new Map();
 const allSlips:SourceSlip[]=[];
 if(employees.length){const [budget]=await tx.execute<{bytes:string}>(sql`select coalesce(sum(pg_column_size(p.statutory)),0)::text as bytes from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=any(${uuidArray(employees.map(employee=>employee.id))}) and b.company_id=${selection.companyId}::uuid and b.pay_period like ${selection.year+'-%'} and b.status in ('processed','closed')`);if(Number(budget.bytes)>64*1024*1024)fail('The saved payroll sources exceed the preview budget. Select a smaller employee group.');}
 // Page saved sources set-wise, rather than issuing an employee/month query for every subject.
 for(let offset=0;employees.length;offset+=500){
  const page=await tx.execute<SourceSlip&{employmentId:string}>(sql`select p.id,p.employment_id as "employmentId",b.pay_period as period,(row_number() over(partition by p.employment_id,b.pay_period order by b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id))::integer as "runOrder",p.gross_pay as gross,p.basic_salary as basic,p.allowance,p.overtime_pay as overtime,p.bonus,p.other_deductions as deductions,p.statutory,case when app.payroll_history_native_baseline(p.id) then null else b.history_import_attempt_id end as "historyAttemptId",b.payroll_cycle_id as "cycleId" from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=any(${uuidArray(employees.map(employee=>employee.id))}) and b.company_id=${selection.companyId}::uuid and b.pay_period like ${selection.year+'-%'} and b.status in ('processed','closed') order by p.employment_id,b.pay_period,b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id limit 500 offset ${offset}`);
  for(const slip of page){cache.slips.get(slip.employmentId)!.push(slip);allSlips.push(slip);}
  for(const source of await taxBasisSourceRowsTx(tx,page.map(slip=>slip.id)))cache.sourceHashes.set(source.id,importedSourceHash(source));
  if(page.length<500)break;
 }
 const attempts=[...new Set(allSlips.map(slip=>slip.historyAttemptId).filter((id):id is string=>!!id))];
 if(attempts.length){
  const [size]=await tx.execute<{bytes:string}>(sql`select coalesce(sum(octet_length(source_content)),0)::text as bytes from payroll_history_import_attempt where id=any(${uuidArray(attempts)})`);
  if(Number(size.bytes)>64*1024*1024)fail('The retained import sources exceed the preview budget. Select a smaller employee group.');
  for(let offset=0;offset<attempts.length;offset+=25){
   const page=await tx.execute<{id:string;name:string;content:Buffer;sourceHash:string;rows:HistoryRevisionRow[]}>(sql`select id,source_name as name,source_content as content,source_hash as "sourceHash",plan->'rows' as rows from payroll_history_import_attempt where id=any(${uuidArray(attempts.slice(offset,offset+25))}) order by id`);
   for(const retained of page){if(createHash('sha256').update(retained.content).digest('hex')!==retained.sourceHash)fail('A retained import source is unavailable or changed.');cache.set(retained.id,{retained,rows:await parsePayrollHistorySource(retained.name,retained.content)});}
  }
 }
 cache.rulesStates=await importedTaxRulesStatesTx(tx,[...new Set(allSlips.map(slip=>slip.period))]);
 cache.effective=null;
 try{cache.effective=await readEffectiveTaxBasesTx(tx,ctx,allSlips.map(slip=>slip.id));}catch(error){if(!(error instanceof PayrollTaxBasisError)||!error.message.startsWith('Saved payroll changed')&&!error.message.startsWith('Imported wage inputs require review'))throw error;}
 cache.superseded=new Map();
 const old=employees.length?await tx.execute<{sourceId:string;id:string}>(sql`select current_source.id as "sourceId",r.id from payslip current_source join payroll_batch b on b.id=current_source.batch_id join payroll_tax_basis_revision r on r.company_id=b.company_id and r.employment_id=current_source.employment_id and r.period=b.pay_period where b.company_id=${selection.companyId}::uuid and current_source.employment_id=any(${uuidArray(employees.map(employee=>employee.id))}) and b.pay_period like ${selection.year+'-%'} and (r.payslip_id=current_source.id or r.payslip_id in(select previous.id from payroll_history_import_snapshot previous join payroll_history_import_snapshot current on current.record_id=previous.record_id where current.id=current_source.id)) order by current_source.id,r.id`):[];
 const detached=allSlips.length?await tx.execute<{sourceId:string;id:string}>(sql`select * from app.payroll_history_native_tax_predecessors(${uuidArray(allSlips.map(slip=>slip.id))})`):[];
 for(const row of [...old,...detached])cache.superseded.set(row.sourceId,[...(cache.superseded.get(row.sourceId)??[]),row.id]);
 for(const who of employees){if(Date.now()-started>25000)fail('This preview is too large. Select a smaller employee group and preview again.');results.push(await employeeTx(tx,ctx,selection,who,settings,settingsHash,cache));}
 const ready=results.filter(r=>r.status==='ready');
 const sum=(key:'beforeTaxable'|'taxable'|'beforeExempt'|'exempt')=>ready.some(r=>r[key]===null)?null:round(ready.reduce((n,r)=>n+r[key]!,0));
 const beforeTaxable=sum('beforeTaxable'),taxable=sum('taxable');
 return {companyId:selection.companyId,companyName:company.name,year:selection.year,upToMonth:selection.upToMonth,selection:selection.employmentIds===null?'all':'selected',settingsHash,totals:{beforeTaxable,taxable,difference:beforeTaxable===null||taxable===null?null:round(taxable-beforeTaxable),beforeExempt:sum('beforeExempt'),exempt:sum('exempt')},eligibleCount:ready.length,unchangedCount:results.filter(r=>r.status==='unchanged').length,blockedCount:results.filter(r=>r.status==='blocked').length,recordCount:ready.reduce((n,r)=>n+r.recordCount,0),employees:results};
}
export async function taxBasisOptions(ctx:SessionContext){return withTenant(ctx,async tx=>{
 await lockPayrollHistoryReadTx(tx,ctx.tenantId);
 assertModuleGate(ctx,'payroll');
 const companies=await tx.execute<{id:string;name:string;canRecalculate:boolean}>(sql`select id,legal_name as name,app.payroll_tax_basis_permission(id,'payroll.tax-basis.recalculate') as "canRecalculate" from company where archived_at is null and app.payroll_tax_basis_permission(id,'payroll.tax-basis.view') order by legal_name,id`);
 const canRecalculate=companies.some(company=>company.canRecalculate),ids=companies.map(company=>company.id);if(!ids.length)fail('Income-tax recalculation access is unavailable.');
 const employees:{id:string;companyId:string;employeeNo:string;name:string}[]=[];
 for(let offset=0;;offset+=500){
  const page=await tx.execute<{id:string;companyId:string;employeeNo:string;name:string}>(sql`select * from app.payroll_tax_basis_subject_page(${uuidArray(ids)},${offset},500)`);
  employees.push(...page);if(page.length<500)break;
 }
 const years=await tx.execute<{year:number}>(sql`select distinct left(pay_period,4)::integer as year from payroll_batch where company_id=any(${uuidArray(ids)}) and status in ('processed','closed') order by year desc`);return {companies,employees,years:years.map(r=>r.year),canRecalculate};
 });}
/** The preview computes in one read-only snapshot with no tenant-wide lock: everything it reads is committed
 * whole by its writers (a history import or revert, a correction employee), so a snapshot sees each of them all or
 * nothing, exactly as the shared history barrier made it before, and the database refuses any write in it. Only
 * the preview record is then saved, in a short transaction that rechecks the caller's authority on the primary.
 * Confirming still recomputes the selection under the history and Access write locks and refuses a preview whose
 * figures no longer match, so a change between the snapshot and the confirmation is never applied. */
export async function previewTaxBasisRecalculation(ctx:SessionContext,selection:TaxBasisSelection):Promise<TaxBasisPreview>{validateSelection(selection);
 const computed=await withTenant(ctx,async tx=>{await permission(tx,ctx,selection.companyId,true);return computeTx(tx,ctx,selection);},{readOnlySnapshot:true});
 const id=randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+15*60000).toISOString();const previewHash=hash({selection,computed});
 const preview:TaxBasisPreview={...computed,previewId:id,previewHash,createdAt,expiresAt};
 return withTenant(ctx,async tx=>{
  await permission(tx,ctx,selection.companyId,true);
  await tx.execute(sql`insert into payroll_tax_basis_preview(id,tenant_id,company_id,created_by,preview,selection,preview_hash,expires_at) values(${id}::uuid,${ctx.tenantId}::uuid,${selection.companyId}::uuid,${ctx.userId!}::uuid,${JSON.stringify(preview)}::jsonb,${JSON.stringify(selection)}::jsonb,${previewHash},${expiresAt}::timestamptz)`);return preview;
 });}
/** Everything a selection's recomputation reads, as one digest: the Pay Item settings, the subjects, the company,
 * the assessment year's verified rules, and every payslip and run of the company in that year (row versions), with
 * the income-tax corrections and imported history snapshots and revisions on them. Read set-wise, under the caller's
 * row security, so the batch can open after a short check instead of a full recomputation under the write locks. */
async function taxBasisInputsDigestTx(tx:Tx,selection:TaxBasisSelection){
 const settings=await settingsTx(tx);if(!settings.some(s=>s.code.toUpperCase()==='BASIC'))settings.push(basicSetting);
 const subjects=await tx.execute(sql`select id,"employeeNo",name from app.payroll_tax_basis_subjects(${selection.companyId}::uuid,${selection.year},${selection.upToMonth}) order by id`);
 const [company]=await tx.execute<{country:string;row:string}>(sql`select country,legal_name||':'||coalesce(archived_at::text,'')||':'||xmin::text as row from company where id=${selection.companyId}::uuid`);
 const pack=company?requirePackFor(company.country):null;const rules:unknown[]=[];
 if(pack?.payroll.replayTaxBasis)for(let month=1;month<=selection.upToMonth;month++){
  const period=`${selection.year}-${String(month).padStart(2,'0')}`;
  rules.push(hash(await pack.payroll.loadRulesetResolved(tx,{asOf:period+'-01'}).catch((error:unknown)=>({unavailable:error instanceof Error?error.message:String(error)}))));
 }
 const year=selection.year+'-%';
 const [rows]=await tx.execute<{d:string}>(sql`select md5(coalesce(string_agg(x,',' order by x),'')) as d from (
   select 'p:'||p.id||':'||p.xmin||':'||b.id||':'||b.xmin as x from payslip p join payroll_batch b on b.id=p.batch_id where b.company_id=${selection.companyId}::uuid and b.pay_period like ${year}
   union all select 'r:'||r.id||':'||r.xmin from payroll_tax_basis_revision r where r.company_id=${selection.companyId}::uuid and r.period like ${year}
   union all select 's:'||s.id from payroll_history_import_snapshot s join payroll_history_import_record h on h.id=s.record_id where h.company_id=${selection.companyId}::uuid and h.period like ${year}
   union all select 'v:'||v.id from payroll_history_import_revision v join payroll_history_import_record h on h.id=v.record_id where h.company_id=${selection.companyId}::uuid and h.period like ${year}) q`);
 return hash({settings,subjects:[...subjects],company:company?.row??null,rules,rows:rows?.d??null});
}
async function recordEventTx(tx:Tx,ctx:SessionContext,batchId:string,companyId:string,kind:string,detail:unknown={},employmentId:string|null=null){await tx.execute(sql`insert into payroll_tax_basis_event(tenant_id,company_id,batch_id,employment_id,actor_id,kind,detail) values(${ctx.tenantId}::uuid,${companyId}::uuid,${batchId}::uuid,${employmentId}::uuid,${ctx.userId!}::uuid,${kind},${JSON.stringify(detail)}::jsonb)`);}
async function executeTaxBasisRecalculation(ctx:SessionContext,input:{previewId:string;previewHash:string},resume=false):Promise<{id:string}>{
 if(!uuid.test(input.previewId)||!/^[a-f0-9]{64}$/.test(input.previewHash))fail('Choose a valid recalculation preview.');
 type Stored={preview:TaxBasisPreview;selection:TaxBasisSelection;previewHash:string;expired:boolean};
 const storedTx=async(tx:Tx,lock:boolean)=>{
  const [stored]=await tx.execute<Stored>(sql`select preview,selection,preview_hash as "previewHash",expires_at<now() as expired from payroll_tax_basis_preview where id=${input.previewId}::uuid and created_by=${ctx.userId??null}::uuid ${lock?sql`for update`:sql``}`);
  if(!stored||stored.previewHash!==input.previewHash)fail('The recalculation preview is unavailable.');await permission(tx,ctx,stored.selection.companyId,true);
  const [existing]=await tx.execute<{id:string}>(sql`select id from payroll_tax_basis_batch where preview_id=${input.previewId}::uuid`);
  if(!existing&&stored.expired)fail('The preview expired. Preview the recalculation again.');
  return{stored,existing:existing?.id??null};
 };
 // The whole selection is recomputed in one read-only snapshot with no tenant-wide lock (up to 25 s), and refused
 // exactly as before when its figures no longer match the preview. The batch then opens in one short transaction
 // under the history and Access write locks, after proving with one set-wise digest that nothing the recomputation
 // read changed since its snapshot; if something did, the snapshot recomputation runs again. Each employee is still
 // recomputed and compared under the write locks before its own correction commits (below).
 let opened:Stored&{id:string;existing:boolean}|null=null;
 for(let round=0;!opened;round++){
  const snapshot=await withTenant(ctx,async tx=>{
   const {stored,existing}=await storedTx(tx,false);
   if(existing)return{stored,existing,digest:''};
   const fresh=await computeTx(tx,ctx,stored.selection);if(hash({selection:stored.selection,computed:fresh})!==stored.previewHash)fail('History, settings, rules or access changed. Preview the recalculation again.');
   if(!stored.preview.eligibleCount)fail('There are no eligible changed employees to recalculate.');
   return{stored,existing:null,digest:await taxBasisInputsDigestTx(tx,stored.selection)};
  },{readOnlySnapshot:true});
  if(snapshot.existing){opened={...snapshot.stored,id:snapshot.existing,existing:true};break;}
  opened=await withTenant(ctx,async tx=>{
   await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
   const {stored,existing}=await storedTx(tx,true);
   if(existing)return {...stored,id:existing,existing:true};
   if(await taxBasisInputsDigestTx(tx,stored.selection)!==snapshot.digest)return null;
   const id=randomUUID();await tx.execute(sql`insert into payroll_tax_basis_batch(id,tenant_id,company_id,preview_id,created_by) values(${id}::uuid,${ctx.tenantId}::uuid,${stored.selection.companyId}::uuid,${input.previewId}::uuid,${ctx.userId!}::uuid)`);await recordEventTx(tx,ctx,id,stored.selection.companyId,'pending');return {...stored,id,existing:false};
  });
  if(!opened&&round>=2)fail('History, settings, rules or access changed. Preview the recalculation again.');
 }
 if(opened.existing&&!resume)return {id:opened.id};
 const processed=await withTenant(ctx,async tx=>{await permission(tx,ctx,opened.selection.companyId,true);return tx.execute<{kind:string;employmentId:string|null}>(sql`select kind,employment_id as "employmentId" from payroll_tax_basis_event where batch_id=${opened.id}::uuid`);});
 if(processed.some(e=>['completed','completed_with_errors','failed'].includes(e.kind)))return {id:opened.id};
 const done=new Set(processed.filter(e=>e.employmentId).map(e=>e.employmentId));
 const chunk=opened.preview.employees.filter(e=>e.status==='ready'&&!done.has(e.id)).slice(0,50),started=Date.now(),cache:SourceCache=new Map();
 // Each employee/year commits with all correction rows and its audit event, or none of them.
 for(const reviewed of chunk){if(Date.now()-started>40000)break;
  try{await withTenant(ctx,async tx=>{
   await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);await permission(tx,ctx,opened.selection.companyId,true);
   await tx.execute(sql`select id from payroll_tax_basis_batch where id=${opened.id}::uuid for update`);
   const prior=await tx.execute(sql`select id from payroll_tax_basis_event where batch_id=${opened.id}::uuid and ((employment_id=${reviewed.id}::uuid and kind in ('employee_completed','employee_failed')) or kind in ('completed','completed_with_errors','failed'))`);if(prior.length)return;
   const settings=await settingsTx(tx,true);if(!settings.some(s=>s.code.toUpperCase()==='BASIC'))settings.push(basicSetting);if(hash(settings)!==opened.preview.settingsHash)fail('Pay Item settings changed. Create a new preview for remaining employees.');
   cache.rules=new Map();cache.codes=undefined;cache.rulesStates=undefined;
   const fresh=await employeeTx(tx,ctx,opened.selection,{id:reviewed.id,name:reviewed.name,employeeNo:reviewed.employeeNo},settings,opened.preview.settingsHash,cache);
   if(hash(fresh)!==hash(reviewed))fail('Employee history, rules or opening balances changed. Create a new preview.');
   await recordEventTx(tx,ctx,opened.id,opened.selection.companyId,'processing');
   const ordinals=await tx.execute<{id:string;ordinal:number}>(sql`select payslip_id as id,max(ordinal)::integer as ordinal from payroll_tax_basis_revision where payslip_id=any(${uuidArray(reviewed.months.map(month=>month.payslipId))}) group by payslip_id`);
   const next=new Map(ordinals.map(row=>[row.id,row.ordinal+1]));
   if(reviewed.months.length)await tx.execute(sql`insert into payroll_tax_basis_revision(tenant_id,company_id,employment_id,payslip_id,period,source_hash,ordinal,batch_id,basis,supersedes) values ${sql.join(reviewed.months.map(month=>sql`(${ctx.tenantId}::uuid,${opened.selection.companyId}::uuid,${reviewed.id}::uuid,${month.payslipId}::uuid,${month.period},${month.sourceHash},${next.get(month.payslipId)??1},${opened.id}::uuid,${JSON.stringify(month.basis)}::jsonb,${uuidArray(month.basis.supersedes as string[])})`),sql`, `)}`);
   const firstChanged=reviewed.months.filter(m=>m.payrollInputsChanged).map(m=>m.period).sort()[0];
   if(firstChanged){
    const impacted=await tx.execute<{id:string}>(sql`select distinct b.id from payroll_batch b join payslip p on p.batch_id=b.id join pay_period period on period.id=b.pay_period_id
     where b.tenant_id=${ctx.tenantId}::uuid and b.company_id=${opened.selection.companyId}::uuid and p.employment_id=${reviewed.id}::uuid
      and b.status in ('processed','processing') and period.status='open' and b.pay_period>=${firstChanged} and b.pay_period like ${opened.selection.year+'-%'} and b.history_import_attempt_id is null order by b.id`);
    for(const target of impacted){await markBatchNeedsRecalc(tx,ctx,{batchId:target.id,employmentIds:[reviewed.id],category:'statutory'});await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-batch',aggregateId:target.id,eventType:'payroll-batch.tax-basis-recalc-required',actor:actorOf(ctx),subjectEmploymentId:reviewed.id,payload:{taxBasisBatchId:opened.id,employmentId:reviewed.id,sourcePeriod:firstChanged}});}
   }
   await recordEventTx(tx,ctx,opened.id,opened.selection.companyId,'employee_completed',reviewed,reviewed.id);await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-tax-basis',aggregateId:opened.id,eventType:'payroll.tax-basis.corrected',actor:actorOf(ctx),subjectEmploymentId:reviewed.id,payload:{companyId:opened.selection.companyId,year:opened.selection.year,upToMonth:opened.selection.upToMonth,recordCount:reviewed.recordCount,previewHash:input.previewHash}});
  });}catch(error){
   // Failed employee transactions are rolled back; the failure remains a separate durable outcome.
   await withTenant(ctx,async tx=>{await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);await permission(tx,ctx,opened.selection.companyId,true);const already=await tx.execute(sql`select id from payroll_tax_basis_event where batch_id=${opened.id}::uuid and ((employment_id=${reviewed.id}::uuid and kind in ('employee_completed','employee_failed')) or kind in ('completed','completed_with_errors','failed'))`);if(already.length)return;await recordEventTx(tx,ctx,opened.id,opened.selection.companyId,'employee_failed',{...reviewed,status:'failed',reason:error instanceof PayrollTaxBasisError?error.message:'The employee could not be recalculated. Review the source before retrying.'},reviewed.id);});
  }
 }
 await withTenant(ctx,async tx=>{await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);await permission(tx,ctx,opened.selection.companyId,true);const terminal=await tx.execute(sql`select id from payroll_tax_basis_event where batch_id=${opened.id}::uuid and kind in ('completed','completed_with_errors','failed')`);if(terminal.length)return;const [counts]=await tx.execute<{ok:number}>(sql`select count(distinct employment_id)::integer as ok from payroll_tax_basis_event where batch_id=${opened.id}::uuid and kind='employee_completed'`);const total=opened.preview.eligibleCount;const [processed]=await tx.execute<{count:number}>(sql`select count(distinct employment_id)::integer as count from payroll_tax_basis_event where batch_id=${opened.id}::uuid and kind in ('employee_completed','employee_failed')`);if(processed.count<total)return;await recordEventTx(tx,ctx,opened.id,opened.selection.companyId,counts.ok===total?'completed':counts.ok?'completed_with_errors':'failed');});return {id:opened.id};
}
export async function listTaxBasisBatches(ctx:SessionContext,requestedId?:string):Promise<TaxBasisBatch[]>{return withTenant(ctx,async tx=>{
 const rows=await tx.execute<{id:string;companyId:string;preview:TaxBasisPreview;createdAt:string;actorName:string}>(sql`select b.id,b.company_id as "companyId",p.preview,b.created_at::text as "createdAt",coalesce(actor.full_name,b.created_by::text) as "actorName" from payroll_tax_basis_batch b join payroll_tax_basis_preview p on p.id=b.preview_id left join app_user u on u.id=b.created_by left join person actor on actor.id=u.person_id ${requestedId?sql`where b.id=${requestedId}::uuid`:sql``} order by b.created_at desc,b.id desc limit 100`);
 const result:TaxBasisBatch[]=[];for(const row of rows){if(!await resolvePayrollPermission(tx,ctx,'payroll.tax-basis.view',row.companyId))continue;await permission(tx,ctx,row.companyId);const events=await tx.execute<{kind:string;employmentId:string|null;detail:TaxBasisEmployee;createdAt:string}>(sql`select kind,employment_id as "employmentId",detail,created_at::text as "createdAt" from payroll_tax_basis_event where batch_id=${row.id}::uuid order by created_at,id`);const outcomes=new Map<string,TaxBasisEmployee>();for(const e of events)if(e.employmentId)outcomes.set(e.employmentId,{...e.detail,status:e.kind==='employee_completed'?'completed':'failed'});const employees=row.preview.employees.map(e=>outcomes.get(e.id)??e),completedCount=employees.filter(e=>e.status==='completed').length,failedCount=employees.filter(e=>e.status==='failed').length;const final=[...events].reverse().find(e=>['completed','completed_with_errors','failed'].includes(e.kind));result.push({id:row.id,reference:'TAX-'+row.id.toUpperCase(),companyId:row.companyId,companyName:row.preview.companyName,year:row.preview.year,upToMonth:row.preview.upToMonth,selection:row.preview.selection,status:final?final.kind as TaxBasisBatch['status']:events.some(e=>e.kind==='processing')?'processing':'pending',createdAt:row.createdAt,completedAt:final?.createdAt??null,actorName:row.actorName,employeeCount:row.preview.eligibleCount,recordCount:row.preview.recordCount,completedCount,failedCount,employees,recoverable:!final&&Date.now()-new Date(events.at(-1)?.createdAt??row.createdAt).getTime()>300000});}return result;
 });}
export async function getTaxBasisBatch(ctx:SessionContext,id:string):Promise<TaxBasisBatch|null>{if(!uuid.test(id))return null;return (await listTaxBasisBatches(ctx,id)).find(b=>b.id===id)??null;}
/** Explicitly close an interrupted batch; every unfinished employee must get a fresh preview. */
export async function recoverTaxBasisBatch(ctx:SessionContext,id:string):Promise<{id:string}>{
 if(!uuid.test(id))fail('Choose a valid recalculation batch.');
 return withTenant(ctx,async tx=>{
  await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
  const [batch]=await tx.execute<{companyId:string;preview:TaxBasisPreview}>(sql`select b.company_id as "companyId",p.preview from payroll_tax_basis_batch b join payroll_tax_basis_preview p on p.id=b.preview_id where b.id=${id}::uuid`);if(!batch)fail('The recalculation batch is unavailable.');
  await permission(tx,ctx,batch.companyId,true);
  const events=await tx.execute<{kind:string;employmentId:string|null;recent:boolean}>(sql`select kind,employment_id as "employmentId",created_at>now()-interval '5 minutes' as recent from payroll_tax_basis_event where batch_id=${id}::uuid order by created_at,id`);
  if(events.some(e=>['completed','completed_with_errors','failed'].includes(e.kind)))return {id};
  if(events.some(e=>e.recent))fail('This recalculation may still be active. Refresh its progress before reviewing unfinished employees.');
  const completed=new Set(events.filter(e=>e.kind==='employee_completed').map(e=>e.employmentId));
  for(const reviewed of batch.preview.employees.filter(e=>e.status==='ready'&&!completed.has(e.id)))await recordEventTx(tx,ctx,id,batch.companyId,'employee_failed',{...reviewed,status:'failed',reason:'Processing was interrupted. Review a fresh preview before retrying.'},reviewed.id);
  await recordEventTx(tx,ctx,id,batch.companyId,completed.size?'completed_with_errors':'failed');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-tax-basis',aggregateId:id,eventType:'payroll.tax-basis.interruption-reviewed',actor:actorOf(ctx),payload:{companyId:batch.companyId,preservedEmployees:completed.size}});return {id};
 });
}

export function confirmTaxBasisRecalculation(ctx:SessionContext,input:{previewId:string;previewHash:string}){return executeTaxBasisRecalculation(ctx,input);}
/** Bounded continuation keeps the reviewed configuration and rechecks each remaining employee. */
export async function continueTaxBasisBatch(ctx:SessionContext,id:string):Promise<{id:string}>{
 if(!uuid.test(id))fail('Choose a valid recalculation batch.');
 const input=await withTenant(ctx,async tx=>{const [row]=await tx.execute<{companyId:string;previewId:string;previewHash:string}>(sql`select b.company_id as "companyId",p.id as "previewId",p.preview_hash as "previewHash" from payroll_tax_basis_batch b join payroll_tax_basis_preview p on p.id=b.preview_id where b.id=${id}::uuid and b.created_by=${ctx.userId??null}::uuid`);if(!row)fail('Only the initiating payroll operator can continue this batch. Another authorized operator can review an interrupted batch for a fresh preview.');await permission(tx,ctx,row.companyId,true);return row;});
 return executeTaxBasisRecalculation(ctx,input,true);
}
