/** Authorized, explicit historical tax-input corrections; original payslips are immutable inputs. */
import {importedTaxSettingsTx,importedTaxNeedsOpening,importedTaxRulesStatesTx,importedTaxSettingEvidence} from './payroll-import-tax-source';
import {maintenanceTaxInput} from '../lib/payroll-history-maintenance-tax-input';
import {effectiveHistoryItems} from '../lib/payroll-history-maintenance-lineage';
import type {HistoryRevisionRow} from '../lib/payroll-history-revisions';
import {importedTaxInput,SYSTEM_BASIC_TAX_SETTING,type ImportedTaxSetting} from '../lib/payroll-import-tax-input';
import {readPcbNonCash,nonCashComparisonInputs} from '../localization/noncash-benefits';
import {resolveTaxOpeningEvidence} from '../lib/payroll-tax-opening-evidence';
import {readTaxOpeningRowsTx,resolveTaxOpeningRow} from './payroll-tax-opening';
import {summarizeExemptionLedger,taxOpeningDigestRow,type TaxOpeningRow} from '../lib/payroll-tax-opening-tp3';
import {resolveImportCodes} from './payroll-history-import';
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {requirePackFor} from '../localization/registry';
import type {StatutoryRuleset} from '../localization/country-pack';
import {readHistoryField} from '../lib/payroll-history-import-schema';
import {PayrollTaxBasisError,type TaxBasisSelection,type TaxBasisPreview,type TaxBasisEmployee,type TaxBasisMonth,type TaxBasisValue,type TaxBasisBatch,type TaxBasisOpening,type TaxBasisHoldReason,type TaxBasisLedgerEntry,type TaxBasisBounds,type TaxBasisHistoryRow,type TaxBasisHistoryCursor,type TaxBasisProgressState,type TaxBasisGroupOpening,TAX_BASIS_HISTORY_PAGE_SIZE} from '../lib/payroll-tax-basis';
import {assertModuleGate} from './module-gate';
import {groupTaxOpeningTx,summarizeGroupTaxOpening} from './payroll-group-tax-opening';
import {lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx,lockPayrollHistoryWriteTx} from './payroll-history-lock';
import {lap,reportSlowTaxBasisOpening,type TaxBasisLaps} from '../lib/payroll-tax-basis-timing';
import {resolvePayrollPermission,parsePayrollHistorySource,markBatchNeedsRecalc} from '../packs/payroll/service';
import {taxBasisSourceRowsTx,hashTaxBasisSource as importedSourceHash,createTaxBasisPreviewReadTx,readEffectiveTaxBasesTx,validatedTaxBasis,type TaxBasisSource,type EffectiveTaxBasis} from './payroll-tax-basis-read';
const uuidArray=(ids:string[])=>sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_key,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function fail(s:string):never{throw new PayrollTaxBasisError(s);}
const nonCashInputs=nonCashComparisonInputs;
const round=(n:number)=>Math.round(n*100)/100;
const money=(v:unknown):number|null=>{if(typeof v!=='number'&&typeof v!=='string')return null;if(typeof v==='string'&&!v.trim())return null;const n=Number(v);return Number.isFinite(n)&&n>=0&&Number.isSafeInteger(Math.round(n*100))&&Math.abs(n*100-Math.round(n*100))<1e-6?n:null;};
function validateSelection(v:TaxBasisSelection,allowEmptySelection=false){if(!v||!uuid.test(v.companyId)||!Number.isInteger(v.year)||v.year<1900||v.year>2999||!Number.isInteger(v.upToMonth)||v.upToMonth<1||v.upToMonth>12||v.employmentIds!==null&&(!Array.isArray(v.employmentIds)||(!allowEmptySelection&&!v.employmentIds.length)||v.employmentIds.length>1000||v.employmentIds.some(id=>!uuid.test(id))||new Set(v.employmentIds).size!==v.employmentIds.length))fail('Choose a company, assessment year, final month and valid employees.');}
async function permission(tx:Tx,ctx:SessionContext,companyId:string,write=false){
 assertModuleGate(ctx,'payroll');
 if(write&&!await resolvePayrollPermission(tx,ctx,'payroll.tax-basis.view',companyId))fail('Income-tax recalculation access is unavailable for this company.');
 if(!ctx.userId||!await resolvePayrollPermission(tx,ctx,write?'payroll.tax-basis.recalculate':'payroll.tax-basis.view',companyId))fail('Income-tax recalculation access is unavailable for this company.');
 const [authority]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() and app.can_admin_payroll_for(${companyId}::uuid) as ok`);
 if(!authority?.ok)fail('Your payroll authority changed. Sign in again.');
}
type Settings=ImportedTaxSetting;
async function settingsTx(tx:Tx,lock=false){
 if(lock)await tx.execute(sql`select id from pay_component order by id for share`);
 const settings=await importedTaxSettingsTx(tx);
 if(!settings.some(setting=>setting.code.toUpperCase()==='BASIC'))settings.push(SYSTEM_BASIC_TAX_SETTING);
 return settings;
}
type SourceSlip={id:string;period:string;runOrder:number;gross:string;deductions:string;basic:string;allowance:string;overtime:string;bonus:string;statutory:Record<string,unknown>;historyAttemptId:string|null;cycleId:string|null};
type InputLine={code:string;amount:number;direction:'earning'|'deduction'|'noncash';settingId?:string;rowNum?:number;nonCashSource?:{source:'recurring'|'one_off';sourceId?:string};previousTreatment?:string|null};
type SourceCache=Map<string,{retained:{name:string;sourceHash:string;rows:HistoryRevisionRow[]};rows:Awaited<ReturnType<typeof parsePayrollHistorySource>>}>&{codes?:Awaited<ReturnType<typeof resolveImportCodes>>;slips?:Map<string,SourceSlip[]>;country?:string;rules?:Map<string,Awaited<ReturnType<ReturnType<typeof requirePackFor>['payroll']['loadRulesetResolved']>>>;sourceHashes?:Map<string,string>;effective?:Awaited<ReturnType<typeof readEffectiveTaxBasesTx>>|null;superseded?:Map<string,string[]>;rulesStates?:Awaited<ReturnType<typeof importedTaxRulesStatesTx>>;openings?:Map<string,TaxOpeningRow>;withoutLedger?:boolean};
/** Preview and atomic continuation share exact released ownership, including detached native origins. */
async function supersededTaxBasisRowsTx(tx:Tx,sourceIds:readonly string[]):Promise<Map<string,string[]>>{
 const ids=[...new Set(sourceIds)];if(!ids.length)return new Map();
 const old=await tx.execute<{sourceId:string;id:string}>(sql`select current_source.id as "sourceId",r.id from payslip current_source join payroll_batch b on b.id=current_source.batch_id join payroll_tax_basis_revision r on r.company_id=b.company_id and r.employment_id=current_source.employment_id and r.period=b.pay_period where current_source.id=any(${uuidArray(ids)}) and (r.payslip_id=current_source.id or r.payslip_id in(select previous.id from payroll_history_import_snapshot previous join payroll_history_import_snapshot current on current.record_id=previous.record_id where current.id=current_source.id)) order by current_source.id,r.id`);
 const detached=await tx.execute<{sourceId:string;id:string}>(sql`select * from app.payroll_history_native_tax_predecessors(${uuidArray(ids)})`);
 const grouped=new Map<string,Set<string>>();for(const row of [...old,...detached]){const values=grouped.get(row.sourceId)??new Set<string>();values.add(row.id);grouped.set(row.sourceId,values);}
 return new Map([...grouped].map(([id,values]):[string,string[]]=>[id,[...values].sort()]));
}
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
/** 23 November 2026 (ADR-0167, board item 0af23331): after saved payslip evidence, the accepted TP3 for the year is the
 * prior-employer opening; without one the opening is RM0 even when a previous employer was declared. A caller who cannot see
 * the person's TP3 and applied opening keeps the hold (core/payroll-tax-opening.ts). */
const savedSourceUnbound='Saved prior-employer exemption usage for this year is not bound to this employer, employee and saved history, so it cannot be used or replaced.';
const accessHeld='Prior-employer exemption use cannot be confirmed because you are not allowed to see this employee\'s TP3 and applied tax opening.';
/** Comparison normalises the 20 November label so an unchanged zero opening creates no new revision. */
const comparableOpeningSource=(value:unknown)=>value==='no_tp3_default_zero'?'no_accepted_tp3':value;

async function employeeTx(tx:Tx,ctx:SessionContext,selection:TaxBasisSelection,who:{id:string;employeeNo:string;name:string},settings:Settings[],settingsHash:string,cache:SourceCache=new Map()):Promise<TaxBasisEmployee>{
 let pcbComparison:TaxBasisEmployee['pcbComparison'];
 const blocked=(reason:string):TaxBasisEmployee=>({...who,...(pcbComparison?{pcbComparison}:{}),status:'blocked',reason,recordCount:0,beforeTaxable:null,difference:null,taxable:null,beforeExempt:null,exempt:null,months:[]});
 try{
  const slips=cache.slips?.get(who.id)??await tx.execute<SourceSlip>(sql`select p.id,b.pay_period as period,(row_number() over(partition by b.pay_period order by b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id))::integer as "runOrder",p.gross_pay as gross,p.basic_salary as basic,p.allowance,p.overtime_pay as overtime,p.bonus,p.other_deductions as deductions,p.statutory,case when app.payroll_history_native_baseline(p.id) then null else b.history_import_attempt_id end as "historyAttemptId",b.payroll_cycle_id as "cycleId" from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=${who.id}::uuid and b.company_id=${selection.companyId}::uuid and b.pay_period like ${selection.year+'-%'} and b.status in ('processed','closed') order by b.pay_period,b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id`);
  const cutoff=selection.year+'-'+String(selection.upToMonth).padStart(2,'0'),included=slips.filter(s=>s.period<=cutoff);
  if(included.some(slip=>slip.historyAttemptId)){const paid=included.map(slip=>money(slip.statutory.pcb));pcbComparison={state:'unavailable',originalPaid:paid.some(value=>value===null)?null:round(paid.reduce<number>((sum,value)=>sum+(value??0),0)),missingInputs:['originalStatutoryInputs','originalTaxCategoryAndReliefs','originalPriorEmployerIncome']};}
  if(!included.length)return {...blocked('No saved payroll history exists in the selected period.'),status:'skipped'};
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
  const hasSavedYearUsage=slips.some(({statutory:st})=>st.taxBasisOpeningExemptionYear===selection.year
    && object(st.taxBasisOpeningExemptionUsed) && Object.values(st.taxBasisOpeningExemptionUsed).some(value=>value!==0));
  let openingInfo:TaxBasisOpening|undefined,hold:{code:TaxBasisHoldReason;reason:string;status:'blocked'|'skipped'}|undefined;
  if(!capped){/* Uncapped wage reconstruction needs no prior-employer opening and asserts none. */}
  else if(opening.state==='known')openingInfo={source:'saved_payslip',used:opening.used};
  else if(opening.state==='conflict')hold={code:'saved_evidence_conflict',reason:opening.reason,status:'blocked'};
  else if(hasSavedYearUsage)hold={code:'saved_evidence_conflict',reason:savedSourceUnbound,status:'skipped'};
  else{
   const resolved=resolveTaxOpeningRow((cache.openings??await readTaxOpeningRowsTx(tx,ctx,selection.year,[who.id])).get(who.id));
   if(resolved.state==='access_insufficient')hold={code:'access_insufficient',reason:accessHeld,status:'skipped'};
   else if(resolved.state==='unreadable')fail(resolved.reason);
   else openingInfo=resolved.opening;
  }
  const replayInput={year:selection.year,upToMonth:selection.upToMonth,slips:input,settings,rulesByPeriod};
  if(hold){
   const held=heldDetail(hold.reason,'priorEmployerExemptionUsage',['taxableWages','exemptWages','optionalDeductions','pcbComparison']);
   // Review-only ranges: never persisted (a held employee writes no revision) and never confirmable; totals stay null.
   let bounds:TaxBasisBounds|undefined;
   if(pack.payroll.boundTaxBasis){try{bounds=pack.payroll.boundTaxBasis(replayInput);}catch(error){if(!(error instanceof Error)||error.name!=='TaxBasisReplayError')throw error;}}
   return {...held,holdReason:hold.code,status:hold.status,...(bounds?{bounds}:{}),
    ...(hold.status==='skipped'?{reason:'Saved taxable and exempt values were kept because prior-employer exemption use is unknown. '+hold.reason}:{})};
  }
  const openingExemptionUsed=openingInfo?.used??{};
  let replay:ReturnType<typeof pack.payroll.replayTaxBasis>;
  try{replay=pack.payroll.replayTaxBasis({...replayInput,openingExemptionUsed,ledger:!cache.withoutLedger});}
  catch(error){
   if(!(error instanceof Error)||error.name!=='TaxBasisReplayError')throw error;
   const noncash=/noncash/i.test(error.message),deduction=/relief|deduction split/i.test(error.message);
   return heldDetail(error.message,noncash?'nonCashSourceOwnership':deduction?'optionalDeductionOwnership':'historicalTaxInputs',noncash?['noncashWages','pcbComparison']:deduction?['optionalDeductions','pcbComparison']:['taxableWages','exemptWages','pcbComparison']);
  }
  let effective:Awaited<ReturnType<typeof readEffectiveTaxBasesTx>>|null=null;
  // A fresh correction may explicitly supersede a stale source. It must still be exactly reconstructible.
  try{effective=cache.effective!==undefined?cache.effective:await readEffectiveTaxBasesTx(tx,ctx,included.map(s=>s.id));}catch(error){if(!(error instanceof PayrollTaxBasisError)||!error.message.startsWith('Saved payroll changed')&&!error.message.startsWith('Imported wage inputs require review'))throw error;}
  const superseded=cache.superseded??await supersededTaxBasisRowsTx(tx,included.map(slip=>slip.id));
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
   const basis:TaxBasisValue={...validatedTaxBasis(row.basis),items,supersedes:old.map(r=>r.id),settingsHash,appliedSettings:settings.filter(setting=>row.basis.items.some(item=>item.code===setting.code)),rulesEvidence:rulesEvidence[row.period],rulesState:ruleStates.get(row.period),
     // The comparable source stays as before for a saved opening (absent); provenance and the ledger are additive keys
     // excluded from comparison(), so an unchanged employee creates no new revision.
     ...(openingInfo&&openingInfo.source!=='saved_payslip'?{openingExemptionSource:openingInfo.source}:{}),
     ...(openingInfo?{openingExemption:openingInfo}:{})};
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
  const comparison=(basis:TaxBasisValue)=>({pcb:basis.pcb,normal:basis.normal,additional:basis.additional,exempt:basis.exempt,lp:basis.lp,nonCash:nonCashInputs(basis.pcbNonCash),exemptionUsed:basis.exemptionUsed,settings:importedTaxSettingEvidence(basis.appliedSettings),rulesState:basis.rulesState,rulesEvidence:basis.rulesEvidence,openingExemptionSource:comparableOpeningSource(basis.openingExemptionSource),items:basis.items.map(({previousTreatment,name,...item})=>item)});
  const changed=months.some(month=>{const source=included.find(slip=>slip.id===month.payslipId)!,stamp=source.statutory.importedTaxBasis;const previous=effective?.get(month.payslipId)?.basis??(object(stamp)&&stamp.state==='ready'?{...validatedTaxBasis(stamp.basis),appliedSettings:stamp.settings,rulesState:stamp.rulesState,rulesEvidence:stamp.rulesEvidence}:null);return !previous||hash(comparison(previous))!==hash(comparison(month.basis));});
  const beforeTaxable=months.some(m=>m.beforeTaxable===null)?null:round(months.reduce((n,m)=>n+m.beforeTaxable!,0)),taxable=round(months.reduce((n,m)=>n+m.taxable,0)),beforeExempt=months.some(m=>m.beforeExempt===null)?null:round(months.reduce((n,m)=>n+m.beforeExempt!,0)),exempt=round(months.reduce((n,m)=>n+m.exempt,0));
  if(changed&&slips.some(s=>s.period>cutoff)){
   const altersAllocation=months.some(m=>Object.keys(m.basis.exemptionUsed).length>0||object(included.find(s=>s.id===m.payslipId)!.statutory.exemptionUsed)&&Object.keys(included.find(s=>s.id===m.payslipId)!.statutory.exemptionUsed as object).length>0);
   if(altersAllocation)return {...blocked('Later saved months depend on annual exemption allocation. Extend the selected final month and preview again.'),recordCount:months.length,beforeTaxable,taxable,difference:beforeTaxable===null?null:round(taxable-beforeTaxable),beforeExempt,exempt,months};
  }
  const ledgerEntries=months.flatMap(month=>object(month.basis.exemptionLedger)&&Array.isArray(month.basis.exemptionLedger.entries)?month.basis.exemptionLedger.entries as TaxBasisLedgerEntry[]:[]);
  const exemptionLedger=cache.withoutLedger?undefined:summarizeExemptionLedger(ledgerEntries,openingExemptionUsed,openingInfo?.source??null);
  return {...who,...(openingInfo?{openingExemptionSource:openingInfo.source,openingExemption:openingInfo}:{}),...(exemptionLedger?{exemptionLedger}:{}),...(pcbComparison?{pcbComparison}:{}),status:changed?'ready':'unchanged',reason:null,recordCount:months.length,beforeTaxable,taxable,difference:beforeTaxable===null?null:round(taxable-beforeTaxable),beforeExempt,exempt,months};
 }catch(error){if(error instanceof PayrollTaxBasisError||error instanceof Error&&['TaxBasisReplayError','ImportedTaxSourceError','NonCashBenefitConfigurationError'].includes(error.name))return blocked(error.message);throw error;}
}
/** Read-only replay for one authorized open-run employee. Only the exact prefix selected by payroll
 * participates. The correction workflow still owns every persisted correction and preview. */
export async function replayChangedPayrollHistoryTx(
 tx:Tx,ctx:SessionContext,prefix:readonly TaxBasisSource[],changed:readonly TaxBasisSource[],
 effective:ReadonlyMap<string,EffectiveTaxBasis>,
):Promise<ReadonlyMap<string,TaxBasisValue>>{
 const first=changed[0];
 const year=Number(first.period.slice(0,4));
 if(prefix.some(source=>source.companyId!==first.companyId||source.employmentId!==first.employmentId||Number(source.period.slice(0,4))!==year))
  fail('Payroll tax replay requires a single employee, employer and assessment year.');
 const ids=prefix.map(source=>source.id);
 const slips=await tx.execute<SourceSlip>(sql`
  select p.id,b.pay_period as period,
    (row_number() over(partition by b.pay_period order by b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id))::integer as "runOrder",
    p.gross_pay as gross,p.basic_salary as basic,p.allowance,p.overtime_pay as overtime,p.bonus,
    p.other_deductions as deductions,p.statutory,b.payroll_cycle_id as "cycleId",
    case when app.payroll_history_native_baseline(p.id) then null else b.history_import_attempt_id end as "historyAttemptId"
  from payslip p join payroll_batch b on b.id=p.batch_id
  where p.id=any(${uuidArray(ids)}) and p.employment_id=${first.employmentId}::uuid
    and b.company_id=${first.companyId}::uuid and b.status in ('processed','closed')
  order by b.pay_period,b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id`);
 if(slips.length!==ids.length)fail('The original payroll tax prefix is unavailable.');
 const missingStatutory=slips.find(slip=>!object(slip.statutory));
 if(missingStatutory)fail(`${missingStatutory.period}: original statutory payroll inputs are unavailable.`);
 const settings=await settingsTx(tx);
 const cache:SourceCache=new Map();
 cache.slips=new Map([[first.employmentId,slips]]);
 cache.sourceHashes=new Map(prefix.map(source=>[source.id,importedSourceHash(source)]));
 cache.effective=new Map(effective);
 cache.superseded=new Map();
 cache.withoutLedger=true;
 const upToMonth=Number(slips.at(-1)!.period.slice(5));
 const replay=await employeeTx(tx,ctx,{companyId:first.companyId,year,upToMonth,employmentIds:[first.employmentId]},
  {id:first.employmentId,employeeNo:'',name:''},settings,hash(settings),cache);
 if(replay.status==='blocked'||replay.status==='skipped')fail(replay.reason??'The original payroll tax inputs are unavailable.');
 const changedIds=new Set(changed.map(source=>source.id));
 const firstChangedPeriod=changed.reduce((min,source)=>source.period<min?source.period:min,first.period);
 for(const month of replay.months){
  if(changedIds.has(month.payslipId)||month.period<firstChangedPeriod)continue;
  const saved=effective.get(month.payslipId),stat=slips.find(slip=>slip.id===month.payslipId)!.statutory;
  const used=saved?.basis.exemptionUsed??stat.exemptionUsed??{};
  if(canonical(used)!==canonical(month.basis.exemptionUsed))
   fail(`${month.period}: the changed payroll inputs affect a later saved exemption allocation.`);
 }
 return new Map(replay.months.map(month=>[month.payslipId,month.basis]));
}

async function taxBasisSubjectsTx(tx:Tx,selection:TaxBasisSelection,limit:number|null=1001){
 const {companyId,year,upToMonth,employmentIds}=selection;
 const current=employmentIds===null?sql``:sql`
  union select e.id,coalesce(e.employee_code,''),p.full_name from employment e
  join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
  where e.company_id=${companyId}::uuid and e.id=any(${uuidArray(employmentIds)})`;
 // Selected former/transferred employees retain original-employer history access even when the selected
 // cutoff has no slips. The current employment arm adds only explicitly requested, RLS-visible employees.
 return tx.execute<{id:string;employeeNo:string;name:string}>(sql`
  select id,"employeeNo",name from app.payroll_tax_basis_subjects(${companyId}::uuid,${employmentIds===null?year:null},${upToMonth})
  ${employmentIds===null?sql``:sql`where id=any(${uuidArray(employmentIds)})`}
  ${current} order by "employeeNo",id limit ${limit}`);
}
export async function planTaxBasisPreviewTx(tx:Tx,selection:TaxBasisSelection,chunkSize:number):Promise<TaxBasisSelection[]>{
 const subjects=await taxBasisSubjectsTx(tx,selection,null);
 if(selection.employmentIds!==null&&subjects.length!==selection.employmentIds.length){
  fail('An employee is unavailable or belongs to another company.');
 }
 const chunks:TaxBasisSelection[]=[];
 for(let i=0;i<subjects.length;i+=chunkSize){
  chunks.push({...selection,employmentIds:subjects.slice(i,i+chunkSize).map(subject=>subject.id)});
 }
 return chunks.length?chunks:[{...selection,employmentIds:[]}];
}
async function computeTx(tx:Tx,ctx:SessionContext,selection:TaxBasisSelection):Promise<Omit<TaxBasisPreview,'previewId'|'previewHash'|'createdAt'|'expiresAt'>>{
 await permission(tx,ctx,selection.companyId);
 const [company]=await tx.execute<{name:string;country:string}>(sql`select legal_name as name,country from company where id=${selection.companyId}::uuid and archived_at is null`);if(!company)fail('Company is unavailable.');
 const settings=await settingsTx(tx);const settingsHash=hash(settings);
 const employees=await taxBasisSubjectsTx(tx,selection);
 if(selection.employmentIds!==null&&employees.length!==selection.employmentIds.length)fail('An employee is unavailable or belongs to another company.');
 if(employees.length>1000)fail('Select up to 1,000 employees per preview. Split a larger company into selected employee groups.');
 const results:TaxBasisEmployee[]=[],cache:SourceCache=new Map(),started=Date.now();
 cache.country=company.country;cache.slips=new Map(employees.map(employee=>[employee.id,[]]));cache.sourceHashes=new Map();
 const allSlips:SourceSlip[]=[];
 if(employees.length){const [budget]=await tx.execute<{bytes:string}>(sql`select coalesce(sum(pg_column_size(p.statutory)),0)::text as bytes from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=any(${uuidArray(employees.map(employee=>employee.id))}) and b.company_id=${selection.companyId}::uuid and b.pay_period like ${selection.year+'-%'} and b.status in ('processed','closed')`);if(Number(budget.bytes)>64*1024*1024)fail('The saved payroll sources exceed the preview budget. Select a smaller employee group.');}
 // Page saved sources set-wise, rather than issuing an employee/month query for every subject.
 for(let offset=0;employees.length;offset+=500){
  const page=await tx.execute<SourceSlip&{employmentId:string}>(sql`select p.id,p.employment_id as "employmentId",b.pay_period as period,(row_number() over(partition by p.employment_id,b.pay_period order by b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id))::integer as "runOrder",p.gross_pay as gross,p.basic_salary as basic,p.allowance,p.overtime_pay as overtime,p.bonus,p.other_deductions as deductions,p.statutory,case when app.payroll_history_native_baseline(p.id) then null else b.history_import_attempt_id end as "historyAttemptId",b.payroll_cycle_id as "cycleId" from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=any(${uuidArray(employees.map(employee=>employee.id))}) and b.company_id=${selection.companyId}::uuid and b.pay_period like ${selection.year+'-%'} and b.status in ('processed','closed') order by p.employment_id,b.pay_period,b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id limit 500 offset ${offset}`);
  for(const slip of page){cache.slips.get(slip.employmentId)!.push(slip);allSlips.push(slip);}
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
 // One set-wise opening read for every subject with saved history in the year (SCALE rule 2).
 cache.openings=await readTaxOpeningRowsTx(tx,ctx,selection.year,employees.filter(employee=>cache.slips?.get(employee.id)?.length).map(employee=>employee.id));
 cache.rulesStates=await importedTaxRulesStatesTx(tx,[...new Set(allSlips.map(slip=>slip.period))]);
 const sourceRead=await createTaxBasisPreviewReadTx(tx,ctx,allSlips.map(slip=>slip.id));
 cache.sourceHashes=sourceRead.sourceHashes;
 cache.effective=null;
 try{cache.effective=await sourceRead.readEffective();}catch(error){if(!(error instanceof PayrollTaxBasisError)||!error.message.startsWith('Saved payroll changed')&&!error.message.startsWith('Imported wage inputs require review'))throw error;}
 cache.superseded=await supersededTaxBasisRowsTx(tx,allSlips.map(slip=>slip.id));
 for(const who of employees){if(Date.now()-started>25000)fail('The preview timed out while reviewing saved payroll. Generate a fresh preview. If it happens again, contact support.');results.push(await employeeTx(tx,ctx,selection,who,settings,settingsHash,cache));}
 const ready=results.filter(r=>r.status==='ready');
 const sum=(key:'beforeTaxable'|'taxable'|'beforeExempt'|'exempt')=>ready.some(r=>r[key]===null)?null:round(ready.reduce((n,r)=>n+r[key]!,0));
 const beforeTaxable=sum('beforeTaxable'),taxable=sum('taxable');
 const skippedCount=results.filter(r=>r.status==='skipped').length;
 return {companyId:selection.companyId,companyName:company.name,year:selection.year,upToMonth:selection.upToMonth,selection:selection.employmentIds===null?'all':'selected',settingsHash,totals:{beforeTaxable,taxable,difference:beforeTaxable===null||taxable===null?null:round(taxable-beforeTaxable),beforeExempt:sum('beforeExempt'),exempt:sum('exempt')},eligibleCount:ready.length,unchangedCount:results.filter(r=>r.status==='unchanged').length,blockedCount:results.filter(r=>r.status==='blocked').length,...(skippedCount?{skippedCount}:{}),recordCount:ready.reduce((n,r)=>n+r.recordCount,0),employees:results};
}
/** Current employees may have no saved payroll yet. The historical picker remains the authority
 * for original-employer records after a transfer. This bounded search adds current matches only. */
export async function searchCurrentTaxBasisEmployees(ctx:SessionContext,companyIds:string[],query:string){
 const term=query.trim().slice(0,120).toLowerCase();
 if(term.length<2||!Array.isArray(companyIds)||!companyIds.length||companyIds.length>500||companyIds.some(id=>!uuid.test(id)))return [];
 assertModuleGate(ctx,'payroll');
 return withTenant(ctx,async tx=>[...await tx.execute<{id:string;companyId:string;employeeNo:string;name:string}>(sql`
  with permitted as materialized (
   select id from company where id=any(${uuidArray(companyIds)}) and archived_at is null
    and app.payroll_tax_basis_permission(id,'payroll.tax-basis.view')
    and app.payroll_tax_basis_permission(id,'payroll.tax-basis.recalculate')
  )
  select e.id,e.company_id as "companyId",coalesce(e.employee_code,'') as "employeeNo",p.full_name as name
   from permitted c join employment e on e.company_id=c.id
   join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
   where e.tenant_id=${ctx.tenantId}::uuid
    and (position(${term} in lower(coalesce(e.employee_code,'')))>0 or position(${term} in lower(p.full_name))>0)
   order by e.company_id,e.employee_code,e.id limit 30`)]);
}
export async function taxBasisOptions(ctx:SessionContext){return withTenant(ctx,async tx=>{
 await lockPayrollHistoryReadTx(tx,ctx.tenantId);
 assertModuleGate(ctx,'payroll');
 const companies=await tx.execute<{id:string;name:string;code:string|null;canRecalculate:boolean}>(sql`select id,legal_name as name,nullif(btrim(company_label),'') as code,app.payroll_tax_basis_permission(id,'payroll.tax-basis.recalculate') as "canRecalculate" from company where archived_at is null and app.payroll_tax_basis_permission(id,'payroll.tax-basis.view') order by legal_name,id`);
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
export async function calculateTaxBasisPreview(ctx:SessionContext,selection:TaxBasisSelection,options:{allowEmptySelection?:boolean}={}):Promise<TaxBasisPreview>{
 validateSelection(selection,options.allowEmptySelection);
 const {computed,group}=await withTenant(ctx,async tx=>{await permission(tx,ctx,selection.companyId,true);const computed=await computeTx(tx,ctx,selection);return {computed,group:await taxBasisGroupOpeningTx(tx,selection,computed.employees)};},{readOnlySnapshot:true});
 const previewId=randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+15*60000).toISOString();
 // 4ce2c481 — the group section is attached AFTER the hash: it is display only and decides nothing a confirmation applies.
 const previewHash=hash({selection,computed});
 return {...computed,employees:computed.employees.map(employee=>group.has(employee.id)?{...employee,groupOpening:group.get(employee.id)}:employee),previewId,previewHash,createdAt,expiresAt};
}
/**
 * Board 4ce2c481 — "Year to date from other group companies", per previewed employee: what live payroll now takes from
 * the group's other companies as a previous-employer opening, through the same definer (totals per company and month;
 * the caller needs payroll administration of the selected company, which `permission` has already required). The
 * months counted are those before the employee's latest month here in the selected range, so a company the person
 * moved to LATER is never shown as earlier history. Limits come from the assessment year's verified rules. One
 * statement for the preview (SCALE rule 2). Read only; corrections stay per original employer (ADR-0167).
 */
async function taxBasisGroupOpeningTx(tx:Tx,selection:TaxBasisSelection,employees:readonly TaxBasisEmployee[]):Promise<Map<string,TaxBasisGroupOpening>>{
 const out=new Map<string,TaxBasisGroupOpening>();
 if(!employees.length)return out;
 const cutoff=selection.year+'-'+String(selection.upToMonth).padStart(2,'0');
 const openings=await groupTaxOpeningTx(tx,{runCompanyId:selection.companyId,payPeriod:cutoff,employmentIds:employees.map(employee=>employee.id)});
 if(!openings.size)return out;
 const [company]=await tx.execute<{country:string}>(sql`select country from company where id=${selection.companyId}::uuid`);
 const pack=company?requirePackFor(company.country):null;
 const resolved=pack?await pack.payroll.loadRulesetResolved(tx,{asOf:cutoff+'-01'}).catch(()=>null):null;
 const tables=(resolved?.ruleset as unknown as {pcbExemptions?:{pcb?:Record<string,number>;lp?:Record<string,number>}}|undefined)?.pcbExemptions;
 const capOf=(code:string):number|null=>{const cap=tables?.pcb?.[code]??tables?.lp?.[code];return typeof cap==='number'&&cap>0&&cap<9999999?cap:null;};
 for(const employee of employees){
  const opening=openings.get(employee.id);if(!opening)continue;
  const last=employee.months.reduce<string>((latest,month)=>month.period>latest?month.period:latest,'');
  const months=opening.months.filter(month=>!last||month.period<last||month.period===cutoff&&last===cutoff);
  if(!months.length)continue;
  const used=new Map<string,number>();
  for(const month of months)for(const [code,amount] of Object.entries(month.exemptionUsed))used.set(code,round((used.get(code)??0)+amount));
  out.set(employee.id,{tp3:opening.tp3,
   companies:summarizeGroupTaxOpening(months).map(c=>({companyId:c.companyId,companyName:c.companyName,periods:c.periods,sources:c.sources,taxable:c.y,pcb:c.pcb,epf:c.epf,zakat:c.zakat,exemptionUsed:Object.entries(c.exemptionUsed).map(([code,amount])=>({code,used:amount}))})),
   limits:[...used].sort(([a],[b])=>a.localeCompare(b)).map(([code,amount])=>{const cap=capOf(code);return {code,cap,used:amount,remaining:cap===null?null:round(Math.max(0,cap-amount))};}),
   missing:months.filter(month=>month.unusable).map(month=>({companyName:month.companyName,period:month.period}))});
 }
 return out;
}
export async function saveTaxBasisPreviewTx(tx:Tx,ctx:SessionContext,selection:TaxBasisSelection,preview:TaxBasisPreview){
 await permission(tx,ctx,selection.companyId,true);
 await tx.execute(sql`insert into payroll_tax_basis_preview(id,tenant_id,company_id,created_by,preview,selection,preview_hash,expires_at) values(${preview.previewId}::uuid,${ctx.tenantId}::uuid,${selection.companyId}::uuid,${ctx.userId!}::uuid,${JSON.stringify(preview)}::jsonb,${JSON.stringify(selection)}::jsonb,${preview.previewHash},${preview.expiresAt}::timestamptz)`);
 return preview;
}
export async function previewTaxBasisRecalculation(ctx:SessionContext,selection:TaxBasisSelection,options:{allowEmptySelection?:boolean}={}):Promise<TaxBasisPreview>{
 const preview=await calculateTaxBasisPreview(ctx,selection,options);
 return withTenant(ctx,tx=>saveTaxBasisPreviewTx(tx,ctx,selection,preview));
}
/** Everything a selection's recomputation reads, as one digest: the Pay Item settings, the subjects, the company,
 * the assessment year's verified rules, and every payslip and run of the company in that year (row versions), with
 * the income-tax corrections and imported history snapshots and revisions on them. Read set-wise, under the caller's
 * row security, so the batch can open after a short check instead of a full recomputation under the write locks. */
async function taxBasisInputsDigestTx(tx:Tx,ctx:SessionContext,selection:TaxBasisSelection,laps?:TaxBasisLaps){
 const settings=await lap(laps,'settings',()=>settingsTx(tx));
 const subjects=await lap(laps,'subjects',()=>tx.execute<{id:string}>(sql`select id,"employeeNo",name from app.payroll_tax_basis_subjects(${selection.companyId}::uuid,${selection.year},${selection.upToMonth}) order by id`));
 const selectedSubjects=selection.employmentIds===null?[]:await lap(laps,'selectedSubjects',()=>taxBasisSubjectsTx(tx,selection));
 const [company]=await tx.execute<{country:string;row:string}>(sql`select country,legal_name||':'||coalesce(archived_at::text,'')||':'||xmin::text as row from company where id=${selection.companyId}::uuid`);
 const pack=company?requirePackFor(company.country):null;const rules:unknown[]=[];
 if(pack?.payroll.replayTaxBasis)for(let month=1;month<=selection.upToMonth;month++){
  const period=`${selection.year}-${String(month).padStart(2,'0')}`;
  rules.push(hash(await lap(laps,'rules',()=>pack.payroll.loadRulesetResolved(tx,{asOf:period+'-01'})).catch((error:unknown)=>({unavailable:error instanceof Error?error.message:String(error)}))));
 }
 // Set-wise under the same authority (migration 7170): the reader's row security ran the payslip policy stack once per
 // tax-basis revision and held the locks for 18-37 s on production; the definer returns the same digest of the same rows.
 const [rows]=await lap(laps,'sourceRows',()=>tx.execute<{d:string}>(sql`select app.payroll_tax_basis_source_digest(${selection.companyId}::uuid,${selection.year}::integer) as d`));
 // The opening source, TP3 identity/revision, projection and declared answer invalidate a preview when any of them changes.
 const openings=[...(await lap(laps,'openingEvidence',()=>readTaxOpeningRowsTx(tx,ctx,selection.year,(selection.employmentIds===null?subjects:selectedSubjects).map(subject=>subject.id)))).values()].map(taxOpeningDigestRow);
 return hash({settings,subjects:[...subjects],selectedSubjects:[...selectedSubjects],company:company?.row??null,rules,rows:rows?.d??null,openings});
}
async function recordEventTx(tx:Tx,ctx:SessionContext,batchId:string,companyId:string,kind:string,detail:unknown={},employmentId:string|null=null){await tx.execute(sql`insert into payroll_tax_basis_event(tenant_id,company_id,batch_id,employment_id,actor_id,kind,detail) values(${ctx.tenantId}::uuid,${companyId}::uuid,${batchId}::uuid,${employmentId}::uuid,${ctx.userId!}::uuid,${kind},${JSON.stringify(detail)}::jsonb)`);}
type PreviewInput={previewId:string;previewHash:string};
type StoredPreview={preview:TaxBasisPreview;selection:TaxBasisSelection;previewHash:string;expired:boolean};
type OpenedTaxBasisBatch=StoredPreview&{id:string;existing:boolean};
const historyChanged='History, settings, rules or access changed. Preview the recalculation again.';

async function loadTaxBasisPreviewTx(tx:Tx,ctx:SessionContext,input:PreviewInput,lock:boolean,groupReviewed:boolean){
 const [stored]=await tx.execute<StoredPreview>(sql`select preview,selection,preview_hash as "previewHash",expires_at<now() as expired from payroll_tax_basis_preview where id=${input.previewId}::uuid and created_by=${ctx.userId??null}::uuid ${lock?sql`for update`:sql``}`);
 if(!stored||stored.previewHash!==input.previewHash)fail('The recalculation preview is unavailable.');
 await permission(tx,ctx,stored.selection.companyId,true);
 const [existing]=await tx.execute<{id:string}>(sql`select id from payroll_tax_basis_batch where preview_id=${input.previewId}::uuid`);
 if(!existing&&stored.expired&&!groupReviewed)fail('The preview expired. Preview the recalculation again.');
 return {stored,existing:existing?.id??null};
}

async function calculateTaxBasisConfirmation(ctx:SessionContext,input:PreviewInput,groupReviewed:boolean){
 if(!uuid.test(input.previewId)||!/^[a-f0-9]{64}$/.test(input.previewHash))fail('Choose a valid recalculation preview.');
 return withTenant(ctx,async tx=>{
  const {stored,existing}=await loadTaxBasisPreviewTx(tx,ctx,input,false,groupReviewed);
  if(existing)return {stored,existing,digest:''};
  const fresh=await computeTx(tx,ctx,stored.selection);
  if(hash({selection:stored.selection,computed:fresh})!==stored.previewHash)fail(historyChanged);
  if(!stored.preview.eligibleCount){
   if(groupReviewed)return {stored,existing:null,digest:null};
   fail('There are no eligible changed employees to recalculate.');
  }
  return {stored,existing:null,digest:await taxBasisInputsDigestTx(tx,ctx,stored.selection)};
 },{readOnlySnapshot:true});
}

async function openTaxBasisBatchTx(tx:Tx,ctx:SessionContext,input:PreviewInput,digest:string,groupReviewed:boolean,runId:string|null=null):Promise<OpenedTaxBasisBatch|null>{
 const laps:TaxBasisLaps={},started=performance.now();let lockedAt=started,outcome='opened';
 try{
  await lap(laps,'historyLockWait',()=>lockPayrollHistoryWriteTx(tx,ctx.tenantId));
  lockedAt=performance.now(); // every payroll page waits from here: the module gate reads payroll history shared
  await lap(laps,'accessLockWait',()=>lockAccessConfigurationWriteTx(tx,ctx.tenantId));
  const {stored,existing}=await lap(laps,'loadPreview',()=>loadTaxBasisPreviewTx(tx,ctx,input,true,groupReviewed));
  if(existing){outcome='existing';return {...stored,id:existing,existing:true};}
  if(await taxBasisInputsDigestTx(tx,ctx,stored.selection,laps)!==digest){outcome='changed';return null;}
  const id=randomUUID();
  await tx.execute(sql`insert into payroll_tax_basis_batch(id,tenant_id,company_id,preview_id,created_by,run_id) values(${id}::uuid,${ctx.tenantId}::uuid,${stored.selection.companyId}::uuid,${input.previewId}::uuid,${ctx.userId!}::uuid,${runId}::uuid)`);
  await recordEventTx(tx,ctx,id,stored.selection.companyId,'pending');
  return {...stored,id,existing:false};
 }catch(error){outcome='refused';throw error;}
 finally{reportSlowTaxBasisOpening(input.previewId,outcome,Math.round(performance.now()-lockedAt),Math.round(performance.now()-started),laps);}
}

/** `runId` is the grouped confirmation bulk job: it only groups this run's employee-group batches per company on the
 * Recalculation history page (a16382b4, migration 7120). It grants nothing and is never read for authority. */
export async function prepareReviewedTaxBasisConfirmation(ctx:SessionContext,input:PreviewInput,runId:string|null=null){
 if(runId!==null&&!uuid.test(runId))fail('Choose a valid recalculation batch.');
 const {digest}=await calculateTaxBasisConfirmation(ctx,input,true);
 return async (tx:Tx):Promise<{id:string|null}>=>{
  if(digest===null){
   await loadTaxBasisPreviewTx(tx,ctx,input,false,true);
   return {id:null};
  }
  const opened=await openTaxBasisBatchTx(tx,ctx,input,digest,true,runId);
  if(!opened)fail(historyChanged);
  return {id:opened.id};
 };
}

async function executeTaxBasisRecalculation(ctx:SessionContext,input:PreviewInput,options:{resume?:boolean;budgetMs?:number}={}):Promise<{id:string}>{
 const {resume=false,budgetMs=40000}=options;
 // Recompute in a read-only snapshot. Under the writer locks, use the digest to check that its inputs still match.
 let opened:OpenedTaxBasisBatch|null=null;
 for(let round=0;!opened;round++){
  const snapshot=await calculateTaxBasisConfirmation(ctx,input,false);
  if(snapshot.existing){opened={...snapshot.stored,id:snapshot.existing,existing:true};break;}
  if(snapshot.digest===null)fail('There are no eligible changed employees to recalculate.');
  const digest=snapshot.digest;
  opened=await withTenant(ctx,tx=>openTaxBasisBatchTx(tx,ctx,input,digest,false));
  if(!opened&&round>=2)fail(historyChanged);
 }
 if(opened.existing&&!resume)return {id:opened.id};
 const processed=await withTenant(ctx,async tx=>{await permission(tx,ctx,opened.selection.companyId,true);return tx.execute<{kind:string;employmentId:string|null}>(sql`select kind,employment_id as "employmentId" from payroll_tax_basis_event where batch_id=${opened.id}::uuid`);});
 if(processed.some(e=>['completed','completed_with_errors','failed'].includes(e.kind)))return {id:opened.id};
 const done=new Set(processed.filter(e=>e.employmentId).map(e=>e.employmentId));
 const chunk=opened.preview.employees.filter(e=>e.status==='ready'&&!done.has(e.id)).slice(0,50),started=Date.now(),cache:SourceCache=new Map();
 // Each employee/year commits with all correction rows and its audit event, or none of them.
 for(const reviewed of chunk){if(Date.now()-started>budgetMs)break;
  try{await withTenant(ctx,async tx=>{
   await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);await permission(tx,ctx,opened.selection.companyId,true);
   await tx.execute(sql`select id from payroll_tax_basis_batch where id=${opened.id}::uuid for update`);
   const prior=await tx.execute(sql`select id from payroll_tax_basis_event where batch_id=${opened.id}::uuid and ((employment_id=${reviewed.id}::uuid and kind in ('employee_completed','employee_failed')) or kind in ('completed','completed_with_errors','failed'))`);if(prior.length)return;
   const settings=await settingsTx(tx,true);if(hash(settings)!==opened.preview.settingsHash)fail('Pay Item settings changed. Create a new preview for remaining employees.');
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
export async function listTaxBasisBatches(ctx:SessionContext,requestedId?:string):Promise<TaxBasisBatch[]>{
 return withTenant(ctx,async tx=>{
  const rows=await tx.execute<{id:string;companyId:string;preview:TaxBasisPreview;createdAt:string;actorName:string}>(sql`
   select b.id,b.company_id as "companyId",p.preview,b.created_at::text as "createdAt",
    coalesce(actor.full_name,b.created_by::text) as "actorName"
   from payroll_tax_basis_batch b join payroll_tax_basis_preview p on p.id=b.preview_id
   left join app_user u on u.id=b.created_by left join person actor on actor.id=u.person_id
   ${requestedId?sql`where b.id=${requestedId}::uuid`:sql``} order by b.created_at desc,b.id desc limit 100`);
  const result:TaxBasisBatch[]=[];
  for(const row of rows){
   if(!await resolvePayrollPermission(tx,ctx,'payroll.tax-basis.view',row.companyId))continue;
   await permission(tx,ctx,row.companyId);
   const events=await tx.execute<{kind:string;employmentId:string|null;detail:TaxBasisEmployee;createdAt:string}>(sql`
    select kind,employment_id as "employmentId",detail,created_at::text as "createdAt"
    from payroll_tax_basis_event where batch_id=${row.id}::uuid order by created_at,id`);
   const outcomes=new Map<string,TaxBasisEmployee>();
   for(const event of events)if(event.employmentId)outcomes.set(event.employmentId,{
    ...event.detail,status:event.kind==='employee_completed'?'completed':'failed',
   });
   const employees=row.preview.employees.map(employee=>outcomes.get(employee.id)??employee);
   const completedCount=employees.filter(employee=>employee.status==='completed').length;
   const failedCount=employees.filter(employee=>employee.status==='failed').length;
   const final=events.findLast(event=>['completed','completed_with_errors','failed'].includes(event.kind));
   const lastProgressAt=events.at(-1)?.createdAt??row.createdAt;
   const workerManaged=!final&&await taxBasisWorkerManagedTx(tx,row.id);
   result.push({
    id:row.id,reference:'TAX-'+row.id.toUpperCase(),companyId:row.companyId,companyName:row.preview.companyName,
    year:row.preview.year,upToMonth:row.preview.upToMonth,selection:row.preview.selection,
    status:final?final.kind as TaxBasisBatch['status']:events.some(event=>event.kind==='processing')?'processing':'pending',
    createdAt:row.createdAt,completedAt:final?.createdAt??null,actorName:row.actorName,employeeCount:row.preview.eligibleCount,
    recordCount:row.preview.recordCount,completedCount,failedCount,employees,lastProgressAt,workerManaged,
    recoverable:!final&&!workerManaged&&Date.now()-new Date(lastProgressAt).getTime()>300000,
   });
  }
  return result;
 });
}
/** a16382b4 — the Recalculation history page. One row per company per recalculation run: batches stamped with the
 * same run_id (7120) are one run; an older or single-preview batch (run_id null) is its own run. Visibility,
 * grouping, ordering, keyset paging and every count are one set-based statement — no per-row permission or event
 * reads (docs/SCALE-AND-RELEASE-RULES.md §2). Authority is the same database owner the per-batch reader and the
 * company picker use (app.payroll_tax_basis_permission, which also requires can_admin_payroll_for). */
export async function listTaxBasisHistory(ctx:SessionContext,options:{cursor?:TaxBasisHistoryCursor|null;limit?:number}={}):Promise<{rows:TaxBasisHistoryRow[];next:TaxBasisHistoryCursor|null}>{
 const limit=Math.min(Math.max(Math.trunc(options.limit??TAX_BASIS_HISTORY_PAGE_SIZE),1),100),cursor=options.cursor??null;
 if(cursor&&(!/^\d{4}-\d{2}-\d{2}[ T][\d:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.test(cursor.createdAt)||!/^[\da-f-]{36}:[\da-f-]{36}$/i.test(cursor.id)))fail('Choose a valid history page.');
 assertModuleGate(ctx,'payroll');
 if(!ctx.userId)return {rows:[],next:null};
 return withTenant(ctx,async tx=>{
  const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);
  if(!principal?.ok)fail('Your payroll authority changed. Sign in again.');
  const rows=await tx.execute<{key:string;companyId:string;startedAt:string;batchIds:string[];createdBy:string;actorName:string;companyName:string|null;year:number|null;upToMonth:number|null;employeeCount:number;notIncluded:number;completed:number;failed:number;finals:number;completedFinals:number;failedFinals:number;finalAt:string|null;processing:boolean;interrupted:boolean}>(sql`
   with permitted as materialized (
    select c.id from company c where c.tenant_id=${ctx.tenantId}::uuid and app.payroll_tax_basis_permission(c.id,'payroll.tax-basis.view')
   ), runs as (
    select b.company_id,coalesce(b.run_id,b.id) as run_key,min(b.created_at) as started_at,
     array_agg(b.id order by b.created_at,b.id) as batch_ids,(array_agg(b.created_by order by b.created_at,b.id))[1] as created_by
    from payroll_tax_basis_batch b join permitted on permitted.id=b.company_id
    where b.tenant_id=${ctx.tenantId}::uuid group by b.company_id,coalesce(b.run_id,b.id)
   ), page as (
    select r.*,(r.run_key::text||':'||r.company_id::text) collate "C" as key from runs r
    ${cursor?sql`where (r.started_at,(r.run_key::text||':'||r.company_id::text) collate "C")<(${cursor.createdAt}::timestamptz,${cursor.id}::text collate "C")`:sql``}
    order by r.started_at desc,key desc limit ${limit+1}
   )
   select page.key,page.company_id as "companyId",page.started_at::text as "startedAt",page.batch_ids::text[] as "batchIds",
    coalesce(actor.full_name,page.created_by::text) as "actorName",agg.company_name as "companyName",agg.year,agg.up_to_month as "upToMonth",
    agg.employee_count::integer as "employeeCount",agg.not_included::integer as "notIncluded",
    coalesce(outcome.completed,0)::integer as completed,coalesce(outcome.failed,0)::integer as failed,
    coalesce(fin.finals,0)::integer as finals,coalesce(fin.completed_finals,0)::integer as "completedFinals",coalesce(fin.failed_finals,0)::integer as "failedFinals",
    fin.final_at::text as "finalAt",coalesce(pr.processing,false) as processing,
    (coalesce(fin.finals,0)<cardinality(page.batch_ids) and not coalesce(wm.worker_managed,false) and pr.last_at<now()-interval '5 minutes') as interrupted
   from page
   left join app_user u on u.id=page.created_by left join person actor on actor.id=u.person_id
   cross join lateral (
    select (array_agg(pv.preview->>'companyName' order by b.created_at,b.id))[1] as company_name,
     min((pv.preview->>'year')::integer) as year,min((pv.preview->>'upToMonth')::integer) as up_to_month,
     coalesce(sum((pv.preview->>'eligibleCount')::integer),0) as employee_count,
     coalesce(sum(coalesce((pv.preview->>'skippedCount')::integer,0)+coalesce((pv.preview->>'blockedCount')::integer,0)+coalesce((pv.preview->>'unchangedCount')::integer,0)),0) as not_included
    from payroll_tax_basis_batch b join payroll_tax_basis_preview pv on pv.id=b.preview_id where b.id=any(page.batch_ids)
   ) agg
   left join lateral (
    select count(*) filter (where o.kind='employee_completed') as completed,count(*) filter (where o.kind='employee_failed') as failed
    from (select distinct on (e.batch_id,e.employment_id) e.kind from payroll_tax_basis_event e
     where e.batch_id=any(page.batch_ids) and e.kind in ('employee_completed','employee_failed')
     order by e.batch_id,e.employment_id,e.created_at desc,e.id desc) o
   ) outcome on true
   left join lateral (
    select count(*) as finals,count(*) filter (where f.kind='completed') as completed_finals,count(*) filter (where f.kind='failed') as failed_finals,max(f.created_at) as final_at
    from (select distinct on (e.batch_id) e.kind,e.created_at from payroll_tax_basis_event e
     where e.batch_id=any(page.batch_ids) and e.kind in ('completed','completed_with_errors','failed')
     order by e.batch_id,e.created_at desc,e.id desc) f
   ) fin on true
   left join lateral (
    select exists(select 1 from payroll_tax_basis_event e where e.batch_id=any(page.batch_ids) and e.kind='processing') as processing,
     coalesce((select max(e.created_at) from payroll_tax_basis_event e where e.batch_id=any(page.batch_ids)),page.started_at) as last_at
   ) pr on true
   -- Interrupted, exactly as the per-batch reader decides it: unfinished, no worker owns it, no progress for 5 minutes.
   -- Evaluated only for this page's unfinished rows (at most the page size).
   left join lateral (
    select bool_or(app.payroll_tax_basis_worker_managed(x.id)) as worker_managed from unnest(page.batch_ids) x(id)
    where coalesce(fin.finals,0)<cardinality(page.batch_ids)
   ) wm on true
   order by page.started_at desc,page.key desc`);
  const more=rows.length>limit,visible=rows.slice(0,limit);
  const result=visible.map(row=>{
   const count=row.batchIds.length,finished=row.finals===count;
   const status:TaxBasisProgressState=finished
    ?(row.completedFinals===count?'completed':row.failedFinals===count?'failed':'completed_with_errors')
    :row.finals>0||row.processing?'processing':'pending';
   return {
    id:row.key,kind:'batch' as const,reference:'TAX-'+row.batchIds[0].toUpperCase(),companyId:row.companyId,companyName:row.companyName??'',
    year:row.year,upToMonth:row.upToMonth,status,createdAt:row.startedAt,completedAt:finished?row.finalAt:null,actorName:row.actorName,
    employeeCount:row.employeeCount,processedCount:row.completed+row.failed,completedCount:row.completed,failedCount:row.failed,
    notIncludedCount:row.notIncluded,interrupted:row.interrupted===true,batches:row.batchIds.map(id=>({id,reference:'TAX-'+id.toUpperCase()})),
   };
  });
  const last=visible.at(-1);
  return {rows:result,next:more&&last?{createdAt:last.startedAt,id:last.key}:null};
 },{readOnlySnapshot:true});
}
async function taxBasisWorkerManagedTx(tx:Tx,batchId:string){
 const [row]=await tx.execute<{active:boolean}>(sql`select app.payroll_tax_basis_worker_managed(${batchId}::uuid) as active`);
 return row.active;
}
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
  if(events.some(e=>e.recent)||await taxBasisWorkerManagedTx(tx,id))fail('This recalculation may still be active. Refresh its progress before reviewing unfinished employees.');
  const completed=new Set(events.filter(e=>e.kind==='employee_completed').map(e=>e.employmentId));
  const finished=new Set(events.filter(e=>e.kind==='employee_completed'||e.kind==='employee_failed').map(e=>e.employmentId));
  for(const reviewed of batch.preview.employees.filter(e=>e.status==='ready'&&!finished.has(e.id)))await recordEventTx(tx,ctx,id,batch.companyId,'employee_failed',{...reviewed,status:'failed',reason:'Processing was interrupted. Review a fresh preview before retrying.'},reviewed.id);
  await recordEventTx(tx,ctx,id,batch.companyId,completed.size?'completed_with_errors':'failed');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-tax-basis',aggregateId:id,eventType:'payroll.tax-basis.interruption-reviewed',actor:actorOf(ctx),payload:{companyId:batch.companyId,preservedEmployees:completed.size}});return {id};
 });
}

export function confirmTaxBasisRecalculation(ctx:SessionContext,input:PreviewInput){
 return executeTaxBasisRecalculation(ctx,input);
}
/** Bounded continuation keeps the reviewed configuration and rechecks each remaining employee. */
export async function continueTaxBasisBatch(ctx:SessionContext,id:string,options:{budgetMs?:number}={}):Promise<{id:string}>{
 if(!uuid.test(id))fail('Choose a valid recalculation batch.');
 const input=await withTenant(ctx,async tx=>{const [row]=await tx.execute<{companyId:string;previewId:string;previewHash:string}>(sql`select b.company_id as "companyId",p.id as "previewId",p.preview_hash as "previewHash" from payroll_tax_basis_batch b join payroll_tax_basis_preview p on p.id=b.preview_id where b.id=${id}::uuid and b.created_by=${ctx.userId??null}::uuid`);if(!row)fail('Only the initiating payroll operator can continue this batch. Another authorized operator can review an interrupted batch for a fresh preview.');await permission(tx,ctx,row.companyId,true);return row;});
 await executeTaxBasisRecalculation(ctx,input,{resume:true,budgetMs:options.budgetMs});
 return {id};
}
