/** Characterize the published reader using real APP queries. No owner/native implementation change. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {client,withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createClaimType,pendingClaimTaskMetadata} from '../packs/claims/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();});
const subjectLookupHash='a32da93df33eb9e95b2e0606dd740b5a96c9a54552407f682315300586986ee1';

async function countedRead(read:()=>ReturnType<typeof pendingClaimTaskMetadata>){
 const previous=client.options.debug;
 let statements=0,scalarSubjectLookups=0;
 // postgres's real query-dispatch callback observes the runtime pool. No SQL/params are changed or stored.
 client.options.debug=(connection,query,parameters,types)=>{
  statements++;
  if(createHash('sha256').update(query).digest('hex')===subjectLookupHash)scalarSubjectLookups++;
  if(typeof previous==='function')previous(connection,query,parameters,types);
 };
 try{return {rows:await read(),counts:()=>({statements,scalarSubjectLookups})};}
 finally{client.options.debug=previous;}
}

it('keeps exact ordered headers while statement work stays bounded as one subject gains pending claims',async()=>{
 await setModule(b.tenantId,'claims','active');const ctx=adminCtx(b);
 const person=await hireEmployee(ctx,{person:{fullName:'Fictional repeated Claims subject',primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const type=await createClaimType(ctx,{code:'QUERY_BUDGET',name:'Fictional query-count fixture',requiresReceipt:false,defaultTaxable:false});
 const insert=async(start:number,count:number)=>owner.db.insert(s.claimRequest).values(Array.from({length:count},(_,i)=>({
  tenantId:b.tenantId,employmentId:person.employmentId,claimTypeId:type.id,amount:'1.00',status:'pending' as const,
  incurredOn:todayInKualaLumpur(),createdAt:new Date(Date.UTC(2026,0,15,8,0,start+i)),
 }))).returning({id:s.claimRequest.id,createdAt:s.claimRequest.createdAt});
 const initial=await insert(0,1);
 const [role]=await withTenant(ctx,tx=>tx.execute(sql`select current_user as role`)) as unknown as {role:string}[];
 expect(role.role).toBe('ai_hr_app');
 const small=await countedRead(()=>pendingClaimTaskMetadata(ctx,[b.companyId]));
 expect(small.rows.map(row=>row.id)).toEqual(initial.map(row=>row.id));
 expect(small.counts().statements).toBeGreaterThan(0);

 const added=await insert(1,39);
 const expected=[...initial,...added].sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime()||a.id.localeCompare(b.id)).map(row=>row.id);
 const expanded=await countedRead(()=>pendingClaimTaskMetadata(ctx,[b.companyId]));
 // These assertions precede the budget: empty/truncated/incorrectly scoped responses cannot satisfy it.
 expect(expanded.rows.map(row=>row.id)).toEqual(expected);
 expect(expanded.rows).toHaveLength(40);
 expect(await pendingClaimTaskMetadata(ctx,[])).toEqual([]);
 console.log('CLAIM_TASK_QUERY_BUDGET '+JSON.stringify({fixtureSubjects:1,smallClaims:1,expandedClaims:40,
  actorRole:role.role,orderedRowsExact:true,small:small.counts(),expanded:expanded.counts()}));
 expect(expanded.counts().statements).toBeLessThanOrEqual(small.counts().statements+2);
 expect(expanded.counts().scalarSubjectLookups).toBeLessThanOrEqual(1);
});
