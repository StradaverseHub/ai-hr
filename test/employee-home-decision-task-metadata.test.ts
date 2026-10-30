import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {pendingLeaveTaskMetadata,pendingLeaveCancellationTaskMetadata} from '../packs/leave/service';
import {createClaimType,pendingClaimTaskMetadata,pendingClaimTaskSummary,listPendingClaimsPage} from '../packs/claims/service';
import {pendingProfileTaskMetadata,decideProfileChange} from '../core/profile';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function subject(){return hireEmployee(adminCtx(b),{person:{fullName:'Fictional task metadata subject',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});}
async function onlyColumns(table:string,columns:string[],read:()=>Promise<void>){
 if(!['leave_request','claim_request','profile_change_request'].includes(table)||columns.some(c=>!/^[a-z_]+$/.test(c)))throw Error('Fixed fixture identifiers only.');
 await owner.db.execute(sql.raw('REVOKE SELECT ON public.'+table+' FROM ai_hr_app'));
 await owner.db.execute(sql.raw('GRANT SELECT('+columns.join(',')+') ON public.'+table+' TO ai_hr_app'));
 try{await read();}finally{
  await owner.db.execute(sql.raw('GRANT SELECT ON public.'+table+' TO ai_hr_app'));
  await owner.db.execute(sql.raw('REVOKE SELECT('+columns.join(',')+') ON public.'+table+' FROM ai_hr_app'));
 }
}
async function expectDenied(read:Promise<unknown>){
 try{await read;throw Error('Private column unexpectedly readable');}catch(error){
  let cause=error as {code?:string;cause?:unknown};while(cause&&!cause.code)cause=cause.cause as typeof cause;
  expect(cause?.code).toBe('42501');
 }
}
const baseColumns=['id','tenant_id','employment_id','status','created_at'];
const privateFields=['reason','proposed','amount','description','employeeRemark','attachments','days','decisionReason'];
function expectHeaders(rows:unknown[]){for(const row of rows)for(const field of privateFields)expect(row).not.toHaveProperty(field);}

describe('Home assigned-decision metadata is an uncapped projection at its source owner',()=>{
 it('reads every pending leave header while reasons, units and application dates are unavailable to the runtime role',async()=>{
  const e=await subject(),today=todayInKualaLumpur();
  const heads=await owner.db.insert(s.leaveRequest).values(Array.from({length:211},()=>({tenantId:b.tenantId,employmentId:e.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:today,endDate:today,days:'1',reason:'Fictional private leave reason'}))).returning({id:s.leaveRequest.id});
  await onlyColumns('leave_request',baseColumns,async()=>{
   await expectDenied(withTenant(adminCtx(b),tx=>tx.select({reason:s.leaveRequest.reason}).from(s.leaveRequest)));
   const rows=await pendingLeaveTaskMetadata(adminCtx(b));expect(rows).toHaveLength(211);
   expect(new Set(rows.map(r=>r.id))).toEqual(new Set(heads.map(r=>r.id)));expectHeaders(rows);
   expect((await pendingLeaveTaskMetadata(adminCtx(b))).map(r=>r.id)).toEqual(rows.map(r=>r.id));
   expect(await pendingLeaveTaskMetadata(adminCtx(b),[])).toEqual([]);
   expect(await pendingLeaveCancellationTaskMetadata(adminCtx(b),[])).toEqual([]);
  });
 });
 it('reads every claim header without amount, receipt, custom field or description access',async()=>{
  await setModule(b.tenantId,'claims','active');const e=await subject(),ctx=adminCtx(b);
  const type=await createClaimType(ctx,{code:'HOME_META',name:'Fictional metadata claims',requiresReceipt:false,defaultTaxable:false});
  const heads=await owner.db.insert(s.claimRequest).values(Array.from({length:1201},()=>({tenantId:b.tenantId,employmentId:e.employmentId,claimTypeId:type.id,amount:'8923.45',incurredOn:todayInKualaLumpur(),description:'Fictional private claim description'}))).returning({id:s.claimRequest.id});
  await onlyColumns('claim_request',baseColumns,async()=>{
   await expectDenied(withTenant(ctx,tx=>tx.select({amount:s.claimRequest.amount}).from(s.claimRequest)));
   const rows=await pendingClaimTaskMetadata(ctx);expect(rows).toHaveLength(1201);
   expect(new Set(rows.map(r=>r.id))).toEqual(new Set(heads.map(r=>r.id)));expectHeaders(rows);
   const preview=await pendingClaimTaskSummary(ctx,undefined,25);
   expect(preview.total).toBe(1201);expect(preview.items).toEqual(rows.slice(0,25));expectHeaders(preview.items);
   expect(await pendingClaimTaskSummary(ctx,[],25)).toEqual({items:[],total:0});

   expect(JSON.stringify(rows)).not.toContain('8923.45');expect(await pendingClaimTaskMetadata(ctx,[])).toEqual([]);
  });
  const first=await listPendingClaimsPage(ctx),second=await listPendingClaimsPage(ctx,{page:'1'});
  expect(first.page.total).toBe(1201);expect(first.rows).toHaveLength(25);expect(second.rows).toHaveLength(25);
  expect(new Set([...first.rows,...second.rows].map(row=>row.id)).size).toBe(50);
  expect((await listPendingClaimsPage(ctx,{companyIds:[]})).rows).toEqual([]);

 });
 it('reads every stored profile task without proposed values or before/after review projection, then removes a real decision',async()=>{
  const e=await subject(),ctx=adminCtx(b);
  const heads=await owner.db.insert(s.profileChangeRequest).values(Array.from({length:211},()=>({tenantId:b.tenantId,employmentId:e.employmentId,personId:e.personId,proposed:{preferredName:'Fictional private stored proposal'}}))).returning({id:s.profileChangeRequest.id});
  await onlyColumns('profile_change_request',[...baseColumns,'person_id','route_id','route_revision','route_approver_user_id','route_approver_employment_id','route_context'],async()=>{
   await expectDenied(withTenant(ctx,tx=>tx.select({proposed:s.profileChangeRequest.proposed}).from(s.profileChangeRequest)));
   const rows=await pendingProfileTaskMetadata(ctx);expect(rows).toHaveLength(211);
   expect(new Set(rows.map(r=>r.id))).toEqual(new Set(heads.map(r=>r.id)));expectHeaders(rows);
   expect(JSON.stringify(rows)).not.toContain('private stored proposal');expect(await pendingProfileTaskMetadata(ctx,[])).toEqual([]);
  });
  await decideProfileChange(ctx,{requestId:heads[0].id,decision:'rejected',reason:'Fictional metadata task completion'});
  const remaining=await pendingProfileTaskMetadata(ctx);expect(remaining).toHaveLength(210);expect(remaining.some(r=>r.id===heads[0].id)).toBe(false);
 });
});
