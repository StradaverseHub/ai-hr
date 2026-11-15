import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {movementHistory} from '../core/movement';
import {addDaysIso} from '../lib/roster-month';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {
 PersonnelPostingError,approvePersonnelPosting,createPersonnelPostingTx,editPersonnelPosting,listPersonnelPostings,personnelPosting,
 type CreatePersonnelPostingInput,
} from '../packs/personnel-postings/service';

/** Migration 5741 and core/personnel-posting.ts: creation authority, correction, approver-only approval through the
 * movement writer, one movement under concurrent approval, rollback on a refused movement, and tenant isolation.
 * Every name and identifier is fictional. */
let b:Base,admin:SessionContext,runner:SessionContext;
const PAST=addDaysIso(todayInKualaLumpur(),-30),LATER=addDaysIso(todayInKualaLumpur(),-20),END=addDaysIso(todayInKualaLumpur(),60);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);
 runner={...admin,userId:undefined,roles:[],grants:undefined} as SessionContext;
 await groups([admin.userId!]);
});
async function groups(members:string[]){
 const data={version:9,groups:[{id:'g-postings',name:'Fictional People Ops',members,limit:10}]};
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify(data)}::jsonb)
  on conflict(tenant_id) do update set data=jsonb_set(lc_v9_config.data,'{groups}',${JSON.stringify(data.groups)}::jsonb)`);
}
async function person(name:string,role:'employee'|'hr_admin'){
 const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@postings.example.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,p.id,role);
 return{...admin,userId,personId:p.id,roles:[role],grants:undefined} as SessionContext;
}
/** A probation case of the employee with a released outcome (the only source a posting may come from). */
async function released(outcome:'confirm'|'extend'){
 const hire=await hireEmployee(admin,{person:{fullName:'Fictional Probationer',primaryEmail:randomUUID()+'@postings.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const ids={case:randomUUID(),settings:randomUUID(),form:randomUUID(),route:randomUUID(),part:randomUUID()};
 await owner.db.execute(sql`insert into probation_configuration(id,tenant_id,company_id,kind,version,state,data,created_by) values
  (${ids.settings}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'settings',1,'published','{}'::jsonb,${admin.userId}::uuid),
  (${ids.form}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'form',1,'published','{}'::jsonb,${admin.userId}::uuid),
  (${ids.route}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'route',1,'published','{}'::jsonb,${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into probation_case(id,tenant_id,company_id,employment_id,source_key,settings_id,form_id,route_id,data) values(${ids.case}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${hire.employmentId}::uuid,
  ${'employment:'+hire.employmentId},${ids.settings}::uuid,${ids.form}::uuid,${ids.route}::uuid,${JSON.stringify({id:ids.case,employmentId:hire.employmentId,companyId:b.companyId})}::jsonb)`);
 await owner.db.execute(sql`insert into probation_part(id,tenant_id,case_id,data) values(${ids.part}::uuid,${b.tenantId}::uuid,${ids.case}::uuid,${JSON.stringify({id:ids.part})}::jsonb)`);
 await owner.db.execute(sql`insert into probation_outcome(case_id,tenant_id,part_id,outcome,revision,state,released_at,source_key) values(${ids.case}::uuid,${b.tenantId}::uuid,${ids.part}::uuid,${outcome},1,'released',now(),${'outcome:'+ids.part})`);
 return{employmentId:hire.employmentId,caseId:ids.case};
}
const input=(source:{employmentId:string;caseId:string},over:Partial<CreatePersonnelPostingInput>={}):CreatePersonnelPostingInput=>({source:'probation',sourceRef:source.caseId,employmentId:source.employmentId,
 eventType:'confirmation',proposed:{effectiveDate:PAST},approverGroupId:'g-postings',idempotencyKey:'outcome-1',...over});
const create=(value:CreatePersonnelPostingInput)=>owner.withTenant(runner,tx=>createPersonnelPostingTx(tx,value));
const employment=async(id:string)=>(await owner.db.execute<{confirmation:string|null;extended:string|null}>(sql`select confirmation_date::text as confirmation,extended_confirmation_date::text as extended from employment where id=${id}::uuid`))[0];
const movements=async(id:string,kind:string)=>(await movementHistory(admin,id)).filter(row=>row.kind===kind);
const rejects=async(p:Promise<unknown>,code:PersonnelPostingError['code'])=>{await expect(p).rejects.toBeInstanceOf(PersonnelPostingError);await expect(p).rejects.toMatchObject({code});};

describe('Personnel postings: creation',()=>{
 it('lets only the Probation owner path create, for a released outcome of the matching kind, idempotently',async()=>{
  const source=await released('confirm');
  const first=await create(input(source));
  expect(first.number).toBe(1001);
  expect((await create(input(source))).id).toBe(first.id);
  await rejects(create(input(source,{proposed:{effectiveDate:LATER}})),'invalid');
  // No extend outcome on this case, an unknown group, a value outside the allowlist, a Personnel admin without the GBS role.
  await rejects(create(input(source,{eventType:'probationExtension',proposed:{effectiveDate:PAST,endDate:END},idempotencyKey:'outcome-2'})),'forbidden');
  await rejects(create(input(source,{approverGroupId:'g-missing',idempotencyKey:'outcome-3'})),'invalid');
  await expect(create(input(source,{proposed:{effectiveDate:PAST,basicSalary:9000} as never,idempotencyKey:'outcome-4'}))).rejects.toBeInstanceOf(PersonnelPostingError);
  await rejects(withTenant(admin,tx=>createPersonnelPostingTx(tx,input(source,{idempotencyKey:'outcome-5'}))),'forbidden');
  for(const statement of[
   sql`insert into personnel_posting(tenant_id,company_id,employment_id,number,source,source_ref,event_type,proposed,approver_group_id,idempotency_key) values(${b.tenantId}::uuid,${b.companyId}::uuid,${source.employmentId}::uuid,1,'probation',${source.caseId}::uuid,'confirmation','{"effectiveDate":"2026-01-01"}','g-postings','forged')`,
   sql`update personnel_posting set status='approved' where id=${first.id}::uuid`,
   sql`delete from personnel_posting where id=${first.id}::uuid`,
  ])await expect(withTenant(admin,tx=>tx.execute(statement))).rejects.toThrow();
  const page=await listPersonnelPostings(admin);
  expect(page.rows.map(r=>[r.label,r.displayStatus,r.eventType,r.current.effectiveDate,r.approverGroupName,r.canApprove,r.canEdit])).toEqual([['PP-1001','pending','confirmation',PAST,'Fictional People Ops',true,true]]);
  const[events]=await owner.db.execute<{types:string[]}>(sql`select array_agg(event_type order by sequence) as types from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_type='personnel_posting'`);
  expect(events.types).toEqual(['personnel_posting.created']);
 });
});

describe('Personnel postings: correction and approval',()=>{
 it('keeps a correction by someone outside the approver group pending, refuses their approval and writes no movement',async()=>{
  const source=await released('confirm'),posting=await create(input(source));
  const editor=await person('Fictional Alicia','hr_admin');
  await rejects(editPersonnelPosting(editor,{id:posting.id,revision:1,values:{effectiveDate:'2026-02-30'}}),'invalid');
  expect(await editPersonnelPosting(editor,{id:posting.id,revision:1,values:{effectiveDate:LATER,remarks:'Fictional late start'}})).toEqual({revision:2});
  await rejects(editPersonnelPosting(editor,{id:posting.id,revision:1,values:{effectiveDate:PAST}}),'conflict');
  await rejects(approvePersonnelPosting(editor,{id:posting.id,revision:2}),'forbidden');
  const seen=(await personnelPosting(admin,posting.id))!;
  expect(seen).toMatchObject({status:'pending',displayStatus:'edited',revision:2,proposed:{effectiveDate:PAST},edited:{effectiveDate:LATER,remarks:'Fictional late start'},editedBy:{id:editor.userId,name:'Fictional Alicia'},canApprove:true});
  expect((await personnelPosting(editor,posting.id))!.canApprove).toBe(false);
  expect(await employment(source.employmentId)).toEqual({confirmation:null,extended:null});
  expect(await movements(source.employmentId,'confirmation')).toEqual([]);
  // A plain employee outside the group and the employment's movement authority sees nothing.
  const outsider=await person('Fictional Outsider','employee');
  expect((await listPersonnelPostings(outsider)).rows).toEqual([]);
  await rejects(editPersonnelPosting(outsider,{id:posting.id,revision:2,values:{effectiveDate:PAST}}),'not_found');
 });
 it('applies the corrected values through the movement writer when an approver approves, once',async()=>{
  const source=await released('confirm'),posting=await create(input(source));
  const editor=await person('Fictional Alicia','hr_admin');
  await editPersonnelPosting(editor,{id:posting.id,revision:1,values:{effectiveDate:LATER}});
  await rejects(approvePersonnelPosting(admin,{id:posting.id,revision:1}),'conflict');
  const approved=await approvePersonnelPosting(admin,{id:posting.id,revision:2});
  expect(approved).toMatchObject({eventType:'confirmation',values:{effectiveDate:LATER}});
  expect((await employment(source.employmentId)).confirmation).toBe(LATER);
  const rows=await movements(source.employmentId,'confirmation');
  expect(rows.map(r=>[r.effectiveDate,r.status])).toEqual([[LATER,'applied']]);
  expect(rows[0].id).toBe(approved.movementId);
  expect(await personnelPosting(admin,posting.id)).toMatchObject({status:'approved',displayStatus:'approved',movementId:approved.movementId,applied:{effectiveDate:LATER},approvedBy:{id:admin.userId}});
  await rejects(approvePersonnelPosting(admin,{id:posting.id,revision:3}),'conflict');
  await rejects(editPersonnelPosting(admin,{id:posting.id,revision:3,values:{effectiveDate:PAST}}),'conflict');
  const[events]=await owner.db.execute<{types:string[]}>(sql`select array_agg(event_type order by sequence) as types from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_type='personnel_posting'`);
  expect(events.types).toEqual(['personnel_posting.created','personnel_posting.edited','personnel_posting.approved']);
 });
 it('lets an approver save the event with their own corrections (Save event and approve) for an extension',async()=>{
  const source=await released('extend'),posting=await create(input(source,{eventType:'probationExtension',proposed:{effectiveDate:PAST,endDate:END}}));
  const corrected=addDaysIso(END,1);
  await rejects(approvePersonnelPosting(admin,{id:posting.id,revision:1,values:{effectiveDate:PAST}}),'invalid');
  await approvePersonnelPosting(admin,{id:posting.id,revision:1,values:{effectiveDate:PAST,endDate:corrected,remarks:'Fictional extension'}});
  expect((await employment(source.employmentId)).extended).toBe(corrected);
  expect((await movements(source.employmentId,'probationExtension')).map(r=>r.endDate)).toEqual([corrected]);
  expect((await personnelPosting(admin,posting.id))!.applied).toEqual({effectiveDate:PAST,endDate:corrected,remarks:'Fictional extension'});
 });
 it('writes one movement when two approvals race',async()=>{
  const source=await released('confirm'),posting=await create(input(source));
  const results=await Promise.allSettled([approvePersonnelPosting(admin,{id:posting.id,revision:1}),approvePersonnelPosting(admin,{id:posting.id,revision:1})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(await movements(source.employmentId,'confirmation')).toHaveLength(1);
  expect((await personnelPosting(admin,posting.id))!.status).toBe('approved');
 });
 it('leaves the posting pending when the movement writer refuses the approver',async()=>{
  const source=await released('confirm'),posting=await create(input(source));
  const member=await person('Fictional Group Member','employee');await groups([admin.userId!,member.userId!]);
  expect((await personnelPosting(member,posting.id))!.canApprove).toBe(true);
  await expect(approvePersonnelPosting(member,{id:posting.id,revision:1})).rejects.toThrow();
  expect(await personnelPosting(admin,posting.id)).toMatchObject({status:'pending',revision:1,movementId:null,approvedBy:null});
  expect(await employment(source.employmentId)).toEqual({confirmation:null,extended:null});
  const[approvals]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from domain_event where tenant_id=${b.tenantId}::uuid and event_type='personnel_posting.approved'`);
  expect(approvals.n).toBe(0);
  // The approval cannot be committed without the movement it applied.
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.personnel_posting_approve(${posting.id}::uuid,1,null)`))).rejects.toThrow();
  expect((await personnelPosting(admin,posting.id))!.status).toBe('pending');
  await approvePersonnelPosting(admin,{id:posting.id,revision:1});
  expect((await employment(source.employmentId)).confirmation).toBe(PAST);
 });
});

describe('Personnel postings: tenant isolation',()=>{
 it('never shows or approves another tenant’s posting',async()=>{
  const source=await released('confirm'),posting=await create(input(source));
  const home=b;b=await seedBase();await setModule(b.tenantId,'lifecycle','active');const other=adminCtx(b);await groups([other.userId!]);
  expect((await listPersonnelPostings(other)).rows).toEqual([]);
  expect(await personnelPosting(other,posting.id)).toBeNull();
  await rejects(approvePersonnelPosting(other,{id:posting.id,revision:1}),'forbidden');
  await rejects(editPersonnelPosting(other,{id:posting.id,revision:1,values:{effectiveDate:PAST}}),'not_found');
  b=home;
  expect((await personnelPosting(admin,posting.id))!.status).toBe('pending');
 });
});
