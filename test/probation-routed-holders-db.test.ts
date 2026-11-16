// Lane K2 (migration 5764): the shared routings are the one owner of a case's PBP and Head of Department. Converted
// V9 bpRules resolve to the same person, a routing edit re-resolves unsigned holders as today, no matching row goes to
// the fallback group, and a group row makes each member a holder. Fictional people and companies only.
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {createCompany} from '../core/admin';
import {hireEmployee} from '../core/org';
import {resolveRoutingRow,routingFromV9BpRules,type RoutingRow} from '../lib/automation/routing';
import {probationFormCaseFixture} from './helpers/probation-form-case-fixture';

const BP='a0700000-0000-4000-8000-000000001001',HOD='a0700000-0000-4000-8000-000000001002';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);});

type Holder={employment_id:string;pbp:string|null;pbp_users:string[];pbp_group:string|null;pbp_source:string;hod:string|null;hod_users:string[];hod_group:string|null;hod_source:string};
const holders=async(employments:string[])=>{
 const rows=await owner.withTenant(admin,tx=>tx.execute<Holder>(sql`select employment_id,pbp,pbp_users::text[] as pbp_users,pbp_group,pbp_source,hod,hod_users::text[] as hod_users,hod_group,hod_source from app.probation_routed_holders(array[${sql.join(employments.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`));
 const set=await owner.withTenant(admin,tx=>tx.execute<{employment_id:string;pbp:string|null;hod:string|null}>(sql`select employment_id,pbp,hod from app.probation_holders_set(array[${sql.join(employments.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`));
 // The existing holder set answers from the same resolver.
 expect(set.map(r=>({id:r.employment_id,pbp:r.pbp,hod:r.hod})).sort((x,y)=>x.id.localeCompare(y.id))).toEqual(rows.map(r=>({id:r.employment_id,pbp:r.pbp,hod:r.hod})).sort((x,y)=>x.id.localeCompare(y.id)));
 return new Map(rows.map(r=>[r.employment_id,r]));
};
const saveRouting=(id:string,name:string,rows:RoutingRow[],expected:number)=>withTenant(admin,tx=>tx.execute(sql`select app.automation_routing_save(${id}::uuid,${name},${JSON.stringify(rows)}::jsonb,false,${expected},'Fictional routing change')`));
const probationRole=(ctx:SessionContext,employmentId:string,name:string)=>withTenant(ctx,async tx=>(await tx.execute<{ok:boolean}>(sql`select app.probation_role(${employmentId}::uuid,${name}) as ok`))[0].ok);
async function login(name:string){
 const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@routing.example.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 return{userId,ctx:{...admin,userId,personId:p.id,roles:['employee'],grants:undefined} as SessionContext};
}
async function employee(name:string,companyId:string,departmentId:string){
 return hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@routing.example.test'},companyId,departmentId,employmentType:'full_time',hiredOn:'2026-01-01'});
}

describe('the BP routing replaces the bpRules resolver',()=>{
 it('resolves converted bpRules to the same person, re-resolves after an edit and falls back to the fallback group',async()=>{
  const other=await createCompany(admin,{legalName:'Fictional Routing Elsewhere Sdn Bhd',country:'MY',currency:'MYR'});
  const[otherDept]=await owner.db.execute<{id:string}>(sql`insert into department(tenant_id,company_id,name) values(${b.tenantId}::uuid,${other.id}::uuid,'Fictional Elsewhere Ops') returning id`);
  const[unit]=await owner.db.execute<{id:string}>(sql`insert into business_unit(tenant_id,company_id,code,name) values(${b.tenantId}::uuid,${b.companyId}::uuid,'FBU','Fictional Business Unit') returning id`);
  const e1=await employee('Fictional Routed One',b.companyId,b.deptA),e2=await employee('Fictional Routed Two',b.companyId,b.deptB);
  const e3=await employee('Fictional Routed Three',b.companyId,b.deptA),e4=await employee('Fictional Routed Four',other.id,otherDept.id);
  await owner.db.execute(sql`update assignment set business_unit_id=${unit.id}::uuid where employment_id=${e3.employmentId}::uuid and superseded_at is null`);
  const p1=await login('Fictional Partner One'),p2=await login('Fictional Partner Two'),p3=await login('Fictional Partner Three'),p4=await login('Fictional Partner Four'),ops=await login('Fictional People Ops');
  const bpRules=[
   {rules:{company:[b.companyId]},userId:p1.userId},
   {rules:{company:[b.companyId],department:[b.deptB]},userId:p2.userId},
   {rules:{businessGroup:[unit.id]},userId:p3.userId},
  ];
  await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',groups:[{id:'probation-people',name:'Fictional People Ops',members:[ops.userId],limit:10}],bpRules})}::jsonb)`);
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) select ${b.tenantId}::uuid,u,c,'pbp','2026-01-01','Fictional PBP opt-in' from unnest(array[${p1.userId}::uuid,${p2.userId}::uuid,${p3.userId}::uuid]) u cross join unnest(array[${b.companyId}::uuid,${other.id}::uuid]) c`);
  const ids=[e1,e2,e3,e4].map(e=>e.employmentId);
  const before=await holders(ids);
  const expected={[e1.employmentId]:p1.userId,[e2.employmentId]:p2.userId,[e3.employmentId]:p3.userId,[e4.employmentId]:null};
  for(const id of ids)expect(before.get(id)!.pbp,id).toBe(expected[id]);
  expect([...before.values()].every(r=>r.pbp_source==='bpRules'&&r.hod_source==='department')).toBe(true);
  // The same list as the shared routing (lib/automation/routing.ts routingFromV9BpRules): the same person for everyone.
  const routing=routingFromV9BpRules(bpRules,BP);
  await saveRouting(BP,routing.name,routing.rows,0);
  const after=await holders(ids);
  for(const id of ids)expect(after.get(id)!.pbp,id).toBe(expected[id]);
  for(const id of [e1,e2,e3].map(e=>e.employmentId))expect(after.get(id)).toMatchObject({pbp_source:'routing',pbp_group:null,pbp_users:[expected[id]]});
  // The TypeScript evaluator picks the same row for the same facts.
  for(const [e,facts] of [[e1,{businessGroup:[b.companyId],company:b.companyId,department:b.deptA}],[e2,{businessGroup:[b.companyId],company:b.companyId,department:b.deptB}],[e3,{businessGroup:[unit.id,b.companyId],company:b.companyId,department:b.deptA}]] as const){
   const match=resolveRoutingRow(routing,facts);
   expect(match?.row.assignTo.kind==='people'?match.row.assignTo.userIds[0]:null).toBe(expected[e.employmentId]);
  }
  // No row matches the other company's employee: the fallback group (People Ops) holds it, and the case says so.
  expect(after.get(e4.employmentId)).toMatchObject({pbp:null,pbp_group:'probation-people',pbp_users:[ops.userId],pbp_source:'fallback'});
  expect(await probationRole(ops.ctx,e4.employmentId,'pbp')).toBe(true);
  // An edit re-resolves holders as a bpRules or department change does today (signed steps keep their signer).
  await saveRouting(BP,routing.name,[{match:{company:[b.companyId]},assignTo:{kind:'people',userIds:[p4.userId]}},...routing.rows.slice(1)],1);
  const edited=await holders(ids);
  expect(edited.get(e1.employmentId)!.pbp).toBe(p4.userId);expect(edited.get(e2.employmentId)!.pbp).toBe(p2.userId);
  expect(await probationRole(p4.ctx,e1.employmentId,'pbp')).toBe(true);expect(await probationRole(p1.ctx,e1.employmentId,'pbp')).toBe(false);
  // A retired routing hands back to its adapter (today's bpRules).
  await withTenant(admin,tx=>tx.execute(sql`select app.automation_routing_save(${BP}::uuid,${routing.name},${JSON.stringify(routing.rows)}::jsonb,true,2,'Retire')`));
  expect((await holders(ids)).get(e1.employmentId)).toMatchObject({pbp:p1.userId,pbp_source:'bpRules'});
 });

 it('keeps today\'s bpRules rule until the routing has rows: an installed empty routing changes nothing',async()=>{
  const e1=await employee('Fictional Unrouted',b.companyId,b.deptA),p1=await login('Fictional Partner');
  await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',groups:[],bpRules:[{rules:{company:[b.companyId]},userId:p1.userId}]})}::jsonb)`);
  // Without the PBP opt-in the adapter answers nobody, exactly as before.
  expect((await holders([e1.employmentId])).get(e1.employmentId)!.pbp).toBeNull();
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${p1.userId}::uuid,${b.companyId}::uuid,'pbp','2026-01-01','Fictional PBP opt-in')`);
  await saveRouting(BP,'BP by business group',[],0);await saveRouting(HOD,'HOD by business group and department',[],0);
  expect((await holders([e1.employmentId])).get(e1.employmentId)).toMatchObject({pbp:p1.userId,pbp_source:'bpRules',hod_source:'department'});
 });
});

describe('the HOD routing',()=>{
 it('makes every member of a routed group the case\'s Head of Department, with sight of the case',async()=>{
  const fixture=probationFormCaseFixture(b,admin),{ids,staff,peer}=await fixture.caseWithRows([]);admin=fixture.admin();
  const member=await fixture.person('Fictional HOD group member');
  const access=(ctx:SessionContext)=>withTenant(ctx,async tx=>(await tx.execute<{ok:boolean}>(sql`select app.probation_case_access(${ids.caseId}::uuid) as ok`))[0].ok);
  // Today: the department head (the fixture's peer) is the Head of Department.
  expect((await holders([staff.employmentId])).get(staff.employmentId)).toMatchObject({hod:peer.userId,hod_source:'department'});
  expect(await access(member.ctx)).toBe(false);
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',(data->'groups')||${JSON.stringify([{id:'hod-group',name:'Fictional HOD group',members:[member.userId],limit:10}])}::jsonb) where tenant_id=${b.tenantId}::uuid`);
  await saveRouting(HOD,'HOD by business group and department',[{match:{department:[b.deptA]},assignTo:{kind:'group',groupId:'hod-group'}}],0);
  expect((await holders([staff.employmentId])).get(staff.employmentId)).toMatchObject({hod:null,hod_group:'hod-group',hod_users:[member.userId],hod_source:'routing'});
  expect(await probationRole(member.ctx,staff.employmentId,'hod')).toBe(true);
  expect(await access(member.ctx)).toBe(true);
  // The routing, not the department record, now owns the Head of Department.
  expect(await probationRole(peer.ctx,staff.employmentId,'hod')).toBe(false);
  // A row naming one person makes that person the holder of the case's Part 3 Head of Department step.
  await saveRouting(HOD,'HOD by business group and department',[{match:{},assignTo:{kind:'people',userIds:[peer.userId]}}],1);
  expect((await holders([staff.employmentId])).get(staff.employmentId)).toMatchObject({hod:peer.userId,hod_group:null,hod_source:'routing'});
 });
});
