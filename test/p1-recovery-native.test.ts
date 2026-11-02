/** Native query faults and late writes, not mocked owner success or prevalidation refusal. */
import {afterAll,beforeEach,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {hireEmployee} from '../core/org';
import {createClaimType,saveClaimDraft,submitDraftClaims} from '../packs/claims/service';
import {assignRosterRow,createShift} from '../core/roster';
import {todayInKualaLumpur} from '../lib/hr-date';
import {publicErrorMessage} from '../lib/public-error';
import {isDatabaseError} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,owner,resetDb,seedBase} from './harness';
import type {SessionContext} from '../db/client';
let session:SessionContext;
vi.mock('@/lib/session',()=>({getSession:async()=>session}));
vi.mock('next/cache',()=>({revalidatePath:()=>{}}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT '+url);}}));
beforeEach(resetDb);afterAll(closeAll);

it('a real pricing database failure remains classified and sanitized through the native draft submit and web redirect',async()=>{
 const base=await seedBase(),admin=adminCtx(base);
 const employee=await hireEmployee(admin,{companyId:base.companyId,departmentId:base.deptA,hiredOn:'2020-01-01',employmentType:'full_time',person:{fullName:'Private pricing sentinel',primaryEmail:'pricing@test.invalid'}});
 session={...admin,userId:await createAppUser(base.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee'],grants:undefined};
 const type=await createClaimType(admin,{code:'PRICING',name:'Pricing fixture',requiresReceipt:false,defaultTaxable:false,maxReceiptAgeDays:36500});
 const draft=await saveClaimDraft(session,{employmentId:employee.employmentId,claimTypeId:type.id,amount:17,incurredOn:todayInKualaLumpur()});
 const before=await owner.client`select row_to_json(c) as row from claim_request c where id=${draft.id}::uuid`;
 const events=await owner.client`select count(*)::int as n from domain_event where tenant_id=${base.tenantId}::uuid`;
 // Only this worker's database is changed; restoring the table name is unconditional. Initial draft lookup does not use this relation.
 await owner.client`alter table claim_policy rename to p1_hidden_claim_policy`;
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try {
  let error:unknown;try{await submitDraftClaims(session,{ids:[draft.id]});}catch(e){error=e;}
  expect(error).toBeInstanceOf(Error);expect(isDatabaseError(error)).toBe(true);
  const safe=publicErrorMessage(error);expect(safe).toContain('reference');expect(safe).not.toMatch(/Failed query:|claim_policy|params:|select /i);
  const {submitDraftsAction}=await import('../app/claims/actions');const form=new FormData();form.append('draftIds',draft.id);
  let location='';try{await submitDraftsAction(form);}catch(e){location=(e as Error).message;}
  expect(location).toMatch(/^REDIRECT \/claims\?/);const message=new URL(location.slice(9),'https://fixture.invalid').searchParams.get('error');
  expect(message).toContain('reference');expect(message).not.toMatch(/Failed query:|claim_policy|params:|select /i);
 } finally {log.mockRestore();await owner.client`alter table p1_hidden_claim_policy rename to claim_policy`;}
 expect(await owner.client`select row_to_json(c) as row from claim_request c where id=${draft.id}::uuid`).toEqual(before);
 expect(await owner.client`select count(*)::int as n from domain_event where tenant_id=${base.tenantId}::uuid`).toEqual(events);
 expect(await submitDraftClaims(session,{ids:[draft.id]})).toEqual({submitted:1});
});

it.each(['shift','rest','clear'] as const)('one row Save rolls back earlier %s writes and events when a later native mutation fails',async brush=>{
 const base=await seedBase(),ctx=adminCtx(base),person=await hireEmployee(ctx,{companyId:base.companyId,departmentId:base.deptA,hiredOn:'2020-01-01',employmentType:'full_time',person:{fullName:'Roster rollback fixture',primaryEmail:'roster@test.invalid'}});
 const shift=await createShift(ctx,{companyId:base.companyId,name:'Fixture shift',code:'P1_SHIFT',startTime:'08:00:00',endTime:'17:00:00'});
 const dates=['2026-07-06','2026-07-07'];
 if(brush==='clear')await assignRosterRow(ctx,{employmentId:person.employmentId,shiftDates:dates,brush:shift.id});
 const snapshot=async()=>({rows:await owner.client`select row_to_json(r) as row from roster_assignment r where employment_id=${person.employmentId}::uuid order by shift_date`,events:await owner.client`select row_to_json(e) as row from domain_event e where tenant_id=${base.tenantId}::uuid order by id`});
 const before=await snapshot();
 await owner.client`create sequence public.p1_roster_reach`;
 await owner.client.unsafe(`create function public.p1_roster_fault() returns trigger language plpgsql as $$ begin perform nextval('public.p1_roster_reach'); if coalesce(NEW.shift_date,OLD.shift_date)=date '2026-07-07' then raise exception 'P1 late roster fault' using errcode='P1001'; end if; return coalesce(NEW,OLD); end $$`);
 await owner.client`create trigger p1_roster_fault before insert or update or delete on roster_assignment for each row execute function public.p1_roster_fault()`;
 try {
  let error:unknown;try{await assignRosterRow(ctx,{employmentId:person.employmentId,shiftDates:dates,brush:brush==='shift'?shift.id:brush});}catch(e){error=e;}
  const chain=JSON.stringify(error, Object.getOwnPropertyNames(error??{}));expect(chain).toContain('P1 late roster fault');
  expect(Number((await owner.client`select last_value from p1_roster_reach`)[0].last_value)).toBeGreaterThanOrEqual(2);
  expect(await snapshot()).toEqual(before);
 } finally {await owner.client`drop trigger p1_roster_fault on roster_assignment`;await owner.client`drop function public.p1_roster_fault()`;await owner.client`drop sequence public.p1_roster_reach`;}
 expect(await assignRosterRow(ctx,{employmentId:person.employmentId,shiftDates:dates,brush:brush==='shift'?shift.id:brush})).toEqual({applied:2});
 const after=await snapshot();expect(after.rows).toHaveLength(brush==='clear'?0:2);expect(after.events.length-before.events.length).toBe(2);
});

it.each(['rest','clear'] as const)('bulk %s action reports failure only after rolling back the whole selected population',async brush=>{
 const base=await seedBase(),ctx=adminCtx(base);session=ctx;
 const employees=[];
 for(let i=0;i<2;i++)employees.push((await hireEmployee(ctx,{companyId:base.companyId,departmentId:base.deptA,hiredOn:'2020-01-01',employmentType:'full_time',person:{fullName:`Bulk rollback ${i}`,primaryEmail:`bulk-${i}@test.invalid`}})).employmentId);
 const shift=await createShift(ctx,{companyId:base.companyId,name:'Bulk shift',code:'P1_BULK',startTime:'08:00:00',endTime:'17:00:00'}),dates=['2026-07-06','2026-07-07'];
 if(brush==='clear')for(const employmentId of employees)await assignRosterRow(ctx,{employmentId,shiftDates:dates,brush:shift.id});
 const snapshot=async()=>({rows:await owner.client`select row_to_json(r) as row from roster_assignment r where tenant_id=${base.tenantId}::uuid order by id`,events:await owner.client`select row_to_json(e) as row from domain_event e where tenant_id=${base.tenantId}::uuid order by id`});
 const before=await snapshot();
 await owner.client`create sequence public.p1_bulk_reach`;
 await owner.client.unsafe(`create function public.p1_bulk_fault() returns trigger language plpgsql as $$ begin perform nextval('public.p1_bulk_reach'); if coalesce(NEW.shift_date,OLD.shift_date)=date '2026-07-07' then raise exception 'P1 late bulk fault' using errcode='P1001'; end if; return coalesce(NEW,OLD); end $$`);
 await owner.client`create trigger p1_bulk_fault before insert or update or delete on roster_assignment for each row execute function public.p1_bulk_fault()`;
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try {
  const {bulkAssignAction}=await import('../app/roster/actions');expect((await bulkAssignAction({employmentIds:employees,shiftDates:dates,brush})).ok).toBe(false);
  expect(Number((await owner.client`select last_value from p1_bulk_reach`)[0].last_value)).toBeGreaterThanOrEqual(2);expect(await snapshot()).toEqual(before);
 } finally {log.mockRestore();await owner.client`drop trigger p1_bulk_fault on roster_assignment`;await owner.client`drop function public.p1_bulk_fault()`;await owner.client`drop sequence public.p1_bulk_reach`;}
 const {bulkAssignAction}=await import('../app/roster/actions');expect(await bulkAssignAction({employmentIds:employees,shiftDates:dates,brush})).toEqual({ok:true});
 const after=await snapshot();expect(after.rows).toHaveLength(brush==='clear'?0:4);expect(after.events.length-before.events.length).toBe(4);
});
