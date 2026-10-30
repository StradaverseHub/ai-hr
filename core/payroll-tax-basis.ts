/** Authorized, explicit historical tax-input corrections; original payslips are immutable inputs. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {requirePackFor} from '../localization/registry';
import type {StatutoryRuleset} from '../localization/country-pack';
import {readHistoryField,STATUTORY_IMPORT_CODES,STATUTORY_DESTINATIONS} from '../lib/payroll-history-import-schema';
import {PayrollTaxBasisError,type TaxBasisSelection,type TaxBasisPreview,type TaxBasisEmployee,type TaxBasisMonth,type TaxBasisValue,type TaxBasisBatch} from '../lib/payroll-tax-basis';
import {assertModuleGate} from './module-gate';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx,lockPayrollHistoryWriteTx} from './payroll-history-lock';
import {resolvePayrollPermission} from './payroll';
import {parsePayrollHistorySource} from './payroll-history-revisions';
import {taxBasisSourceHashTx,readEffectiveTaxBasesTx,validatedTaxBasis} from './payroll-tax-basis-read';
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_key,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const fail=(s:string):never=>{throw new PayrollTaxBasisError(s);};
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
type Settings={id:string;code:string;name:string;kind:string;includedInPcb:boolean;pcbRemunerationType:'normal'|'additional'|'optional_deduction'|null;pcbExemptionCode:string|null;isNonPayable:boolean;epfBonus2012:boolean;archivedAt:unknown};
async function settingsTx(tx:Tx,lock=false){
 return await tx.execute<Settings>(sql`select id,code,name,kind,included_in_pcb as "includedInPcb",pcb_remuneration_type as "pcbRemunerationType",pcb_exemption_code as "pcbExemptionCode",is_non_payable as "isNonPayable",epf_bonus_2012 as "epfBonus2012",archived_at as "archivedAt" from pay_component order by id ${lock?sql`for share`:sql``}`);
}
const basicSetting:Settings={id:'system-basic-salary',code:'BASIC',name:'Basic salary',kind:'allowance',includedInPcb:true,pcbRemunerationType:'normal',pcbExemptionCode:null,isNonPayable:false,epfBonus2012:false,archivedAt:null};
type SourceSlip={id:string;period:string;runOrder:number;gross:string;deductions:string;basic:string;allowance:string;overtime:string;bonus:string;statutory:Record<string,unknown>;historyAttemptId:string|null;cycleId:string|null};
type InputLine={code:string;amount:number;direction:'earning'|'deduction';previousTreatment?:string|null};
type SourceCache=Map<string,{retained:{name:string;sourceHash:string;rows:{rowNums:number[];values:unknown;companyId:string;employmentId:string;period:string;cycleId:string}[]};rows:Awaited<ReturnType<typeof parsePayrollHistorySource>>}>;
async function linesTx(tx:Tx,slip:SourceSlip,employmentId:string,companyId:string,settings:Settings[],cache:SourceCache):Promise<InputLine[]>{
 if(slip.historyAttemptId){
  let cached=cache.get(slip.historyAttemptId);
  if(!cached){const [retained]=await tx.execute<{name:string;content:Buffer;sourceHash:string;rows:{rowNums:number[];values:unknown;companyId:string;employmentId:string;period:string;cycleId:string}[]}>(sql`select a.source_name as name,a.source_content as content,a.source_hash as "sourceHash",a.plan->'rows' as rows from payroll_history_import_attempt a where a.id=${slip.historyAttemptId}::uuid`);
  if(!retained||createHash('sha256').update(retained.content).digest('hex')!==retained.sourceHash)fail(`${slip.period}: retained import source is unavailable or changed.`);
  cached={retained,rows:await parsePayrollHistorySource(retained.name,retained.content)};cache.set(slip.historyAttemptId,cached);}
  const {retained,rows}=cached;
  const plans=retained.rows.filter(r=>r.companyId===companyId&&r.employmentId===employmentId&&r.period===slip.period&&r.cycleId===slip.cycleId);
  if(plans.length!==1||!Array.isArray(plans[0].rowNums)||!plans[0].rowNums.length)fail(`${slip.period}: original source row binding is unavailable.`);
  const out:InputLine[]=[];
  for(const rowNum of plans[0].rowNums){
   const row=rows[rowNum-2];if(!row)fail(`${slip.period}: an original source row is missing.`);
   const code=readHistoryField(row,'doe_code').trim().toUpperCase();
   const builtin=STATUTORY_IMPORT_CODES.find(item=>item.code===code);
   // Imported statutory and cross-check figures retain their original separate owners.
   if(builtin&&(STATUTORY_DESTINATIONS.has(builtin.destination)||builtin.direction==='employer'||builtin.direction==='check'))continue;
   const candidates=settings.filter(s=>s.code.trim().toUpperCase()===code);
   if(code!=='BASIC'&&candidates.length!==1)fail(`${slip.period}: ${code} has no unambiguous saved Pay Item. Resolve its original mapping first.`);
   if(candidates.length>1)fail(`${slip.period}: ${code} is ambiguous.`);
   const amount=money(readHistoryField(row,'amount').replace(/[,_\s]/g,''));if(amount===null)fail(`${slip.period}: an original amount is not exact.`);
   out.push({code,amount,direction:candidates[0]?.kind==='deduction'?'deduction':'earning'});
  }
  return out;
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
 if(!basicIncluded&&Number(slip.basic)!==0){if(settings.some(s=>s.code==='BASIC'&&s.id!=='system-basic-salary'))fail(`${slip.period}: the original basic Pay Item identity is unavailable.`);out.unshift({code:'BASIC',amount:Number(slip.basic),direction:'earning'});}
 return out;
}
async function employeeTx(tx:Tx,ctx:SessionContext,selection:TaxBasisSelection,who:{id:string;employeeNo:string;name:string},settings:Settings[],settingsHash:string,cache:SourceCache=new Map()):Promise<TaxBasisEmployee>{
 const blocked=(reason:string):TaxBasisEmployee=>({...who,status:'blocked',reason,recordCount:0,beforeTaxable:null,difference:null,taxable:null,beforeExempt:null,exempt:null,months:[]});
 try{
  const slips=await tx.execute<SourceSlip>(sql`select p.id,b.pay_period as period,(row_number() over(partition by b.pay_period order by b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id))::integer as "runOrder",p.gross_pay as gross,p.basic_salary as basic,p.allowance,p.overtime_pay as overtime,p.bonus,p.other_deductions as deductions,p.statutory,b.history_import_attempt_id as "historyAttemptId",b.payroll_cycle_id as "cycleId" from payslip p join payroll_batch b on b.id=p.batch_id where p.employment_id=${who.id}::uuid and b.company_id=${selection.companyId}::uuid and b.pay_period like ${selection.year+'-%'} and b.status in ('processed','closed') order by b.pay_period,b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id`);
  const cutoff=selection.year+'-'+String(selection.upToMonth).padStart(2,'0'),included=slips.filter(s=>s.period<=cutoff);
  if(!included.length)return blocked('No saved payroll history exists in the selected period.');
  // A changed exemption/relief prefix cannot silently reallocate a later saved month.
  const [company]=await tx.execute<{country:string}>(sql`select country from company where id=${selection.companyId}::uuid`);
  const pack=requirePackFor(company.country);if(!pack.payroll.replayTaxBasis)fail('This country pack does not support historical income-tax corrections.');
  const rulesByPeriod:Record<string,{rules:StatutoryRuleset;hash:string}>={},rulesEvidence:Record<string,unknown>={};
  for(const period of [...new Set(included.map(s=>s.period))]){
   const resolved=await pack.payroll.loadRulesetResolved(tx,{asOf:period+'-01'});
   if(!resolved.version.startsWith(String(selection.year)+'.'))fail(`${period}: verified assessment-year rules are unavailable.`);
   rulesByPeriod[period]={rules:resolved.ruleset,hash:hash(resolved)};rulesEvidence[period]={version:resolved.version,source:resolved.source,effectiveFrom:resolved.effectiveFrom,packVersion:resolved.packVersion,signedKeyId:resolved.signedKeyId,pcbExemptions:resolved.ruleset.pcbExemptions};
  }
  const input=[];
  for(const slip of included)input.push({id:slip.id,period:slip.period,runOrder:slip.runOrder,sourceLines:await linesTx(tx,slip,who.id,selection.companyId,settings,cache),statutory:slip.statutory,expectedGross:Number(slip.gross),expectedOtherDeductions:Number(slip.deductions)});
  let openingExemptionUsed:Record<string,number>={};
  const capped=input.some(row=>row.sourceLines.some(line=>settings.some(setting=>setting.code.toUpperCase()===line.code.toUpperCase()&&setting.includedInPcb&&setting.pcbExemptionCode)));
  if(capped){
   const savedOpening=included.map(s=>s.statutory.taxBasisOpeningExemptionUsed);
   if(!savedOpening.every(object)||included.some(s=>s.statutory.taxBasisOpeningExemptionYear!==selection.year))fail('Original prior-employer exemption usage was not saved for this assessment year. Review its historical provenance before recalculation.');
   if(new Set(savedOpening.map(hash)).size!==1)fail('Saved prior-employer exemption provenance differs across the selected history.');
   openingExemptionUsed=savedOpening[0] as Record<string,number>;
  }
  const replay=pack.payroll.replayTaxBasis({year:selection.year,upToMonth:selection.upToMonth,slips:input,settings,rulesByPeriod,openingExemptionUsed});
  let effective:Awaited<ReturnType<typeof readEffectiveTaxBasesTx>>|null=null;
  // A fresh correction may explicitly supersede a stale source. It must still be exactly reconstructible.
  try{effective=await readEffectiveTaxBasesTx(tx,ctx,included.map(s=>s.id));}catch(error){if(!(error instanceof PayrollTaxBasisError)||!error.message.startsWith('Saved payroll changed'))throw error;}
  const months:TaxBasisMonth[]=[];let ytdTaxable=0,ytdExempt=0;
  for(const row of replay){
   const source=included.find(s=>s.id===row.payslipId)!;
   const prior=effective?.get(source.id)?.basis,st=source.statutory;
   const beforeTaxable=prior?.pcb??(object(st.bases)?money(st.bases.pcb):null),beforeExempt=prior?money(prior.exempt):object(st.exemptionUsed)?round(Object.entries(st.exemptionUsed).filter(([code])=>code.startsWith('PCB_')).reduce((n,[,v])=>n+(money(v)??0),0)):null;
   const exempt=money(row.basis.exempt);if(exempt===null)fail('The country pack did not return exact exemption evidence.');
   const old=await tx.execute<{id:string;basis:unknown}>(sql`select id,basis from payroll_tax_basis_revision where company_id=${selection.companyId}::uuid and employment_id=${who.id}::uuid and period=${source.period} and (payslip_id=${source.id}::uuid or payslip_id in (select previous.id from payroll_history_import_snapshot previous join payroll_history_import_snapshot current on current.record_id=previous.record_id where current.id=${source.id}::uuid)) order by id`);
   const basis={...validatedTaxBasis(row.basis),supersedes:old.map(r=>r.id),settingsHash,appliedSettings:settings.filter(setting=>row.basis.items.some(item=>item.code===setting.code)),rulesEvidence:rulesEvidence[row.period]};
   ytdTaxable=round(ytdTaxable+basis.pcb);ytdExempt=round(ytdExempt+exempt);
   months.push({payslipId:source.id,period:source.period,sourceHash:await taxBasisSourceHashTx(tx,source.id),beforeTaxable,taxable:basis.pcb,difference:beforeTaxable===null?null:round(basis.pcb-beforeTaxable),beforeExempt,exempt,ytdTaxable,ytdExempt,items:basis.items,basis});
  }
  const comparison=(b:TaxBasisValue)=>{const {supersedes,...values}=b;return values;};
  const changed=months.some(m=>!effective?.has(m.payslipId)||hash(comparison(effective.get(m.payslipId)!.basis))!==hash(comparison(m.basis)));
  if(changed&&slips.some(s=>s.period>cutoff)){
   const altersAllocation=months.some(m=>Object.keys(m.basis.exemptionUsed).length>0||object(included.find(s=>s.id===m.payslipId)!.statutory.exemptionUsed)&&Object.keys(included.find(s=>s.id===m.payslipId)!.statutory.exemptionUsed as object).length>0);
   if(altersAllocation)return blocked('Later saved months depend on annual exemption allocation. Extend the selected final month and preview again.');
  }
  const beforeTaxable=months.some(m=>m.beforeTaxable===null)?null:round(months.reduce((n,m)=>n+m.beforeTaxable!,0)),taxable=round(months.reduce((n,m)=>n+m.taxable,0)),beforeExempt=months.some(m=>m.beforeExempt===null)?null:round(months.reduce((n,m)=>n+m.beforeExempt!,0)),exempt=round(months.reduce((n,m)=>n+m.exempt,0));
  return {...who,status:changed?'ready':'unchanged',reason:null,recordCount:months.length,beforeTaxable,taxable,difference:beforeTaxable===null?null:round(taxable-beforeTaxable),beforeExempt,exempt,months};
 }catch(error){if(error instanceof PayrollTaxBasisError||error instanceof Error&&error.name==='TaxBasisReplayError')return blocked(error.message);throw error;}
}
async function computeTx(tx:Tx,ctx:SessionContext,selection:TaxBasisSelection):Promise<Omit<TaxBasisPreview,'previewId'|'previewHash'|'createdAt'|'expiresAt'>>{
 await permission(tx,ctx,selection.companyId);
 const [company]=await tx.execute<{name:string}>(sql`select legal_name as name from company where id=${selection.companyId}::uuid and archived_at is null`);if(!company)fail('Company is unavailable.');
 const settings=await settingsTx(tx);if(!settings.some(s=>s.code.toUpperCase()==='BASIC'))settings.push(basicSetting);const settingsHash=hash(settings);
 const employees=await tx.execute<{id:string;employeeNo:string;name:string}>(sql`select id,"employeeNo",name from app.payroll_tax_basis_subjects(${selection.companyId}::uuid,${selection.year},${selection.upToMonth}) ${selection.employmentIds===null?sql``:sql`where id=any(${selection.employmentIds}::uuid[])`} order by "employeeNo",id`);
 if(selection.employmentIds!==null&&employees.length!==selection.employmentIds.length)fail('An employee is unavailable, belongs to another company, or has no history in the selected period.');
 if(employees.length>1000)fail('Select up to 1,000 employees per preview. Split a larger company into selected employee groups.');
 const results:TaxBasisEmployee[]=[],cache:SourceCache=new Map(),started=Date.now();for(const who of employees){if(Date.now()-started>25000)fail('This preview is too large. Select a smaller employee group and preview again.');results.push(await employeeTx(tx,ctx,selection,who,settings,settingsHash,cache));}
 const ready=results.filter(r=>r.status==='ready');
 const sum=(key:'beforeTaxable'|'taxable'|'beforeExempt'|'exempt')=>ready.some(r=>r[key]===null)?null:round(ready.reduce((n,r)=>n+r[key]!,0));
 const beforeTaxable=sum('beforeTaxable'),taxable=sum('taxable');
 return {companyId:selection.companyId,companyName:company.name,year:selection.year,upToMonth:selection.upToMonth,selection:selection.employmentIds===null?'all':'selected',settingsHash,totals:{beforeTaxable,taxable,difference:beforeTaxable===null||taxable===null?null:round(taxable-beforeTaxable),beforeExempt:sum('beforeExempt'),exempt:sum('exempt')},eligibleCount:ready.length,unchangedCount:results.filter(r=>r.status==='unchanged').length,blockedCount:results.filter(r=>r.status==='blocked').length,recordCount:ready.reduce((n,r)=>n+r.recordCount,0),employees:results};
}
export async function taxBasisOptions(ctx:SessionContext){return withTenant(ctx,async tx=>{
 await lockPayrollHistoryReadTx(tx,ctx.tenantId);
 const rows=await tx.execute<{id:string;name:string}>(sql`select id,legal_name as name from company where archived_at is null and app.can_admin_payroll_for(id) order by legal_name`);
 const companies:(typeof rows[number]&{canRecalculate:boolean})[]=[];let canRecalculate=false;for(const c of rows){if(await resolvePayrollPermission(tx,ctx,'payroll.tax-basis.view',c.id)){const allowed=await resolvePayrollPermission(tx,ctx,'payroll.tax-basis.recalculate',c.id);companies.push({...c,canRecalculate:allowed});if(allowed)canRecalculate=true;}}
 const ids=companies.map(c=>c.id);if(!ids.length)fail('Income-tax recalculation access is unavailable.');assertModuleGate(ctx,'payroll');
 const employees: {id:string;companyId:string;employeeNo:string;name:string}[]=[];
 for(const id of ids){const subjects=await tx.execute<{id:string;employeeNo:string;name:string}>(sql`select * from app.payroll_tax_basis_subjects(${id}::uuid,null,null)`);employees.push(...subjects.map(s=>({...s,companyId:id})));}
 const years=await tx.execute<{year:number}>(sql`select distinct left(pay_period,4)::integer as year from payroll_batch where company_id=any(${ids}::uuid[]) and status in ('processed','closed') order by year desc`);return {companies,employees,years:years.map(r=>r.year),canRecalculate};
 });}
export async function previewTaxBasisRecalculation(ctx:SessionContext,selection:TaxBasisSelection):Promise<TaxBasisPreview>{validateSelection(selection);return withTenant(ctx,async tx=>{
 await lockPayrollHistoryReadTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await permission(tx,ctx,selection.companyId,true);const computed=await computeTx(tx,ctx,selection);const id=randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+15*60000).toISOString();const previewHash=hash({selection,computed});
 const preview:TaxBasisPreview={...computed,previewId:id,previewHash,createdAt,expiresAt};await tx.execute(sql`insert into payroll_tax_basis_preview(id,tenant_id,company_id,created_by,preview,selection,preview_hash,expires_at) values(${id}::uuid,${ctx.tenantId}::uuid,${selection.companyId}::uuid,${ctx.userId!}::uuid,${JSON.stringify(preview)}::jsonb,${JSON.stringify(selection)}::jsonb,${previewHash},${expiresAt}::timestamptz)`);return preview;
 });}
async function recordEventTx(tx:Tx,ctx:SessionContext,batchId:string,companyId:string,kind:string,detail:unknown={},employmentId:string|null=null){await tx.execute(sql`insert into payroll_tax_basis_event(tenant_id,company_id,batch_id,employment_id,actor_id,kind,detail) values(${ctx.tenantId}::uuid,${companyId}::uuid,${batchId}::uuid,${employmentId}::uuid,${ctx.userId!}::uuid,${kind},${JSON.stringify(detail)}::jsonb)`);}
async function executeTaxBasisRecalculation(ctx:SessionContext,input:{previewId:string;previewHash:string},resume=false):Promise<{id:string}>{
 if(!uuid.test(input.previewId)||!/^[a-f0-9]{64}$/.test(input.previewHash))fail('Choose a valid recalculation preview.');
 const opened=await withTenant(ctx,async tx=>{
  await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);
  const [stored]=await tx.execute<{preview:TaxBasisPreview;selection:TaxBasisSelection;previewHash:string;expired:boolean}>(sql`select preview,selection,preview_hash as "previewHash",expires_at<now() as expired from payroll_tax_basis_preview where id=${input.previewId}::uuid and created_by=${ctx.userId??null}::uuid for update`);
  if(!stored||stored.previewHash!==input.previewHash)fail('The recalculation preview is unavailable.');await permission(tx,ctx,stored.selection.companyId,true);
  const [existing]=await tx.execute<{id:string}>(sql`select id from payroll_tax_basis_batch where preview_id=${input.previewId}::uuid`);
  if(existing)return {...stored,id:existing.id,existing:true};
  if(stored.expired)fail('The preview expired. Preview the recalculation again.');
  const fresh=await computeTx(tx,ctx,stored.selection);if(hash({selection:stored.selection,computed:fresh})!==stored.previewHash)fail('History, settings, rules or access changed. Preview the recalculation again.');
  if(!stored.preview.eligibleCount)fail('There are no eligible changed employees to recalculate.');
  const id=randomUUID();await tx.execute(sql`insert into payroll_tax_basis_batch(id,tenant_id,company_id,preview_id,created_by) values(${id}::uuid,${ctx.tenantId}::uuid,${stored.selection.companyId}::uuid,${input.previewId}::uuid,${ctx.userId!}::uuid)`);await recordEventTx(tx,ctx,id,stored.selection.companyId,'pending');return {...stored,id,existing:false};
 });
 if(opened.existing&&!resume)return {id:opened.id};
 const processed=await withTenant(ctx,async tx=>{await permission(tx,ctx,opened.selection.companyId,true);return tx.execute<{kind:string;employmentId:string|null}>(sql`select kind,employment_id as "employmentId" from payroll_tax_basis_event where batch_id=${opened.id}::uuid`);});
 if(processed.some(e=>['completed','completed_with_errors','failed'].includes(e.kind)))return {id:opened.id};
 const done=new Set(processed.filter(e=>e.employmentId).map(e=>e.employmentId));
 const chunk=opened.preview.employees.filter(e=>e.status==='ready'&&!done.has(e.id)).slice(0,50),started=Date.now(),cache:SourceCache=new Map();
 // Each employee/year commits with all correction rows and its audit event, or none of them.
 for(const reviewed of chunk){if(Date.now()-started>40000)break;
  try{await withTenant(ctx,async tx=>{
   await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await permission(tx,ctx,opened.selection.companyId,true);
   await tx.execute(sql`select id from payroll_tax_basis_batch where id=${opened.id}::uuid for update`);
   const prior=await tx.execute(sql`select id from payroll_tax_basis_event where batch_id=${opened.id}::uuid and ((employment_id=${reviewed.id}::uuid and kind in ('employee_completed','employee_failed')) or kind in ('completed','completed_with_errors','failed'))`);if(prior.length)return;
   const settings=await settingsTx(tx,true);if(!settings.some(s=>s.code.toUpperCase()==='BASIC'))settings.push(basicSetting);if(hash(settings)!==opened.preview.settingsHash)fail('Pay Item settings changed. Create a new preview for remaining employees.');
   const fresh=await employeeTx(tx,ctx,opened.selection,{id:reviewed.id,name:reviewed.name,employeeNo:reviewed.employeeNo},settings,opened.preview.settingsHash,cache);
   if(hash(fresh)!==hash(reviewed))fail('Employee history, rules or opening balances changed. Create a new preview.');
   await recordEventTx(tx,ctx,opened.id,opened.selection.companyId,'processing');
   for(const m of reviewed.months){
    const [last]=await tx.execute<{ordinal:number}>(sql`select coalesce(max(ordinal),0)::integer as ordinal from payroll_tax_basis_revision where payslip_id=${m.payslipId}::uuid`);
    await tx.execute(sql`insert into payroll_tax_basis_revision(tenant_id,company_id,employment_id,payslip_id,period,source_hash,ordinal,batch_id,basis,supersedes) values(${ctx.tenantId}::uuid,${opened.selection.companyId}::uuid,${reviewed.id}::uuid,${m.payslipId}::uuid,${m.period},${m.sourceHash},${last.ordinal+1},${opened.id}::uuid,${JSON.stringify(m.basis)}::jsonb,${m.basis.supersedes as string[]}::uuid[])`);
   }
   await recordEventTx(tx,ctx,opened.id,opened.selection.companyId,'employee_completed',reviewed,reviewed.id);await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-tax-basis',aggregateId:opened.id,eventType:'payroll.tax-basis.corrected',actor:actorOf(ctx),subjectEmploymentId:reviewed.id,payload:{companyId:opened.selection.companyId,year:opened.selection.year,upToMonth:opened.selection.upToMonth,recordCount:reviewed.recordCount,previewHash:input.previewHash}});
  });}catch(error){
   // Failed employee transactions are rolled back; the failure remains a separate durable outcome.
   await withTenant(ctx,async tx=>{await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await permission(tx,ctx,opened.selection.companyId,true);const already=await tx.execute(sql`select id from payroll_tax_basis_event where batch_id=${opened.id}::uuid and ((employment_id=${reviewed.id}::uuid and kind in ('employee_completed','employee_failed')) or kind in ('completed','completed_with_errors','failed'))`);if(already.length)return;await recordEventTx(tx,ctx,opened.id,opened.selection.companyId,'employee_failed',{...reviewed,status:'failed',reason:error instanceof PayrollTaxBasisError?error.message:'The employee could not be recalculated. Review the source before retrying.'},reviewed.id);});
  }
 }
 await withTenant(ctx,async tx=>{await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await permission(tx,ctx,opened.selection.companyId,true);const terminal=await tx.execute(sql`select id from payroll_tax_basis_event where batch_id=${opened.id}::uuid and kind in ('completed','completed_with_errors','failed')`);if(terminal.length)return;const [counts]=await tx.execute<{ok:number}>(sql`select count(distinct employment_id)::integer as ok from payroll_tax_basis_event where batch_id=${opened.id}::uuid and kind='employee_completed'`);const total=opened.preview.eligibleCount;const [processed]=await tx.execute<{count:number}>(sql`select count(distinct employment_id)::integer as count from payroll_tax_basis_event where batch_id=${opened.id}::uuid and kind in ('employee_completed','employee_failed')`);if(processed.count<total)return;await recordEventTx(tx,ctx,opened.id,opened.selection.companyId,counts.ok===total?'completed':counts.ok?'completed_with_errors':'failed');});return {id:opened.id};
}
export async function listTaxBasisBatches(ctx:SessionContext,requestedId?:string):Promise<TaxBasisBatch[]>{return withTenant(ctx,async tx=>{
 const rows=await tx.execute<{id:string;companyId:string;preview:TaxBasisPreview;createdAt:string;actorName:string}>(sql`select b.id,b.company_id as "companyId",p.preview,b.created_at::text as "createdAt",coalesce(actor.full_name,b.created_by::text) as "actorName" from payroll_tax_basis_batch b join payroll_tax_basis_preview p on p.id=b.preview_id left join app_user u on u.id=b.created_by left join person actor on actor.id=u.person_id ${requestedId?sql`where b.id=${requestedId}::uuid`:sql``} order by b.created_at desc,b.id desc limit 100`);
 const result:TaxBasisBatch[]=[];for(const row of rows){if(!await resolvePayrollPermission(tx,ctx,'payroll.tax-basis.view',row.companyId))continue;await permission(tx,ctx,row.companyId);const events=await tx.execute<{kind:string;employmentId:string|null;detail:TaxBasisEmployee;createdAt:string}>(sql`select kind,employment_id as "employmentId",detail,created_at::text as "createdAt" from payroll_tax_basis_event where batch_id=${row.id}::uuid order by created_at,id`);const outcomes=new Map<string,TaxBasisEmployee>();for(const e of events)if(e.employmentId)outcomes.set(e.employmentId,{...e.detail,status:e.kind==='employee_completed'?'completed':'failed'});const employees=row.preview.employees.map(e=>outcomes.get(e.id)??e),completedCount=employees.filter(e=>e.status==='completed').length,failedCount=employees.filter(e=>e.status==='failed').length;const final=[...events].reverse().find(e=>['completed','completed_with_errors','failed'].includes(e.kind));result.push({id:row.id,reference:'TAX-'+row.id.slice(0,8).toUpperCase(),companyId:row.companyId,companyName:row.preview.companyName,year:row.preview.year,upToMonth:row.preview.upToMonth,selection:row.preview.selection,status:final?final.kind as TaxBasisBatch['status']:events.some(e=>e.kind==='processing')?'processing':'pending',createdAt:row.createdAt,completedAt:final?.createdAt??null,actorName:row.actorName,employeeCount:row.preview.eligibleCount,recordCount:row.preview.recordCount,completedCount,failedCount,employees,recoverable:!final&&Date.now()-new Date(events.at(-1)?.createdAt??row.createdAt).getTime()>300000});}return result;
 });}
export async function getTaxBasisBatch(ctx:SessionContext,id:string):Promise<TaxBasisBatch|null>{if(!uuid.test(id))return null;return (await listTaxBasisBatches(ctx,id)).find(b=>b.id===id)??null;}
/** Explicitly close an interrupted batch; every unfinished employee must get a fresh preview. */
export async function recoverTaxBasisBatch(ctx:SessionContext,id:string):Promise<{id:string}>{
 if(!uuid.test(id))fail('Choose a valid recalculation batch.');
 return withTenant(ctx,async tx=>{
  await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);
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
