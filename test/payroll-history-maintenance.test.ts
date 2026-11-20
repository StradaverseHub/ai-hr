/** Fictional accepted history; canonical API and actual RLS/immutable owner guards. */
import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,previewPayrollHistoryMaintenanceSource,previewPayrollHistoryRevert,revertPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {previewPayrollHistoryMaintenance} from '../core/payroll-history-maintenance';
import {payrollHistoryMaintenanceRecords,payrollHistoryMaintenanceRecord} from '../core/payroll-history-maintenance-read';
import {requestPayrollHistoryConfirm} from '../core/payroll-history-job';
import {readEffectiveTaxBasesTx} from '../core/payroll-tax-basis-read';
import {previewTaxBasisRecalculation} from '../core/payroll-tax-basis';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {PayrollHistoryMaintenanceRequest} from '../lib/payroll-history-maintenance';
import type {HistoryContributionState} from '../lib/payroll-history-maintenance-lineage';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,employmentId:string,trvId:string,otherId:string;
const year=Number(todayInKualaLumpur().slice(0,4)),period=year+'-01';
const csv=(lines:readonly [string,string][],month=period)=>Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...lines.map(([code,amount])=>['F001',month,'ME',code,'CO',amount])]));
const upload=(lines:readonly [string,string][],mode?:'replace'|'update_listed')=>previewPayrollHistoryUpload(ctx,{name:'fictional.csv',content:csv(lines),...(mode?{maintenance:{version:1,mode,reason:'Reviewed fictional history maintenance'}}:{})});
const commit=(review:Awaited<ReturnType<typeof upload>>)=>confirmPayrollHistoryUpload(ctx,{attemptId:review.attemptId,previewHash:review.plan.previewHash,confirmReplacement:true});
const accept=async(lines:readonly [string,string][],mode?:'replace'|'update_listed')=>{const review=await upload(lines,mode);expect(review.plan.issues).toEqual([]);expect(review.plan.counts.invalid).toBe(0);await commit(review);return review;};
async function sqlRefusal(action:Promise<unknown>,state:string,reason:RegExp){let caught:unknown;try{await action;}catch(error){caught=error;}expect(caught).toBeDefined();let matched=false;for(let depth=0,value=caught;depth<8&&value&&typeof value==='object';depth++){const error=value as {code?:unknown;message?:unknown;cause?:unknown};if(error.code===state&&typeof error.message==='string'&&reason.test(error.message))matched=true;value=error.cause;}expect(matched,'Expected the canonical SQL refusal and reason in the actual cause chain').toBe(true);}
const detail=async()=>{const page=await payrollHistoryMaintenanceRecords(ctx,{includeWithdrawn:true});expect(page.total).toBe(1);return(await payrollHistoryMaintenanceRecord(ctx,page.items[0].id))!;};
const maintain=async(request:PayrollHistoryMaintenanceRequest)=>{const review=await previewPayrollHistoryMaintenance(ctx,request);expect(review.plan.counts.invalid).toBe(0);await commit(review);return review;};
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);await owner.db.update(schema.company).set({companyLabel:'CO'}).where(eq(schema.company.id,b.companyId));await seedPayrollCycleCatalog(ctx,b.companyId);
 const components=await owner.db.insert(schema.payComponent).values([{tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic',includedInPcb:true,pcbRemunerationType:'normal'},{tenantId:b.tenantId,code:'TRV',name:'Travel',kind:'allowance',displayCategory:'allowance',includedInPcb:true,pcbRemunerationType:'normal'},{tenantId:b.tenantId,code:'OTHER',name:'Other allowance',kind:'allowance',displayCategory:'allowance',includedInPcb:true,pcbRemunerationType:'normal'}]).returning();trvId=components.find(row=>row.code==='TRV')!.id;otherId=components.find(row=>row.code==='OTHER')!.id;
 await owner.db.insert(schema.payrollImportCode).values({tenantId:b.tenantId,code:'ALIAS',label:'Travel alias',destination:'allowance',direction:'earning',aliasFor:'TRV'});
 employmentId=(await hireEmployee(ctx,{person:{fullName:'Fictional maintenance employee',primaryEmail:'fictional-maintenance@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'F001',hiredOn:(year-1)+'-01-01'})).employmentId;
});
afterAll(closeAll);
it('imports after employment ends without dated coverage, then corrects tax inputs and removes the same imported history', async () => {
 await owner.db.update(schema.employment).set({terminatedOn:year + '-01-15'}).where(eq(schema.employment.id, employmentId));
 await owner.db.update(schema.assignment).set({companyId:null}).where(eq(schema.assignment.employmentId, employmentId));
 const month=year + '-02';
 const load=(lines:readonly [string,string][])=>previewPayrollHistoryUpload(ctx,{
  name:'final-pay.csv',content:csv(lines,month),maintenance:{version:1,mode:'replace'},
 });
 const amounts:[string,string][]=[['BASIC','1000.00'],['TRV','200.00'],['PCB','50.00'],['EREPF','130.00']];
 const first=await load(amounts);
 expect(first.plan.counts).toEqual({created:1,replaced:0,unchanged:0,invalid:0});
 await commit(first);
 const corrected=await load([['BASIC','1000.00'],['TRV','300.00'],['PCB','50.00'],['EREPF','130.00']]);
 expect(corrected.plan.counts).toEqual({created:0,replaced:1,unchanged:0,invalid:0});
 await commit(corrected);
 const row=await detail();
 expect(row.values).toMatchObject({grossPay:'1300.00',statutory:{pcb:50,epfEmployer:130}});
 expect(row.values?.statutory).not.toHaveProperty('segment');
 const basis=await previewTaxBasisRecalculation(ctx,{companyId:b.companyId,year,upToMonth:2,employmentIds:[employmentId]});
 expect(basis.employees[0].months).toEqual(expect.arrayContaining([expect.objectContaining({taxable:1300})]));
 const removal=await previewPayrollHistoryRevert(ctx,corrected.attemptId);
 await revertPayrollHistoryUpload(ctx,corrected.attemptId,removal.previewHash);
 expect((await detail()).values).toMatchObject({grossPay:'1200.00',statutory:{pcb:50,epfEmployer:130}});
 const remaining=await previewPayrollHistoryRevert(ctx,first.attemptId);
 await revertPayrollHistoryUpload(ctx,first.attemptId,remaining.previewHash);
 expect(await detail()).toMatchObject({withdrawn:true, auditTotal:4});
 const [employment]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employmentId));
 expect(employment).toMatchObject({companyId:b.companyId,terminatedOn:year+'-01-15'});
});

it('reports an unknown Employee ID at the source row and blocks the whole workbook', async () => {
 const good=await accept([['BASIC','1000.00'],['PCB','50.00']],'replace');
 const before=await detail();
 const incoming=Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),
  ['F001',period,'ME','BASIC','CO','1700.00'],
  ['F001',period,'ME','PCB','CO','50.00'],
  ['MISSING',period,'ME','BASIC','CO','100.00'],
 ]));
 const rejected=await previewPayrollHistoryUpload(ctx,{name:'mixed.csv',content:incoming,maintenance:{version:1,mode:'replace'}});
 expect(rejected.plan.issues).toEqual(expect.arrayContaining([
  {rowNum:4,reason:'Employee ID does not exist in Employee Master or is outside your payroll scope.'},
 ]));
 await expect(commit(rejected)).rejects.toThrow(/Correct the file/);
 expect((await detail()).currentRevisionId).toBe(before.currentRevisionId);
 expect((await detail()).items.find(item=>item.code==='BASIC')?.sourceAttemptId).toBe(good.attemptId);
});

it('sets repeated alias totals and preserves every unlisted original item and imported statutory amount',async()=>{
 const original=await accept([['BASIC','1000.00'],['TRV','500.00'],['OTHER','100.00'],['PCB','50.00'],['EREPF','130.00']]);const old=(await detail()).values;
 const review=await accept([['ALIAS','100.00'],['TRV','200.00']],'update_listed');expect(review.plan.rows[0].rowNums).toEqual([2,3]);expect(review.plan.rows[0].itemChanges?.find(item=>item.code==='TRV')).toMatchObject({before:'500.00',after:'300.00'});
 const current=await detail();expect(current.values).toMatchObject({basicSalary:'1000.00',allowance:'400.00',grossPay:'1400.00',totalDeductions:'50.00',netPay:'1350.00',statutory:{pcb:50,epfEmployer:130}});expect(current.items.find(item=>item.code==='OTHER')).toMatchObject({amount:'100.00',sourceAttemptId:original.attemptId});
 const [saved]=await owner.db.select().from(schema.payrollHistoryImportSnapshot).where(eq(schema.payrollHistoryImportSnapshot.id,original.plan.rows[0].expectedSnapshotId??(await owner.db.select().from(schema.payrollHistoryImportRevision).where(eq(schema.payrollHistoryImportRevision.attemptId,original.attemptId)))[0].snapshotId!));expect(saved.values).toEqual(old);
});
it('full replacement and an identical retry set totals once, with no duplicate accepted revision',async()=>{
 await accept([['BASIC','1000.00'],['TRV','500.00'],['PCB','50.00']]);const replacement=await accept([['BASIC','1200.00'],['PCB','40.00']],'replace');expect((await detail()).values).toMatchObject({allowance:'0.00',grossPay:'1200.00',netPay:'1160.00'});const before=(await detail()).auditTotal;
 expect((await commit(replacement)).alreadyCommitted).toBe(true);const retry=await upload([['BASIC','1200.00'],['PCB','40.00']],'replace');expect(retry.plan.counts).toMatchObject({unchanged:1,created:0,replaced:0});expect((await detail()).auditTotal).toBe(before);
});
it('removes an earlier batch at every depth while retaining later edited totals and zero tombstones',async()=>{
 const a=await accept([['BASIC','1000.00'],['TRV','500.00'],['PCB','50.00']]);const before=await detail();const edit=await maintain({version:1,operation:'edit',recordId:before.id,expectedRevisionId:before.currentRevisionId,items:[{key:'component:'+trvId,amount:'200.00'}],reason:'Correct the selected travel total'});
 await maintain({version:1,operation:'remove_batch',attemptId:a.attemptId,reason:'Remove only this original upload'});expect((await detail()).values).toMatchObject({basicSalary:'0.00',allowance:'200.00',grossPay:'200.00',statutory:{pcb:0}});expect((await detail()).items).toEqual([expect.objectContaining({code:'TRV',amount:'200.00',sourceAttemptId:edit.attemptId})]);
 await maintain({version:1,operation:'remove_batch',attemptId:edit.attemptId,reason:'Remove the later edit too'});expect(await detail()).toMatchObject({withdrawn:true,values:null,itemCount:0});expect((await payrollHistoryMaintenanceRecords(ctx)).total).toBe(0);
});
it('removes selected items by exact revision, keeps unlisted items, and reimports the same withdrawn identity',async()=>{
 await accept([['BASIC','1000.00'],['TRV','500.00'],['PCB','50.00']],'replace');const old=await detail();
 await maintain({version:1,operation:'remove_items',recordId:old.id,expectedRevisionId:old.currentRevisionId,itemKeys:['component:'+trvId],reason:'Remove the travel line'});expect((await detail()).values).toMatchObject({basicSalary:'1000.00',allowance:'0.00',statutory:{pcb:50}});
 await expect(previewPayrollHistoryMaintenance(ctx,{version:1,operation:'edit',recordId:old.id,expectedRevisionId:old.currentRevisionId,items:[{key:'destination:basic',amount:'900.00'}],reason:'Stale revision'})).rejects.toThrow(/revision changed/);
 const current=await detail();await maintain({version:1,operation:'remove_items',recordId:current.id,expectedRevisionId:current.currentRevisionId,itemKeys:current.items.map(item=>item.key),reason:'Withdraw remaining imported items'});expect((await detail()).withdrawn).toBe(true);
 await accept([['BASIC','800.00'],['PCB','0.00']],'replace');expect((await detail()).id).toBe(old.id);expect((await detail()).values?.grossPay).toBe('800.00');
});
it('preserves a retained unlisted cash destination after a current display-category edit',async()=>{
 await accept([['BASIC','1000.00'],['TRV','500.00'],['PCB','50.00']]);await owner.db.update(schema.payComponent).set({displayCategory:'bonus'}).where(eq(schema.payComponent.id,trvId));await accept([['BASIC','1200.00']],'update_listed');expect((await detail()).values).toMatchObject({allowance:'500.00',bonus:'0.00',grossPay:'1700.00'});
});
it('keeps original GROSS/NETPAY validation and refuses mixed internal operation descriptors',async()=>{
 await accept([['BASIC','1000.00'],['TRV','500.00'],['PCB','50.00']]);const bad=await upload([['TRV','200.00'],['GROSS','9999.00']],'update_listed');expect(bad.plan.counts.invalid).toBeGreaterThan(0);await expect(commit(bad)).rejects.toThrow();const old=await detail();
 await expect(previewPayrollHistoryMaintenanceSource(ctx,{name:'fictional.csv',content:csv([['BASIC','0.00']]),maintenance:{version:1,mode:'edit',reason:'A mismatched removal',request:{version:1,operation:'remove_batch',attemptId:randomUUID(),reason:'A mismatched removal'}}})).rejects.toThrow(/does not match/);expect((await detail()).currentRevisionId).toBe(old.currentRevisionId);
});
it('compatibility Revert returns a current removal plan and preserves a later correction',async()=>{
 const a=await accept([['BASIC','1000.00'],['PCB','50.00']]),b=await accept([['BASIC','1200.00'],['PCB','40.00']],'replace');const review=await previewPayrollHistoryRevert(ctx,a.attemptId);expect(review.plan.rows[0].values).toMatchObject({basicSalary:'1200.00'});expect(review.count).toBe(1);await revertPayrollHistoryUpload(ctx,a.attemptId,review.previewHash);expect((await detail()).values?.basicSalary).toBe('1200.00');const later=await previewPayrollHistoryRevert(ctx,b.attemptId);await revertPayrollHistoryUpload(ctx,b.attemptId,later.previewHash);expect((await detail()).withdrawn).toBe(true);
});
it('rejects direct legacy pointer restoration and direct import writes when the actual granular permission is denied',async()=>{
 const first=await accept([['BASIC','1000.00'],['PCB','50.00']]),second=await accept([['BASIC','1200.00'],['PCB','40.00']]);const current=await detail(),old=await owner.db.select().from(schema.payrollHistoryImportRevision).where(eq(schema.payrollHistoryImportRevision.attemptId,first.attemptId));const own=await upload([['BASIC','900.00'],['PCB','0.00']]);
 await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'payroll.history.revert',role:'hr_admin',allowed:false});
 await sqlRefusal(withTenant(ctx,tx=>tx.insert(schema.payrollHistoryImportRevision).values({tenantId:b.tenantId,recordId:current.id,ordinal:3,attemptId:own.attemptId,previousRevisionId:current.currentRevisionId,snapshotId:old[0].snapshotId,kind:'correction',cycleName:'Month end'})),'42501',/legacy correction|withdrawal|authority/);
 await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'payroll.history.import',role:'hr_admin',allowed:false});
 await sqlRefusal(withTenant(ctx,tx=>tx.insert(schema.payrollHistoryImportRevision).values({tenantId:b.tenantId,recordId:current.id,ordinal:3,attemptId:second.attemptId,previousRevisionId:current.currentRevisionId,snapshotId:old[0].snapshotId,kind:'correction',cycleName:'Month end'})),'42501',/authority/);expect((await owner.db.select().from(schema.payrollHistoryImportRevision).where(eq(schema.payrollHistoryImportRevision.recordId,current.id)))).toHaveLength(2);
});
it('does not let equal amounts or caller-posted aliases forge an older canonical item owner',async()=>{
 const accepted=await accept([['BASIC','1000.00'],['OTHER','500.00'],['PCB','50.00']]),current=await detail();const [source]=await withTenant(ctx,tx=>tx.select().from(schema.payrollHistoryImportAttempt).where(eq(schema.payrollHistoryImportAttempt.id,accepted.attemptId)));const forged=structuredClone((await withTenant(ctx,async tx=>(await tx.select().from(schema.payrollHistoryImportRevision).where(eq(schema.payrollHistoryImportRevision.recordId,current.id)))[0])));
 const basic=current.items.find(item=>item.code==='BASIC')!,pcb=current.items.find(item=>item.code==='PCB')!,other=current.items.find(item=>item.code==='OTHER')!;
 const owned=(item:typeof basic,key=item.key,code=item.code)=>({attemptId:accepted.attemptId,item:{key,code,label:code,amount:item.amount,destination:code==='BASIC'?'basic':code==='PCB'?'pcb':'allowance',direction:code==='PCB'?'statutory':'earning',originalCodes:code==='TRV'?['OTHER']:item.originalCodes,sourceRows:[2]}});
 const state:HistoryContributionState={version:1,baselineSnapshotId:null,chains:{[basic.key]:[owned(basic) as HistoryContributionState['chains'][string][number]],[pcb.key]:[owned(pcb) as HistoryContributionState['chains'][string][number]],['component:'+trvId]:[owned(other,'component:'+trvId,'TRV') as HistoryContributionState['chains'][string][number]]}};
 const id=randomUUID(),reason='Forged alias cannot own another component',plan={...source.plan,maintenance:{version:1 as const,mode:'update_listed' as const,reason},rows:source.plan.rows.map(row=>({...row,contributions:state}))};await withTenant(ctx,tx=>tx.insert(schema.payrollHistoryImportAttempt).values({...source,id,operationKey:randomUUID(),plan}));
 await sqlRefusal(withTenant(ctx,tx=>tx.insert(schema.payrollHistoryImportRevision).values({tenantId:b.tenantId,recordId:current.id,ordinal:2,attemptId:id,previousRevisionId:forged.id,snapshotId:forged.snapshotId,kind:'correction',cycleName:'Month end',maintenance:{version:1,state,operation:'update_listed',reason}})),'23514',/proof|lineage|chain|owner/);expect(otherId).not.toBe(trvId);expect((await detail()).currentRevisionId).toBe(current.currentRevisionId);
});

it('replays merged listed and unlisted items through the historical tax preview while keeping original PCB paid',async()=>{
 await accept([['BASIC','1000.00'],['TRV','500.00'],['OTHER','100.00'],['PCB','50.00']]);await accept([['ALIAS','200.00']],'update_listed');
 const before=await detail(),preview=await previewTaxBasisRecalculation(ctx,{companyId:b.companyId,year,upToMonth:1,employmentIds:[employmentId]});expect(preview.employees[0].reason).toBeNull();expect(preview.employees[0].months[0]).toMatchObject({taxable:1300});expect(preview.employees[0].months[0].items).toEqual(expect.arrayContaining([expect.objectContaining({code:'BASIC',amount:1000}),expect.objectContaining({code:'TRV',amount:200}),expect.objectContaining({code:'OTHER',amount:100})]));expect(preview.employees[0].pcbComparison).toMatchObject({originalPaid:50});expect((await detail()).values).toEqual(before.values);
});

it('holds case-folded duplicate configured codes rather than choosing an arbitrary component UUID',async()=>{
 await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'trv',name:'Fictional ambiguous duplicate',kind:'allowance',displayCategory:'allowance'});
 const preview=await upload([['BASIC','1000.00'],['TRV','500.00'],['PCB','0.00']],'replace');
 expect(preview.plan.issues).toContainEqual({rowNum:3,reason:'Unknown or unavailable Pay Item Code “TRV”.'});expect(await owner.db.select().from(schema.payrollHistoryImportRecord)).toEqual([]);
});

it('refuses new legacy or unknown kernel removal operations and admits the saved versioned removal as confirm',async()=>{
 const original=await accept([['BASIC','1000.00'],['PCB','50.00']]);
 for(const operation of ['revert','unknown'])await sqlRefusal(withTenant(ctx,tx=>tx.execute(sql`select app.bulk_job_enqueue('payroll_history',${randomUUID()}::uuid,ARRAY[${b.companyId}::uuid],'',null::bytea,${JSON.stringify({operation,attemptId:original.attemptId,previewHash:'0'.repeat(64)})}::jsonb)`)),'42501',/reviewed maintenance receipt/);
 const review=await previewPayrollHistoryMaintenance(ctx,{version:1,operation:'remove_batch',attemptId:original.attemptId,reason:'Reviewed removal has its own immutable reason'}),job=await requestPayrollHistoryConfirm(ctx,{attemptId:review.attemptId,previewHash:review.plan.previewHash,confirmReplacement:true});if(!('jobId' in job))throw Error('Expected a newly admitted maintenance job');const [saved]=await owner.db.select().from(schema.bulkJob).where(eq(schema.bulkJob.id,job.jobId));expect(saved.input).toMatchObject({operation:'confirm',attemptId:review.attemptId,previewHash:review.plan.previewHash});expect((await detail()).withdrawn).toBe(false);
});
it('requires an actual preexisting sealed worker step for raw legacy restoration, even with removal authority or physical owner access',async()=>{
 const original=await accept([['BASIC','1000.00'],['PCB','50.00']]),current=await detail(),row={tenantId:b.tenantId,recordId:current.id,ordinal:2,attemptId:original.attemptId,previousRevisionId:current.currentRevisionId,snapshotId:null,kind:'revert' as const,cycleName:'Month end'};
 await sqlRefusal(withTenant(ctx,tx=>tx.insert(schema.payrollHistoryImportRevision).values(row)),'42501',/sealed worker step/);await sqlRefusal(owner.withTenant(ctx,tx=>tx.insert(schema.payrollHistoryImportRevision).values(row)),'42501',/sealed worker step/);expect((await detail()).currentRevisionId).toBe(current.currentRevisionId);
});

it('uses the canonical direct catalogue owner when its optional alias field is explicitly empty',async()=>{
 await owner.db.insert(schema.payrollImportCode).values({tenantId:b.tenantId,code:'TRV',label:'Travel',destination:'allowance',direction:'earning',aliasFor:''});
 await accept([['BASIC','1000.00'],['TRV','500.00'],['PCB','50.00']],'replace');await accept([['TRV','200.00']],'update_listed');expect((await detail()).items.find(item=>item.code==='TRV')).toMatchObject({key:'component:'+trvId,amount:'200.00'});
});

it('preserves proven noncash financial ownership when an unlisted archived cash setting holds only the tax projection',async()=>{
 const [benefit]=await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BIK',name:'Fictional retained benefit',kind:'allowance',isNonPayable:true,displayCategory:'bik',eaFormLine:'EA_B3',includedInPcb:true,pcbRemunerationType:'normal'}).returning();
 const original=await accept([['BASIC','1000.00'],['TRV','500.00'],['BIK','300.00'],['PCB','50.00']],'replace'),before=await detail(),[saved]=await owner.db.select().from(schema.payrollHistoryImportSnapshot).where(eq(schema.payrollHistoryImportSnapshot.id,(await owner.db.select().from(schema.payrollHistoryImportRevision).where(eq(schema.payrollHistoryImportRevision.attemptId,original.attemptId)))[0].snapshotId!));
 await owner.db.update(schema.payComponent).set({archivedAt:new Date()}).where(eq(schema.payComponent.id,trvId));const review=await accept([['BASIC','1100.00']],'update_listed'),after=await detail();
 expect(after.values).toMatchObject({basicSalary:'1100.00',allowance:'500.00',grossPay:'1600.00',statutory:{pcb:50,importedTaxBasis:{state:'held'}}});expect(after.items.find(item=>item.key==='component:'+benefit.id)).toMatchObject({amount:'300.00',direction:'noncash',sourceAttemptId:original.attemptId});expect(after.values?.statutory.importedTaxBasis).toMatchObject({missing:[expect.stringMatching(/TRV.*archived|archived.*TRV/)]});expect(before.values?.statutory.pcb).toBe(50);
 const [revision]=await owner.db.select().from(schema.payrollHistoryImportRevision).where(eq(schema.payrollHistoryImportRevision.attemptId,review.attemptId));await expect(withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[revision.snapshotId!],{includeImported:true}))).rejects.toThrow(/Imported wage inputs require review/);expect((await owner.db.select().from(schema.payrollHistoryImportSnapshot).where(eq(schema.payrollHistoryImportSnapshot.id,saved.id)))[0]).toEqual(saved);
});
