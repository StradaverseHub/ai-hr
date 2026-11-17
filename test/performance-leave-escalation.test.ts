/** AP020: escalation settings use the native company population once per concern. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {getLeaveEscalationPolicy,getLeaveEscalationPolicies,setLeaveEscalationPolicy} from '../core/leave-approval-policy';
import {loadLeaveTypeApprovalReadout} from '../app/admin/leave-config/approval-readout';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
const defaults={enabled:false,escalateAfterDays:null,target:'next_level',targetRole:null};
it('preserves configured/default/invisible policies, every role and company order at70-company scale',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const rest=await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional escalation company '+i}))).returning({id:s.company.id});
 const companies=[b.companyId,...rest.map(row=>row.id)];
 const people=await owner.db.insert(s.person).values(Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,fullName:'Fictional escalation person '+i,primaryEmail:randomUUID()+'@fixture.invalid'}))).returning({id:s.person.id});
 await owner.db.insert(s.employment).values(people.map((p,i)=>({tenantId:b.tenantId,personId:p.id,companyId:companies[i%70],employeeCode:'EP-'+i,hiredOn:'2020-01-01'})));
 for(const [i,companyId] of companies.entries())if(i%3!==0)await setLeaveEscalationPolicy(ctx,{companyId,enabled:i%2===0,escalateAfterDays:i%2===0?i+1:null,target:i%2===0?'specific_role':'next_level',targetRole:i%2===0?'direct_manager':null});
 const legacy=async(who:SessionContext,ids:readonly string[])=>new Map(await Promise.all(ids.map(async id=>[id,await getLeaveEscalationPolicy(who,id)] as const)));
 const spy=vi.spyOn(database,'withTenant'),expected=await legacy(ctx,companies);
 expect(spy).toHaveBeenCalledTimes(70);spy.mockRestore();
 expect(expected.get(b.companyId)).toEqual(defaults);expect(expected.get(companies[2])).toEqual({enabled:true,escalateAfterDays:3,target:'specific_role',targetRole:'direct_manager'});
 const native=database.withTenant,carriers:{readOnly:string;mode:string}[]=[];
 const batched=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(who,async tx=>{
  const result=await read(tx);const [mode]=await tx.execute<{readOnly:string;mode:string}>(sql`select current_setting('transaction_read_only') as "readOnly",app.access_lock_mode_held(${who.tenantId}::uuid) as mode`);carriers.push(mode);return result;
 },options));
 try{expect(await getLeaveEscalationPolicies(ctx,companies)).toEqual(expected);expect(batched).toHaveBeenCalledTimes(1);expect(carriers).toEqual([{readOnly:'on',mode:'S'}]);}finally{batched.mockRestore();}
 for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
  const userId=await createAppUser(b.tenantId,people[0].id,'employee');await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const who={...ctx,userId,personId:people[0].id,roles:[role],grants:[{role,companyId}]};
  for(const ids of [companies,[b.companyId],[companies[1]]])expect(await getLeaveEscalationPolicies(who,ids)).toEqual(await legacy(who,ids));
 }
 expect(await getLeaveEscalationPolicies(ctx,[])).toEqual(new Map());
 const reordered=[companies[2],b.companyId,companies[2],randomUUID(),companies[2].toUpperCase(),'{'+companies[2]+'}',companies[2].replaceAll('-','')];
 expect(await getLeaveEscalationPolicies(ctx,reordered)).toEqual(await legacy(ctx,reordered));
 expect([...await getLeaveEscalationPolicies(ctx,reordered)].map(([id])=>id)).toEqual([...new Set(reordered)]);
 const other=await seedBase();expect(await getLeaveEscalationPolicies(adminCtx(other),companies)).toEqual(new Map(companies.map(id=>[id,defaults])));
 const readout=await loadLeaveTypeApprovalReadout(ctx,companies.map(id=>({id,name:'Fictional choice'})));
 expect(readout.escalationByCompany).toEqual(expected);
 // Native70-company oracles and actual role assignments need headroom over the default30s.
},180000);
