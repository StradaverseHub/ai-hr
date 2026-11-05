/** Empty-queue cost through real app RLS and native routing/decision owners. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {profileChangeRequest,employment,person} from '../db/schema';
import {pendingProfileTaskMetadata,actionableProfileChangeIds} from '../core/profile';
import {profileRouteReaderPredicate} from '../core/profile-routing';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import type {AssignedApprovalMetadata} from '../lib/assigned-work';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
// Frozen7edd implementation; all principal, RLS, routing and current-policy checks remain real.
async function legacyPendingProfileTaskMetadata(ctx:SessionContext,companyIds?:string[]):Promise<AssignedApprovalMetadata[]>{
 const candidates=await withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  // The native reader predicate and RLS already evaluate current routing/access facts.
  // This first transaction only finds candidates: resolving edit settings here took
  // the exclusive profile-write barrier on every shell read, even for an empty queue.
  // Nonempty candidates still pass the locked current-policy decision check below.
  return tx.select({id:profileChangeRequest.id,employmentId:profileChangeRequest.employmentId,personId:profileChangeRequest.personId,
   employee:person.fullName,createdAt:profileChangeRequest.createdAt}).from(profileChangeRequest)
   .innerJoin(employment,and(eq(employment.id,profileChangeRequest.employmentId),eq(employment.tenantId,profileChangeRequest.tenantId)))
   .leftJoin(person,and(eq(person.id,profileChangeRequest.personId),eq(person.tenantId,profileChangeRequest.tenantId)))
   .where(and(eq(profileChangeRequest.tenantId,ctx.tenantId),eq(profileChangeRequest.status,'pending'),profileRouteReaderPredicate(ctx),
    sql`NOT app.is_self_person(${profileChangeRequest.personId})`,companyIds===undefined?undefined:inArray(employment.companyId,companyIds)))
   .orderBy(desc(profileChangeRequest.createdAt),profileChangeRequest.id);
 });
 // The first transaction has already checked the current principal and native reader. With no
 // candidates there is no decision authority to resolve in a second locked transaction.
 if(candidates.length===0)return [];
 const allowed=new Set(await actionableProfileChangeIds(ctx,candidates.map(row=>row.id)));
 return candidates.filter(row=>allowed.has(row.id));
}

beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps empty profile task scope while avoiding unnecessary workforce projection work',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),count=500;
 const personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
 await owner.client.begin(async tx=>{
  await tx`insert into person(id,tenant_id,full_name,primary_email)select(${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional profile metadata '||n,(${personPrefix}||n::text)||'@example.invalid'from generate_series(1,${count}::integer)n`;
  await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)select(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'PMETA'||n::text,'2020-01-01'::date from generate_series(1,${count}::integer)n`;
 });
 for(const table of ['person','employment','profile_change_request'])await owner.client.unsafe('analyze '+table);
 const [records]=await owner.client`select count(*)::int as employees from employment where tenant_id=${b.tenantId}::uuid`;expect(records.employees).toBe(count);
 expect(await legacyPendingProfileTaskMetadata(ctx,[b.companyId])).toEqual([]);
 const measurements:{phase:string;reads:number;elapsedMs:number}[]=[];
 for(const phase of ['original','candidate','candidate-warm','restored']as const){
  const read=phase==='original'||phase==='restored'?legacyPendingProfileTaskMetadata:pendingProfileTaskMetadata,began=performance.now();
  for(let index=0;index<50;index++)expect(await read(ctx,[b.companyId])).toEqual([]);
  measurements.push({phase,reads:50,elapsedMs:performance.now()-began});
 }
 const foreign=await seedBase();expect(await pendingProfileTaskMetadata(adminCtx(foreign),[b.companyId])).toEqual([]);
 await expect(pendingProfileTaskMetadata({...ctx,userId:randomUUID()},[b.companyId])).rejects.toThrow();
 const control=Math.min(measurements[0].elapsedMs,measurements[3].elapsedMs),candidate=Math.max(measurements[1].elapsedMs,measurements[2].elapsedMs);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'profile-empty-task-work.json'),JSON.stringify({kind:'NATIVE_EMPTY_PROFILE_QUEUE_COMPONENT_ONLY',releaseEligible:false,fixtureEmployees:count,nativeTriggers:'unchanged',measurements,foreignEmptyAndForgedRefusal:true,improvementRatio:candidate/control,limitations:'emptyqueuecomponentonly; populated211-task/routing/private-fieldchecksand500HTTP/browserstillrequired'},null,2));
 expect(candidate,'Both empty-queue phases must improve at least20% over the faster native control').toBeLessThan(control*.8);
},600000);
