import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {hireEmployee} from '../core/org';
import {withTenant,type SessionContext} from '../db/client';
import {sql} from 'drizzle-orm';
import {offboardingRequisition,updateOffboardingRequisitionItem,v9Setup,v9Workspace,v9SaveConfig,v9CreateOffboarding,v9Command,onboardingContext,onboardingSaveConfig} from '../packs/lifecycle/service';
import {closeAll,resetDb,seedBase,setModule,entitledCtx,owner,createAppUser,type Base} from './harness';
let b:Base,admin:SessionContext,team:SessionContext,other:SessionContext,employmentId:string;
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const subject=await hireEmployee(admin,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional leaver',primaryEmail:'leaver@example.invalid'}});employmentId=subject.employmentId;
 const member=await hireEmployee(admin,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional IT fulfiller',primaryEmail:'it@example.invalid'}});
 team={...admin,userId:await createAppUser(b.tenantId,member.personId,'employee'),personId:member.personId,roles:['employee'],grants:undefined};
 const stranger=await hireEmployee(admin,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional stranger',primaryEmail:'other@example.invalid'}});
 other={...team,userId:await createAppUser(b.tenantId,stranger.personId,'employee'),personId:stranger.personId};await v9Setup(admin);
 const native=await onboardingContext(admin);native.config.access.offboarding=[admin.userId!];native.config.groups.push({id:'rvk-it',name:'IT',members:[team.userId!],limit:0});await onboardingSaveConfig(admin,native.revision,native.config);
 const config=(await v9Workspace(admin)).config!;config.checklists=[];config.workflows=[];await v9SaveConfig(admin,config.revision,config);
});afterAll(closeAll);
async function prepared(){
 const id=await v9CreateOffboarding(admin,{employmentId,type:'Resignation',noticeDate:'2026-11-01',lastDay:'2027-01-31'});await v9Command(admin,id,1,{type:'submit'});
 const items=[{id:'access',name:'Fictional access',kind:'system',sourceId:null,group:'rvk-it',assignee:team.userId,dueOn:'2027-01-20',status:'todo',reason:''},{id:'laptop',name:'Fictional laptop',kind:'device',sourceId:null,group:'rvk-it',assignee:team.userId,dueOn:'2027-01-31',status:'todo',reason:''},{id:'private',name:'Private facilities item',kind:'device',sourceId:null,group:'private-group',assignee:other.userId,dueOn:'2027-01-31',status:'todo',reason:''}];
 await owner.client`update lc_v9_case set data=data||jsonb_build_object('items',${JSON.stringify(items)}::jsonb,'privateFixture','No case blob may escape','revokeMode','date','revokeDate','2027-01-20') where id=${id}::uuid`;
 return id;
}
it('projects the existing RVK owner with exact item scope, safe activity and independently counted statuses',async()=>{
 const id=await prepared(),full=await offboardingRequisition(admin,id),own=await offboardingRequisition(team,id);
 expect(full.items.map(i=>i.id)).toEqual(['access','laptop','private']);expect(own.items.map(i=>i.id)).toEqual(['access','laptop']);expect(own.fullView).toBe(false);expect(own.items.map(i=>i.dueOn)).toEqual(['2027-01-20','2027-01-31']);
 expect(JSON.stringify(own)).not.toContain('Private facilities');expect(JSON.stringify(own)).not.toContain('No case blob');expect(own.activity.map(a=>a.detail)).toEqual(['Fictional laptop','Fictional access']);
 await expect(offboardingRequisition(other,id)).rejects.toThrow('unavailable');
 expect(await withTenant(team,tx=>tx.execute(sql`select id from lc_v9_case where id=${id}::uuid`))).toEqual([]);
 await expect(offboardingRequisition({...admin,grants:[{role:'hr_admin',companyId:randomUUID()}]},id)).rejects.toThrow('unavailable');
 const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');await expect(offboardingRequisition(await entitledCtx(foreign),id)).rejects.toThrow('unavailable');
});
it('uses canonical status writes in both directions, rejects stale/foreign item commands and records completion separately from case closure',async()=>{
 const id=await prepared();let own=await offboardingRequisition(team,id);
 await expect(updateOffboardingRequisitionItem(team,{caseId:id,revision:own.revision,itemId:'private',status:'done',reason:''})).rejects.toThrow();
 own=await updateOffboardingRequisitionItem(team,{caseId:id,revision:own.revision,itemId:'access',status:'done',reason:''});
 expect((await offboardingRequisition(admin,id)).items[0].status).toBe('done');
 await expect(updateOffboardingRequisitionItem(team,{caseId:id,revision:own.revision-1,itemId:'laptop',status:'done',reason:''})).rejects.toThrow('changed');
 let full=await offboardingRequisition(admin,id);await v9Command(admin,id,full.revision,{type:'item',id:'private',status:'notNeeded',reason:'No device issued'});
 own=await offboardingRequisition(team,id);await expect(updateOffboardingRequisitionItem(team,{caseId:id,revision:own.revision,itemId:'laptop',status:'notReturned',reason:' '})).rejects.toThrow();
 own=await updateOffboardingRequisitionItem(team,{caseId:id,revision:own.revision,itemId:'laptop',status:'notReturned',reason:'Reported missing'});
 full=await offboardingRequisition(admin,id);expect(full.clearedAt).toBeNull();expect(full.items[1].reason).toBe('Reported missing');expect(own.items[1].canAct).toBe(false);
 full=await updateOffboardingRequisitionItem(admin,{caseId:id,revision:full.revision,itemId:'laptop',status:'done',reason:'Recovered by HR'});
 expect(full.state).toBe('submitted');expect(full.clearedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);const stamp=full.clearedAt;
 await owner.client`update lc_v9_case set data=jsonb_set(data,'{itemsClearedAt}','"forged"') where id=${id}::uuid`;expect((await offboardingRequisition(admin,id)).clearedAt).toBe(stamp);
 full=await updateOffboardingRequisitionItem(admin,{caseId:id,revision:full.revision,itemId:'access',status:'progress',reason:'Access reopened'});expect(full.clearedAt).toBeNull();
});
it('does not invent legacy completion dates or treat an unreviewed Not returned as successful recovery',async()=>{
 const id=await prepared();await owner.client`alter table lc_v9_case disable trigger offboarding_requisition_history`;
 try{await owner.client`update lc_v9_case set data=jsonb_set(data,'{items}',(select jsonb_agg(i||'{"status":"done"}'::jsonb) from jsonb_array_elements(data->'items') i))-'itemsClearedAt' where id=${id}::uuid`;}finally{await owner.client`alter table lc_v9_case enable trigger offboarding_requisition_history`;}
 await owner.client`update lc_v9_case set data=data||'{"closedAt":"2030-01-01T00:00:00Z"}'::jsonb where id=${id}::uuid`;
 expect((await offboardingRequisition(admin,id)).clearedAt).toBeNull();
});

it('SQL-pages exact register counts and order for 70 companies/1000 employments under all companies and one company',async()=>{
 const {offboardingRequisitions}=await import('../packs/lifecycle/service');const id=await prepared();
 const [source]=await owner.client`select data from lc_v9_case where id=${id}::uuid`;
 const companies=await owner.client`insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'RVK group '||lpad(n::text,3,'0') from generate_series(1,70) n returning id`;
 await owner.client`insert into person(tenant_id,full_name,primary_email) select ${b.tenantId}::uuid,'RVK employee '||lpad(n::text,4,'0'),'rvk-'||n||'@example.invalid' from generate_series(1,1000) n`;
 await owner.client`with people as(select id,row_number() over(order by full_name) n from person where tenant_id=${b.tenantId}::uuid and full_name like 'RVK employee %'),companies as(select id,row_number() over(order by legal_name)-1 n from company where tenant_id=${b.tenantId}::uuid and legal_name like 'RVK group %') insert into employment(tenant_id,person_id,company_id,hired_on) select ${b.tenantId}::uuid,p.id,c.id,'2026-01-01'::date from people p join companies c on c.n=(p.n-1)%70`;
 await owner.client`with people as(select gen_random_uuid() id,e.id employment_id,e.person_id,e.company_id,p.full_name,row_number() over(order by p.full_name) n from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.tenant_id=${b.tenantId}::uuid and p.full_name like 'RVK employee %') insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,data) select id,${b.tenantId}::uuid,company_id,employment_id,'off','OFB9-GROUP-'||lpad(n::text,4,'0'),${JSON.stringify(source.data)}::jsonb||jsonb_build_object('id',id,'number','OFB9-GROUP-'||lpad(n::text,4,'0'),'facts',${JSON.stringify(source.data.facts)}::jsonb||jsonb_build_object('employmentId',employment_id,'personId',person_id,'company',company_id,'name',full_name)) from people`;
 const one=companies[0].id;
 for(const companyId of [undefined,one]){
  const expected=await owner.client`select id::text,number from lc_v9_case where tenant_id=${b.tenantId}::uuid and number like 'OFB9-GROUP-%' and (${companyId===undefined} or company_id=${companyId??null}::uuid) order by data->'facts'->>'lastDay',number,id`;
  const actual:string[]=[];let total=0;
  for(let offset=0;offset<1100;offset+=100){const page=await offboardingRequisitions(admin,{search:'OFB9-GROUP-',companyId,offset,limit:100});total=page.total;actual.push(...page.items.map(i=>i.id));expect(page.items.every(i=>i.total===3&&i.done===0&&i.exceptions===0)).toBe(true);if(page.items.length<100)break;}
  expect(actual.length).toBeGreaterThan(0);expect(actual).toEqual(expected.map(r=>r.id));expect(total).toBe(expected.length);expect(new Set(actual).size).toBe(actual.length);
 }
 expect((await offboardingRequisitions(other,{search:'OFB9-GROUP-'})).items).toEqual([]);
 const [shape]=await owner.client`select count(distinct company_id)::integer companies,count(*)::integer employments from lc_v9_case where tenant_id=${b.tenantId}::uuid and number like 'OFB9-GROUP-%'`;expect(shape).toEqual({companies:70,employments:1000});
},270000); // Includes canonical 1000-case inserts and two complete hosted SQL page walks; no request-side row loops.


it('keeps saved legacy organisation labels but never treats an unresolved master UUID as a label',async()=>{
 const id=await prepared();
 await owner.client`update lc_v9_case set data=jsonb_set(jsonb_set(data,'{facts,title}','"Legacy analyst"'),'{facts,businessGroup}','"Legacy group"') where id=${id}::uuid`;
 expect(await offboardingRequisition(admin,id)).toMatchObject({position:'Legacy analyst',businessGroup:'Legacy group'});
 const foreign=await seedBase();
 await owner.client`update lc_v9_case set data=jsonb_set(jsonb_set(data,'{facts,title}',to_jsonb(${foreign.positionId}::text)),'{facts,businessGroup}',to_jsonb(${randomUUID()}::text)) where id=${id}::uuid`;
 expect(await offboardingRequisition(admin,id)).toMatchObject({position:'',businessGroup:''});
});
