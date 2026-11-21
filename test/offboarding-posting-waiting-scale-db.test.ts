import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {owner,migrateTestDb,resetDb,closeAll,createAppUser,seedBase,adminCtx,setModule} from './harness';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {hireEmployee} from '../core/org';
import {listPersonnelPostings,loadOffboardingPostingApprovers} from '../packs/personnel-postings/service';
import {observeNativeRead} from './helpers/native-read-observer';
beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

it('keeps waiting labels and the existing queue equivalent across 70 companies and 1000 employments, scopes and roles',async()=>{
 const f=await resignationJourneyFixture();
 const members=[];for(const name of ['Scale Aina','Scale Bala','Scale Chen','Scale Devi']){const person=await hireEmployee(f.admin,{person:{fullName:name,primaryEmail:randomUUID()+'@waiting-scale.example.test'},companyId:f.base.companyId,departmentId:f.base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});members.push({...person,userId:await createAppUser(f.base.tenantId,person.personId,'hr_admin')});}
 const companies=Array.from({length:70},(_,n)=>({id:randomUUID(),name:`Fictional posting company ${n}`}));
 const single=companies[2].id,scopedUser=await createAppUser(f.base.tenantId,null,'hr_admin'),emptyUser=await createAppUser(f.base.tenantId,null,'hr_admin');
 const context=(userId:string,roles:string[],personId:string|null=null):SessionContext=>({...f.admin,userId,personId,roles,grants:undefined});
 const scoped:SessionContext={...context(scopedUser,['hr_admin']),grants:[{role:'hr_admin',companyId:single}]};
 const empty:SessionContext={...context(emptyUser,['hr_admin']),grants:[{role:'hr_admin',companyId:companies[0].id}]};
 const approver=context(members[0].userId,['hr_admin'],members[0].personId);
 const fixture=Array.from({length:1000},(_,n)=>({n,id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),companyId:companies[n%70].id,sourceRef:randomUUID(),movementId:randomUUID(),name:`Fictional posting employee ${String(n).padStart(4,'0')}`,source:n%10===0?'probation':'offboarding',status:n%10===1?'approved':'pending',createdAt:new Date(Date.UTC(2025,0,1,0,0,n)).toISOString()}));
 // Imported historical queue manifest, independently defined before SQL/read execution. This is not a fabricated service approval.
 const pending=fixture.filter(p=>p.source==='offboarding'&&p.status==='pending').sort((a,b)=>b.n-a.n);
 expect({companies:companies.length,employments:fixture.length,pending:pending.length,probation:fixture.filter(p=>p.source==='probation').length,approved:fixture.filter(p=>p.status==='approved').length}).toEqual({companies:70,employments:1000,pending:800,probation:100,approved:100});
 await owner.db.execute(sql`insert into company(id,tenant_id,legal_name) select x.id,${f.base.tenantId}::uuid,x.name from jsonb_to_recordset(${JSON.stringify(companies)}::jsonb) x(id uuid,name text)`);
 await owner.db.execute(sql`update role_assignment set company_id=case when app_user_id=${scopedUser}::uuid then ${single}::uuid else ${companies[0].id}::uuid end where tenant_id=${f.base.tenantId}::uuid and app_user_id=any(${`{${scopedUser},${emptyUser}}`}::uuid[])`);
 const groups=[...f.config.groups.map(group=>group.id===f.groupId?{...group,members:[...group.members,scopedUser,emptyUser]}:group),{id:'waiting-scale',name:'Scale posting approvers',members:members.map(member=>member.userId),limit:0}];
 await owner.db.execute(sql`update lc_onboarding_config set data=jsonb_set(jsonb_set(data,'{groups}',${JSON.stringify(groups)}::jsonb),'{access,offboarding}',${JSON.stringify([f.managerUserId,scopedUser,emptyUser])}::jsonb) where tenant_id=${f.base.tenantId}::uuid`);
 await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',${JSON.stringify(groups)}::jsonb) where tenant_id=${f.base.tenantId}::uuid`);
 const data=JSON.stringify(fixture);
 await owner.db.execute(sql`insert into person(id,tenant_id,full_name,primary_email) select x."personId",${f.base.tenantId}::uuid,x.name,x."personId"::text||'@waiting-scale.example.test' from jsonb_to_recordset(${data}::jsonb) x("personId" uuid,name text)`);
 await owner.db.execute(sql`insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code) select x."employmentId",${f.base.tenantId}::uuid,x."personId",x."companyId",'2026-01-01','WAIT-'||x.n from jsonb_to_recordset(${data}::jsonb) x("employmentId" uuid,"personId" uuid,"companyId" uuid,n integer)`);
 // Historical receipt events are retained for approved fixture rows; native deferred posting completeness remains enabled.
 await owner.db.execute(sql`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) select x."movementId",${f.base.tenantId}::uuid,'employment',x."employmentId",'employment.movement.recorded','user',${f.managerUserId}::uuid,x."employmentId",jsonb_build_object('type','promotion','effectiveDate','2026-11-16','remarks','Imported fictional historical receipt') from jsonb_to_recordset(${data}::jsonb) x("movementId" uuid,"employmentId" uuid,status text) where x.status='approved'`);
 await owner.db.execute(sql`insert into personnel_posting(id,tenant_id,company_id,employment_id,number,source,source_ref,event_type,proposed,approver_group_id,status,approved_by,approved_at,applied,movement_id,idempotency_key,created_at) select x.id,${f.base.tenantId}::uuid,x."companyId",x."employmentId",10000+x.n,x.source,x."sourceRef",case when x.source='probation' then 'confirmation' else 'promotion' end,case when x.source='probation' then '{"effectiveDate":"2026-11-16"}'::jsonb else '{"effectiveDate":"2026-11-16","basicSalary":"5500.00"}'::jsonb end,'waiting-scale',x.status,case when x.status='approved' then ${f.managerUserId}::uuid end,case when x.status='approved' then x."createdAt" end,case when x.status='approved' then '{"effectiveDate":"2026-11-16","basicSalary":"5500.00"}'::jsonb end,case when x.status='approved' then x."movementId"::text end,'historical-'||x.n,x."createdAt" from jsonb_to_recordset(${data}::jsonb) x(id uuid,n integer,"companyId" uuid,"employmentId" uuid,"sourceRef" uuid,"movementId" uuid,source text,status text,"createdAt" timestamptz)`);
 const subjectUser=await createAppUser(f.base.tenantId,fixture[2].personId,'employee'),subject=context(subjectUser,['employee'],fixture[2].personId);
 const outsiderBase=await seedBase();await setModule(outsiderBase.tenantId,'lifecycle','active');
 const actors=[{name:'all PeopleOps',ctx:f.admin,wanted:pending},{name:'all configured approver',ctx:approver,wanted:pending},{name:'one-company PeopleOps',ctx:scoped,wanted:pending.filter(p=>p.companyId===single)},{name:'empty company',ctx:empty,wanted:[]},{name:'ordinary employee',ctx:f.watcher,wanted:[]},{name:'subject employee',ctx:subject,wanted:[]},{name:'other tenant',ctx:adminCtx(outsiderBase),wanted:[]}];
 for(const actor of actors){
  const got:string[]=[];
  for(let offset=0;;offset+=100){
   const expected=actor.wanted.slice(offset,offset+100),page=await listPersonnelPostings(actor.ctx,{source:'offboarding',status:'pending',offset,limit:100});
   expect(page.rows.map(row=>row.id),actor.name+'/'+offset).toEqual(expected.map(row=>row.id));expect(page.hasMore).toBe(actor.wanted.length>offset+100);
   const labels=await loadOffboardingPostingApprovers(actor.ctx,page.rows.map(row=>row.id));expect(Object.keys(labels).sort()).toEqual(expected.map(row=>row.id).sort());
   for(const item of expected)expect(labels[item.id]).toEqual({names:['Scale Aina','Scale Bala','Scale Chen'],total:4});
   expect(JSON.stringify(page.rows)).not.toContain('Scale Aina');got.push(...page.rows.map(row=>row.id));if(!page.hasMore)break;
  }
  expect(got,actor.name+' complete ordering/count').toEqual(actor.wanted.map(row=>row.id));
 }
 const ids=fixture.slice(0,50).map(row=>row.id),singleIds=fixture.filter(row=>row.companyId===single).map(row=>row.id);
 expect(await loadOffboardingPostingApprovers(f.admin,ids)).toEqual(Object.fromEntries(fixture.slice(0,50).filter(row=>row.source==='offboarding'&&row.status==='pending').map(row=>[row.id,{names:['Scale Aina','Scale Bala','Scale Chen'],total:4}]))); // Explicit approved and Probation IDs never disclose waiting names.
 expect(await loadOffboardingPostingApprovers(scoped,ids)).toEqual(Object.fromEntries(fixture.slice(0,50).filter(row=>row.companyId===single&&row.source==='offboarding'&&row.status==='pending').map(row=>[row.id,{names:['Scale Aina','Scale Bala','Scale Chen'],total:4}])));
 expect(Object.keys(await loadOffboardingPostingApprovers(f.admin,singleIds)).sort()).toEqual(pending.filter(row=>row.companyId===single).map(row=>row.id).sort());
 const probe=observeNativeRead({captureQueries:true});try{const page=await listPersonnelPostings(f.admin,{source:'offboarding',status:'pending',limit:50});expect(page.rows).toHaveLength(50);expect(Object.keys(await loadOffboardingPostingApprovers(f.admin,page.rows.map(row=>row.id)))).toHaveLength(50);}finally{probe.restore();}
 const businessReads=probe.queries.filter(query=>/from personnel_posting|personnel_posting_groups\(|personnel_posting_people\(|offboarding_posting_waiting_members\(/i.test(query.sql));
 expect(businessReads.length).toBeLessThanOrEqual(4);expect(businessReads.filter(query=>query.sql.includes('offboarding_posting_waiting_members('))).toHaveLength(1);
},270000);
