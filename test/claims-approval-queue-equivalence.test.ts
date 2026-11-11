/** The batched, SQL-paged Claims approvals queue (listPendingClaimsPage / listPendingClaimSelection) must
 * return exactly what the former per-row queue returned: the same claims, rows, order, counts and selection,
 * for every kind of approver. The former queue is reproduced verbatim in ./helpers/claims-legacy-queue.ts. Real DB, one
 * varied fictional fixture: delegation windows and scopes, a subsidiary and a sister company, a terminated
 * report, indirect reports, the approvers' own claims, colliding names, tied and sub-millisecond submission
 * times, non-pending claims and a second tenant. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {createCompany,createDepartment} from '../core/admin';
import {hireEmployee,setReportingLine} from '../core/org';
import {createClaimType,listPendingClaimsPage,listPendingClaimSelection,type ClaimRow} from '../packs/claims/service';
import {APPROVAL_SORTS} from '../lib/approvals-sort';
import {todayInKualaLumpur} from '../lib/hr-date';
import {legacyClaimInbox} from './helpers/claims-legacy-queue';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={employmentId:string;personId:string};
type Role='employee'|'manager'|'hr_admin';
type Approver={ctx:SessionContext;subjects:Person[]};

// Collected before the fixture exists (it.each reads its table at collection time).
const APPROVERS=['root HR administrator (no person)','group HR with own claims','company-scoped HR (sister company)',
 'company-scoped HR (home company and its subsidiary)','line manager','senior manager (indirect reports)','active delegate',
 'expired delegate','future delegate','department-scoped delegate','leave-only delegate','delegator (manager of its own reports)',
 'employee'] as const;

let b:Base,root:SessionContext;
const approvers=new Map<(typeof APPROVERS)[number],Approver>();
const pendingBySubject=new Map<string,string[]>();
let tenantPending:string[]=[];

const day=(n:number)=>{const d=new Date(todayInKualaLumpur()+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};

async function hire(fullName:string,companyId:string,departmentId:string):Promise<Person>{
 return hireEmployee(root,{person:{fullName,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
}
/** A real login: app user, the exact role row the claimed grant needs, and the session that claims it. */
async function login(p:Person,role:Role,companyId:string|null=null):Promise<SessionContext>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:p.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,companyId,role});
 return {...await entitledCtx(b,[role]),userId:user.id,personId:p.personId,grants:[{role,companyId}]};
}
const administrative=(sub:Person,manager:Person)=>setReportingLine(root,{subordinateEmploymentId:sub.employmentId,
 managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();await setModule(b.tenantId,'claims','active');
 root={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 const subsidiary=await createCompany(root,{legalName:'Fictional Subsidiary Company',parentCompanyId:b.companyId,country:'MY',currency:'MYR'});
 const subsidiaryDept=await createDepartment(root,{companyId:subsidiary.id,name:'Fictional Subsidiary Department'});
 const sister=await createCompany(root,{legalName:'Fictional Sister Company',country:'MY',currency:'MYR'});
 const sisterDept=await createDepartment(root,{companyId:sister.id,name:'Fictional Sister Department'});
 const A=b.companyId;

 // Line management: a senior manager over a line manager, whose reports span the home company, its
 // subsidiary (visible through the company clamp), a sister company (not visible to the manager) and a
 // terminated report (not visible to the manager); one report has a report of their own (indirect).
 const senior=await hire('Fictional Senior Manager',A,b.deptA),manager=await hire('Fictional Line Manager',A,b.deptA);
 await administrative(manager,senior);
 const r1=await hire('Fictional Aaron Tan',A,b.deptA),r2=await hire('fictional aaron tan',A,b.deptB);
 const r3=await hire('Fictional Ámelia Wong',A,b.deptA),r4=await hire('Fictional Ng Mei',A,b.deptB);
 const r5=await hire('Fictional Ng Mei',subsidiary.id,subsidiaryDept.id),r6=await hire('Fictional Ömer Kaya',sister.id,sisterDept.id);
 for(const report of [r1,r2,r3,r4,r5,r6])await administrative(report,manager);
 const indirect=await hire('Fictional Omer Kaya',A,b.deptB);await administrative(indirect,r1);
 // Terminated report, written directly (a closed employment cannot be hired or re-lined by the services).
 const ended:Person={personId:randomUUID(),employmentId:randomUUID()};
 await owner.db.insert(schema.person).values({id:ended.personId,tenantId:b.tenantId,fullName:'Fictional Zara Lim',primaryEmail:ended.personId+'@fixture.test'});
 await owner.db.insert(schema.employment).values({id:ended.employmentId,tenantId:b.tenantId,personId:ended.personId,companyId:A,hiredOn:'2020-01-01',terminatedOn:'2024-06-30'});
 await owner.db.insert(schema.assignment).values({tenantId:b.tenantId,employmentId:ended.employmentId,companyId:A,departmentId:b.deptA,employmentType:'full_time',validFrom:'2020-01-01'});
 await owner.db.insert(schema.reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:ended.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});

 // Delegations: one delegator per window/scope, each with two reports in different departments.
 const delegation=async(label:string)=>{
  const delegator=await hire('Fictional Delegator '+label,A,b.deptA),stand=await hire('Fictional Stand-in '+label,A,b.deptB);
  const reports=[await hire('Fictional Siti Aminah '+label,A,b.deptA),await hire('fictional siti aminah '+label,A,b.deptB)];
  for(const report of reports)await administrative(report,delegator);
  return {delegator,stand,reports};
 };
 const active=await delegation('Active'),expired=await delegation('Expired'),future=await delegation('Future');
 const scoped=await delegation('Department'),leaveOnly=await delegation('Leave');
 await setReportingLine(root,{subordinateEmploymentId:active.delegator.employmentId,managerEmploymentId:active.stand.employmentId,lineType:'delegate',validFrom:day(-10),validTo:day(30)});
 await setReportingLine(root,{subordinateEmploymentId:scoped.delegator.employmentId,managerEmploymentId:scoped.stand.employmentId,lineType:'delegate',validFrom:day(-10),validTo:day(30),
  orgScope:{companyId:null,businessUnitId:null,departmentId:b.deptA}});
 await setReportingLine(root,{subordinateEmploymentId:leaveOnly.delegator.employmentId,managerEmploymentId:leaveOnly.stand.employmentId,lineType:'delegate',validFrom:day(-10),validTo:day(30),
  scopes:[{module:'leave',taskType:null}]});
 await owner.db.insert(schema.reportingLine).values([
  {tenantId:b.tenantId,subordinateEmploymentId:expired.delegator.employmentId,managerEmploymentId:expired.stand.employmentId,lineType:'delegate',validFrom:day(-60),validTo:day(-30)},
  {tenantId:b.tenantId,subordinateEmploymentId:future.delegator.employmentId,managerEmploymentId:future.stand.employmentId,lineType:'delegate',validFrom:day(20),validTo:day(40)},
 ]);

 const employee=await hire('Fictional 李 Wei',A,b.deptA);
 const groupHr=await hire('Fictional Group HR',A,b.deptA),sisterHr=await hire('Fictional Sister HR',sister.id,sisterDept.id);

 const everyone:Person[]=[senior,manager,r1,r2,r3,r4,r5,r6,indirect,ended,employee,groupHr,sisterHr,
  ...[active,expired,future,scoped,leaveOnly].flatMap(d=>[d.delegator,d.stand,...d.reports])];

 // Claims: two types (one with an item), varied submission times with shared instants across claimants,
 // and a non-pending tail that no queue may show.
 const travel=await createClaimType(root,{code:'EQTRAVEL',name:'Fictional equivalence travel',defaultTaxable:false,requiresReceipt:false});
 const meal=await createClaimType(root,{code:'EQMEAL',name:'Fictional equivalence meal',defaultTaxable:true,requiresReceipt:false});
 const [item]=await owner.db.insert(schema.claimItem).values({tenantId:b.tenantId,claimTypeId:meal.id,code:'LUNCH',name:'Fictional lunch'}).returning({id:schema.claimItem.id});
 const base=Date.UTC(2026,2,1);
 const rows:(typeof schema.claimRequest.$inferInsert)[]=[];
 everyone.forEach((p,i)=>{
  const count=3+(i%4);
  for(let k=0;k<count;k++){
   // Every third claim shares an instant with other claimants (tie broken by id); the rest are distinct.
   const minute=k%3===0?k*7:i*11+k;
   rows.push({id:randomUUID(),tenantId:b.tenantId,employmentId:p.employmentId,claimTypeId:k%2?meal.id:travel.id,claimItemId:k%2&&k%4===1?item.id:null,
    amount:(10+i+k).toFixed(2),incurredOn:'2026-02-'+String(1+((i+k)%27)).padStart(2,'0'),description:'Fictional claim '+i+'.'+k,taxable:k%2===1,
    status:'pending',createdAt:new Date(base+minute*60000)});
  }
 });
 const nonPending=everyone.slice(0,6).flatMap((p,i)=>(['draft','approved','rejected'] as const).map(status=>({id:randomUUID(),tenantId:b.tenantId,employmentId:p.employmentId,claimTypeId:travel.id,
  amount:'5.00',incurredOn:'2026-02-02',status,createdAt:new Date(base+(500+i)*60000)})));
 // Sub-millisecond instants: the driver's JS Date truncates to the millisecond, so the former in-memory sort
 // tied these on id. Their microseconds run in id order, so ordering by microseconds would reverse each tie.
 const micro=rows.filter((_,i)=>i%9===4).slice(0,5).sort((x,y)=>x.id!.localeCompare(y.id!));
 const microAt=new Map(micro.map((row,i)=>[row.id!,'2026-03-05 10:00:00.'+['000100','000500','000900','001100','001900'][i]+'+00']));
 await owner.db.insert(schema.claimRequest).values([...rows.filter(row=>!microAt.has(row.id!)),...nonPending]);
 for(const row of micro){
  await owner.client`insert into claim_request(id,tenant_id,employment_id,claim_type_id,claim_item_id,amount,incurred_on,description,taxable,status,created_at)
   values(${row.id!}::uuid,${row.tenantId}::uuid,${row.employmentId}::uuid,${row.claimTypeId}::uuid,${row.claimItemId??null}::uuid,${row.amount}::numeric,
    ${row.incurredOn}::date,${row.description??null},${row.taxable??false},'pending',${microAt.get(row.id!)!}::timestamptz)`;
 }
 // One receipt each on a few claims (attachments ride with the page rows).
 await owner.db.insert(schema.claimAttachment).values(rows.filter((_,i)=>i%13===2).map(row=>({tenantId:b.tenantId,claimRequestId:row.id!,
  employmentId:row.employmentId,fileName:'fictional-receipt.txt',mimeType:'text/plain',content:Buffer.from('fictional receipt'),sizeBytes:17})));
 for(const row of rows)pendingBySubject.set(row.employmentId,[...(pendingBySubject.get(row.employmentId)??[]),row.id!]);
 tenantPending=rows.map(row=>row.id!);

 // A second tenant's pending claims never reach this tenant's queues.
 const foreign=await seedBase();await setModule(foreign.tenantId,'claims','active');
 const foreignRoot:SessionContext={...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]};
 const foreignType=await createClaimType(foreignRoot,{code:'EQTRAVEL',name:'Fictional foreign travel',defaultTaxable:false,requiresReceipt:false});
 const foreignPerson=await hireEmployee(foreignRoot,{person:{fullName:'Fictional Aaron Tan',primaryEmail:randomUUID()+'@fixture.test'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await owner.db.insert(schema.claimRequest).values(Array.from({length:4},(_,k)=>({tenantId:foreign.tenantId,employmentId:foreignPerson.employmentId,claimTypeId:foreignType.id,
  amount:'7.00',incurredOn:'2026-02-03',status:'pending' as const,createdAt:new Date(base+k*60000)})));
 for(const table of ['claim_request','claim_attachment','employment','person','reporting_line','role_assignment','app_user'])await owner.client.unsafe('analyze '+table);

 // Approvers, each with the subjects it must see on its own terms (the independent expectation).
 const homeCompany=everyone.filter(p=>![r5,r6,sisterHr].includes(p));
 approvers.set('root HR administrator (no person)',{ctx:root,subjects:everyone});
 approvers.set('group HR with own claims',{ctx:await login(groupHr,'hr_admin'),subjects:everyone});
 approvers.set('company-scoped HR (sister company)',{ctx:await login(sisterHr,'hr_admin',sister.id),subjects:[r6,sisterHr]});
 approvers.set('company-scoped HR (home company and its subsidiary)',{ctx:await login(await hire('Fictional Home HR',A,b.deptB),'hr_admin',A),subjects:[...homeCompany,r5]});
 approvers.set('line manager',{ctx:await login(manager,'manager'),subjects:[manager,r1,r2,r3,r4,r5,indirect]});
 approvers.set('senior manager (indirect reports)',{ctx:await login(senior,'manager'),subjects:[senior,manager,r1,r2,r3,r4,r5,indirect]});
 approvers.set('active delegate',{ctx:await login(active.stand,'manager'),subjects:[active.stand,...active.reports]});
 approvers.set('expired delegate',{ctx:await login(expired.stand,'manager'),subjects:[expired.stand]});
 approvers.set('future delegate',{ctx:await login(future.stand,'manager'),subjects:[future.stand]});
 approvers.set('department-scoped delegate',{ctx:await login(scoped.stand,'manager'),subjects:[scoped.stand,scoped.reports[0]]});
 approvers.set('leave-only delegate',{ctx:await login(leaveOnly.stand,'manager'),subjects:[leaveOnly.stand]});
 approvers.set('delegator (manager of its own reports)',{ctx:await login(active.delegator,'manager'),subjects:[active.delegator,...active.reports]});
 approvers.set('employee',{ctx:await login(employee,'employee'),subjects:[employee]});
},300000);
afterAll(closeAll);

const expectedClaims=(subjects:Person[])=>subjects.flatMap(p=>pendingBySubject.get(p.employmentId)??[]).sort();

describe('the batched claims approvals queue equals the former per-row queue',()=>{
 it('covers a fixture that exercises every path',()=>{
  expect(tenantPending).toHaveLength(147);
  expect([...approvers.keys()]).toEqual([...APPROVERS]);
 });

 it.each(APPROVERS)('%s: same claims, rows, order, counts and selection',async name=>{
  const {ctx,subjects}=approvers.get(name)!;
  const legacy=await legacyClaimInbox(ctx);
  // The oracle itself: the former queue is the base inbox set, and both are the subjects this approver may decide.
  const expected=expectedClaims(subjects);
  expect(expected.length).toBeGreaterThan(0);
  expect(legacy.queue.map(row=>row.id).sort()).toEqual(expected);
  expect(legacy.base.map(row=>row.id).sort()).toEqual(expected);

  for(const sort of APPROVAL_SORTS){
   for(const size of [undefined,'50','all']){
    const pages=size==='all'?1:Math.ceil(expected.length/(size?Number(size):25))+1;
    for(let page=0;page<pages;page++){
     const opts={page:String(page),size};
     const actual=await listPendingClaimsPage(ctx,{...opts,sort});
     expect(actual,`${name} ${sort} size=${size??25} page=${page}`).toEqual(legacy.page(sort,opts));
    }
   }
  }
  // The default call (no sort, no page) is the latest-first first page.
  expect(await listPendingClaimsPage(ctx)).toEqual(legacy.page('latest',{}));
  const selection=await listPendingClaimSelection(ctx);
  expect(selection).toEqual(legacy.selection);
  // The approver's own claims are in its queue but never in its selection.
  const own=ctx.personId?subjects.filter(p=>p.personId===ctx.personId).flatMap(p=>pendingBySubject.get(p.employmentId)??[]):[];
  expect(selection).toEqual(expected.filter(id=>!own.includes(id)));
 },120000);

 it('keeps the inbox order deterministic under ties and sub-millisecond instants',async()=>{
  const {ctx}=approvers.get('group HR with own claims')!;
  const all=(await listPendingClaimsPage(ctx,{size:'all'})).rows;
  expect(all).toHaveLength(tenantPending.length);
  const key=(row:ClaimRow)=>new Date(row.createdAt).getTime();
  for(let i=1;i<all.length;i++){
   const previous=all[i-1],current=all[i];
   expect(key(previous)>key(current)||(key(previous)===key(current)&&previous.id.localeCompare(current.id)<0)).toBe(true);
  }
  // The same-millisecond groups whose microseconds run against the id tie-break are really present.
  const ties=await owner.client<{at:string;n:number}[]>`select to_char(date_trunc('milliseconds',created_at) at time zone 'UTC','HH24:MI:SS.MS') as at,count(*)::int as n
   from claim_request where tenant_id=${b.tenantId}::uuid and created_at>=timestamptz '2026-03-05 10:00:00+00' and created_at<timestamptz '2026-03-05 10:00:01+00'
   group by 1 order by 1`;
  expect([...ties]).toEqual([{at:'10:00:00.000',n:3},{at:'10:00:00.001',n:2}]);
  const [early,late]=[all.filter(row=>row.createdAt==='2026-03-05T10:00:00.000Z'),all.filter(row=>row.createdAt==='2026-03-05T10:00:00.001Z')];
  expect(early.map(row=>row.id)).toEqual(early.map(row=>row.id).sort());
  expect(late.map(row=>row.id)).toEqual(late.map(row=>row.id).sort());
  expect(all.indexOf(late[0])).toBeLessThan(all.indexOf(early[0]));
 });
});
