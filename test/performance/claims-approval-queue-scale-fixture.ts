/** Fictional scale fixture for the Claims approvals queue: N employees (the retained Personnel fixture, one
 * in five terminated), C pending claims each, a group HR administrator among them and a line manager in its
 * own department over R active reports, both with real logins and C claims of their own. Every pending claim
 * is written directly. */
import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import type {SessionContext} from '../../db/client';
import * as schema from '../../db/schema';
import {createClaimType,listPendingClaimsPage,listPendingClaimSelection} from '../../packs/claims/service';
import {adminCtx,entitledCtx,owner,setModule} from '../harness';
import {seedPersonnelNativeFixture} from './personnel-native-fixture';

export type ClaimQueueScaleFixture=Awaited<ReturnType<typeof seedClaimQueueScaleFixture>>;

export async function seedClaimQueueScaleFixture(shape:{employees:number;claimsPerEmployee:number;managerReports:number},
 report:Record<string,unknown>,save:()=>void){
 const {b}=await seedPersonnelNativeFixture(shape.employees,report,phase=>{report.phase=phase;save();},save);
 await setModule(b.tenantId,'claims','active');
 const root:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 const type=await createClaimType(root,{code:'SCALE',name:'Fictional scale travel',defaultTaxable:false,requiresReceipt:false});
 report.phase='claims';save();
 for(let offset=0;offset<shape.employees;offset+=10000){
  // Pseudo-random submission instants across one year, millisecond precision (ties break on id).
  await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,description,status,created_at)
   select e.tenant_id,e.id,${type.id}::uuid,'12.50','2026-02-02','Fictional scale claim','pending',
    timestamptz '2025-01-01 00:00:00+00'+((hashtextextended(e.id::text||':'||k,0)&9223372036854775807)%31536000000)*interval '1 millisecond'
   from (select id,tenant_id from employment where tenant_id=${b.tenantId}::uuid order by id offset ${offset} limit 10000) e
   cross join generate_series(1,${shape.claimsPerEmployee}::int) k`;
  report.committedClaimEmployees=Math.min(shape.employees,offset+10000);save();
 }
 report.phase='actors';save();
 const active=await owner.client<{id:string;person_id:string}[]>`select id,person_id from employment
  where tenant_id=${b.tenantId}::uuid and terminated_on is null order by id limit ${shape.managerReports+1}`;
 expect(active).toHaveLength(shape.managerReports+1);
 const [hr,...reports]=active;
 // The line manager sits in a department of its own: a manager also heads the department of its current
 // assignment (app.heads_department_of), and every fixture employee shares one department. It files the
 // same number of claims as everyone else.
 const manager={id:randomUUID(),person_id:randomUUID()};
 await owner.client`insert into person(id,tenant_id,full_name,primary_email)
  values(${manager.person_id}::uuid,${b.tenantId}::uuid,'Fictional scale line manager',${manager.person_id+'@example.invalid'})`;
 await owner.client`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)
  values(${manager.id}::uuid,${b.tenantId}::uuid,${manager.person_id}::uuid,${b.companyId}::uuid,'PERFMANAGER','2020-01-01')`;
 await owner.client`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
  values(${b.tenantId}::uuid,${manager.id}::uuid,${b.companyId}::uuid,${b.deptB}::uuid,'full_time','2020-01-01')`;
 await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,description,status,created_at)
  select ${b.tenantId}::uuid,${manager.id}::uuid,${type.id}::uuid,'12.50','2026-02-02','Fictional scale claim','pending',
   timestamptz '2025-06-01 00:00:00+00'+k*interval '1 hour' from generate_series(1,${shape.claimsPerEmployee}::int) k`;
 const login=async(person:{id:string;person_id:string},role:'manager'|'hr_admin'):Promise<SessionContext>=>{
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:person.person_id}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,companyId:null,role});
  return {...await entitledCtx(b,[role]),userId:user.id,personId:person.person_id,grants:[{role,companyId:null}]};
 };
 await owner.client`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from)
  select ${b.tenantId}::uuid,report.id,${manager.id}::uuid,'administrative','2020-01-01'
  from unnest(string_to_array(${reports.map(row=>row.id).join(',')}::text,',')::uuid[]) as report(id)`;
 const groupHr=await login(hr,'hr_admin'),lineManager=await login(manager,'manager');
 for(const table of ['claim_request','reporting_line','app_user','role_assignment','employment','person'])await owner.client.unsafe('analyze '+table);
 const [counts]=await owner.client<{claims:number;managerClaims:number}[]>`select count(*)::int as claims,
   count(*) filter(where employment_id=${manager.id}::uuid or employment_id in (select subordinate_employment_id from reporting_line
    where tenant_id=${b.tenantId}::uuid and manager_employment_id=${manager.id}::uuid))::int as "managerClaims"
  from claim_request where tenant_id=${b.tenantId}::uuid and status='pending'`;
 expect(counts).toEqual({claims:(shape.employees+1)*shape.claimsPerEmployee,managerClaims:(shape.managerReports+1)*shape.claimsPerEmployee});
 report.fixtureCounts=counts;report.phase='measure';save();
 return {b,root,groupHr,lineManager,counts,ownClaims:shape.claimsPerEmployee};
}

export type QueueTiming={medianMs:number;maxMs:number;samplesMs:number[]};
/** `runs` samples, except that a read slower than 20 s is not repeated (the figure is already the answer). */
async function timed<T>(runs:number,read:()=>Promise<T>):Promise<{value:T;timing:QueueTiming}>{
 const samples:number[]=[];let value!:T;
 for(let run=0;run<runs;run++){
  const started=performance.now();value=await read();samples.push(Math.round(performance.now()-started));
  if(samples[samples.length-1]>20000)break;
 }
 const sorted=samples.slice().sort((a,b)=>a-b);
 return {value,timing:{medianMs:sorted[Math.floor(sorted.length/2)],maxMs:sorted[sorted.length-1],samplesMs:samples}};
}

/** First, next and deep pages (newest first), the first name-sorted page, the oldest-first page, the "All"
 * page and select-all for one approver, each correct against the known total and measured `runs` times.
 * `record` receives every timing as soon as it is known, so a slow read still leaves its figures. */
export async function measureClaimQueue(ctx:SessionContext,total:number,ownClaims:number,deepPage:number,runs=3,
 record:(name:string,timing:QueueTiming)=>void=()=>{}){
 const pageCount=Math.ceil(total/25);
 expect(deepPage).toBeLessThan(pageCount);
 const step=async<T>(name:string,count:number,read:()=>Promise<T>)=>{const result=await timed(count,read);record(name,result.timing);return result;};
 const first=await step('firstPage',runs,()=>listPendingClaimsPage(ctx));
 const next=await step('nextPage',runs,()=>listPendingClaimsPage(ctx,{page:'1'}));
 const deep=await step('deepPage',runs,()=>listPendingClaimsPage(ctx,{page:String(deepPage)}));
 const last=await step('lastPage',1,()=>listPendingClaimsPage(ctx,{page:String(pageCount-1)}));
 const nameFirst=await step('nameAscFirstPage',runs,()=>listPendingClaimsPage(ctx,{sort:'name_asc'}));
 const nameDeep=await step('nameDescDeepPage',runs,()=>listPendingClaimsPage(ctx,{sort:'name_desc',page:String(deepPage)}));
 const oldest=await step('oldestFirstPage',runs,()=>listPendingClaimsPage(ctx,{sort:'oldest'}));
 const all=await step('allPage2000',runs,()=>listPendingClaimsPage(ctx,{size:'all'}));
 const selection=await step('selectAll',runs,()=>listPendingClaimSelection(ctx));
 for(const page of [first,next,deep,nameFirst,nameDeep,oldest])expect(page.value.page).toMatchObject({total,limit:25,hasNext:true});
 for(const page of [first,next,deep,nameFirst,nameDeep,oldest])expect(page.value.rows).toHaveLength(25);
 expect(last.value.rows).toHaveLength(total-(pageCount-1)*25);expect(last.value.page.hasNext).toBe(false);
 expect(all.value.rows).toHaveLength(Math.min(total,2000));expect(all.value.page.truncated).toBe(total>2000);
 // The pages tile the "All" page in order; time order holds within and across pages.
 expect([...first.value.rows,...next.value.rows].map(row=>row.id)).toEqual(all.value.rows.slice(0,50).map(row=>row.id));
 const at=(row:{createdAt:string})=>Date.parse(row.createdAt);
 for(const rows of [all.value.rows,deep.value.rows])for(let i=1;i<rows.length;i++){
  expect(at(rows[i-1])>at(rows[i])||(at(rows[i-1])===at(rows[i])&&rows[i-1].id<rows[i].id)).toBe(true);
 }
 for(let i=1;i<oldest.value.rows.length;i++)expect(at(oldest.value.rows[i-1])<=at(oldest.value.rows[i])).toBe(true);
 for(let i=1;i<nameFirst.value.rows.length;i++)expect((nameFirst.value.rows[i-1].claimantName??'').localeCompare(nameFirst.value.rows[i].claimantName??'')).toBeLessThanOrEqual(0);
 expect(selection.value).toHaveLength(total-ownClaims);
 expect(new Set(selection.value).size).toBe(selection.value.length);
 return {
  firstPage:first.timing,nextPage:next.timing,deepPage:{page:deepPage,...deep.timing},lastPage:{page:pageCount-1,...last.timing},
  nameAscFirstPage:nameFirst.timing,nameDescDeepPage:{page:deepPage,...nameDeep.timing},oldestFirstPage:oldest.timing,
  allPage2000:all.timing,selectAll:{ids:selection.value.length,...selection.timing},
 };
}
