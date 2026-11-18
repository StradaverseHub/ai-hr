/** Shared Offboarding and native Onboarding have distinct registry owners; generation freezes the selected holder. */
import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {createCompany} from '../core/admin';
import {hireEmployee} from '../core/org';
import {saveAutomationRouting} from '../core/automation-store';
import {v9Setup,v9Workspace,v9SaveConfig,v9CreateOffboarding,v9Command,v9ReadDocumentSigningWork,v9DocumentRouteAct} from '../packs/lifecycle/service';
import {closeAll,resetDb,seedBase,setModule,entitledCtx,owner,createAppUser,type Base} from './harness';
let base:Base,admin:SessionContext,employee:SessionContext,other:SessionContext,employmentId:string;
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'lifecycle','active');admin=await entitledCtx(base);
 const hr=await hireEmployee(admin,{companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional shared-route HR',primaryEmail:'shared-route-hr@fixture.invalid'}});
 await owner.withTenant(admin,tx=>tx.execute(sql`update app_user set person_id=${hr.personId}::uuid where id=${admin.userId!}::uuid and tenant_id=${base.tenantId}::uuid`));admin={...admin,personId:hr.personId};
 const subject=await hireEmployee(admin,{companyId:base.companyId,departmentId:base.deptA,positionId:base.positionId,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional offboarding subject',primaryEmail:'shared-route-subject@fixture.invalid'}});employmentId=subject.employmentId;
 employee={...admin,userId:await createAppUser(base.tenantId,subject.personId,'employee'),personId:subject.personId,roles:['employee'],grants:undefined};
 const stranger=await hireEmployee(admin,{companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01',person:{fullName:'Fictional other participant',primaryEmail:'shared-route-other@fixture.invalid'}});other={...employee,userId:await createAppUser(base.tenantId,stranger.personId,'employee'),personId:stranger.personId};
 await v9Setup(admin);
});
afterAll(closeAll);
it('generates from the latest configured shared revision, independently verifies its holder and preserves that frozen holder after a routing change',async()=>{
 const routingId=randomUUID(),unreferenced=randomUUID(),otherCompany=await createCompany(admin,{legalName:'Fictional unrelated routing company',companyLabel:'OTHER-ROUTE',country:'MY',currency:'MYR'});
 const definition={id:routingId,name:'Fictional shared Offboarding signing',rows:[{match:{company:[otherCompany.id]},assignTo:{kind:'people' as const,userIds:[other.userId!]}},{match:{company:[base.companyId]},assignTo:{kind:'people' as const,userIds:[admin.userId!]}}]};
 await saveAutomationRouting(admin,{routing:definition,retired:false,expectedRevision:0,reason:'Fictional configured Offboarding route'});
 await saveAutomationRouting(admin,{routing:{...definition,id:unreferenced,name:'Fictional unreferenced route'},retired:false,expectedRevision:0,reason:'Unreferenced route must remain outside case projection'});
 const config=(await v9Workspace(admin)).config!;config.emails=[];config.checklists=[{id:'off-shared-checklist',name:'Shared route fixture',module:'off',rules:{},tasks:[]}];
 config.templates=[{id:'off-shared-letter',name:'Shared routing letter',module:'off',type:'Letter',rules:{},hrStep:'none',employeeAck:false,retired:false,versions:[{version:1,state:'published',at:'',by:'',fields:[],blocks:[{id:'shared-signature',type:'signature',text:'',section:'',role:'step:shared-sign'}],routing:[{id:'shared-sign',order:1,action:'sign',owner:true,required:true,who:{kind:'routing',routingId}}]}]}];
 config.templates.push({...structuredClone(config.templates[0]),id:'off-other-company',rules:{company:[otherCompany.id]},versions:config.templates[0].versions.map(version=>({...structuredClone(version),routing:version.routing!.map(step=>({...step,who:{kind:'routing' as const,routingId:unreferenced}}))}))});
 config.workflows=[{id:'off-shared-generate',name:'Generate shared routed document',module:'off',status:'published',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'generate',type:'doc',template:'off-shared-letter',release:false},{id:'wait',type:'waitSign',template:'off-shared-letter',by:'hr'}],description:''}];
 await v9SaveConfig(admin,config.revision,config);
 const caseId=await v9CreateOffboarding(admin,{employmentId,type:'Termination',noticeDate:'2026-11-01',lastDay:'2026-12-01'});await v9Command(admin,caseId,1,{type:'submit'});
 const c=(await v9Workspace(admin)).cases.find(c=>c.id===caseId)!,doc=c.documents.find(doc=>doc.templateId==='off-shared-letter')!;expect(doc.signing?.route.steps).toMatchObject([{id:'shared-sign',holderId:admin.userId,holderPersonId:admin.personId}]);
 const [projected]=await withTenant(admin,tx=>tx.execute<{routings:{id:string;revision:number;rows:unknown[]}[]}>(sql`select app.v9_offboarding_document_routings(${caseId}::uuid,${c.revision},ARRAY['off-shared-letter']) routings`));expect(projected.routings.map(r=>[r.id,r.revision])).toEqual([[routingId,1]]);expect(projected.routings[0].rows).toEqual([definition.rows[1]]);expect(JSON.stringify(projected.routings)).not.toContain(other.userId!);
 const [unrelated]=await withTenant(admin,tx=>tx.execute<{routings:unknown[]}>(sql`select app.v9_offboarding_document_routings(${caseId}::uuid,${c.revision},ARRAY['off-other-company']) routings`));expect(unrelated.routings).toEqual([]);
 await expect(withTenant(admin,tx=>tx.execute(sql`select app.v9_offboarding_document_routings(${caseId}::uuid,${c.revision},array_fill('off-shared-letter'::text,ARRAY[201]))`))).rejects.toMatchObject({cause:{code:'22023'}});
 await expect(withTenant(admin,tx=>tx.execute(sql`select app.v9_document_shared_routing_row('[]'::jsonb,'{}'::jsonb)`))).rejects.toMatchObject({cause:{code:'42501'}});
 expect(await owner.client`select 1 from lc_onboarding_config cfg cross join lateral jsonb_array_elements(coalesce(cfg.data->'routings','[]'::jsonb)) r where cfg.tenant_id=${base.tenantId}::uuid and r->>'id'=${routingId}`).toHaveLength(0);
 await expect(withTenant(employee,tx=>tx.execute(sql`select app.v9_offboarding_document_routings(${caseId}::uuid,${c.revision},ARRAY['off-shared-letter'])`))).rejects.toMatchObject({cause:{code:'42501'}});
 await expect(withTenant(admin,tx=>tx.execute(sql`select app.v9_offboarding_document_routings(${caseId}::uuid,${c.revision+1},ARRAY['off-shared-letter'])`))).rejects.toMatchObject({cause:{code:'40001'}});
 await expect(withTenant({...admin,tenantId:randomUUID()},tx=>tx.execute(sql`select app.v9_offboarding_document_routings(${caseId}::uuid,${c.revision},ARRAY['off-shared-letter'])`))).rejects.toMatchObject({cause:{code:'42501'}});
 await saveAutomationRouting(admin,{routing:{...definition,rows:[{match:{company:[base.companyId]},assignTo:{kind:'people',userIds:[other.userId!]}}]},retired:false,expectedRevision:1,reason:'Later routing revision must not rewrite a generated document'});
 const frozen=await v9ReadDocumentSigningWork(admin,caseId,doc.id);expect(frozen.signing.route.steps[0].holderId).toBe(admin.userId);await expect(v9ReadDocumentSigningWork(other,caseId,doc.id)).rejects.toThrow();
 const signed=await v9DocumentRouteAct(admin,{caseId,caseRevision:frozen.caseRevision,documentId:doc.id,stepId:'shared-sign',action:'signed',contentRevision:frozen.signing.contentRevision,contentHash:frozen.signing.contentHash,signature:{method:'typed',value:'Fictional shared-route HR',consent:true}});expect(signed.signing.actions[0].actorId).toBe(admin.userId);
 await setModule(base.tenantId,'lifecycle','disabled');await expect(withTenant(admin,tx=>tx.execute(sql`select app.v9_offboarding_document_routings(${caseId}::uuid,${signed.caseRevision},ARRAY['off-shared-letter'])`))).rejects.toMatchObject({cause:{code:'42501'}});
});
it('returns every case-selected winner for 210 distinct references across seven valid 30-step templates',async()=>{
 const definitions=Array.from({length:210},(_,n)=>({id:randomUUID(),name:'Fictional bounded routing '+n,rows:[{match:{company:[base.companyId]},assignTo:{kind:'people',userIds:[admin.userId!]}}]}));
 // A set-wise retained configuration fixture isolates source completeness from builder mutation permissions.
 await owner.db.execute(sql`insert into automation_routing_version(tenant_id,routing_id,revision,name,routing_rows,retired,reason,saved_by) select ${base.tenantId}::uuid,id::uuid,1,name,rows,false,'Fictional bounded configured source',${admin.userId!}::uuid from jsonb_to_recordset(${JSON.stringify(definitions)}::jsonb) r(id text,name text,rows jsonb)`);
 const config=(await v9Workspace(admin)).config!;config.emails=[];config.workflows=[];config.checklists=[];
 config.templates=Array.from({length:7},(_,n)=>({id:'bounded-off-'+n,name:'Fictional bounded template '+n,module:'off' as const,type:'Letter' as const,rules:{company:[base.companyId]},hrStep:'none' as const,employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published' as const,at:'',by:'Fictional fixture author',fields:[],blocks:Array.from({length:30},(_,j)=>({id:'signature-'+j,type:'signature' as const,text:'',section:'',role:'step:sign-'+j})),routing:Array.from({length:30},(_,j)=>({id:'sign-'+j,order:j+1,action:'sign' as const,owner:j===0,required:true,who:{kind:'routing' as const,routingId:definitions[n*30+j].id}}))}]}));
 config.revision++;await owner.db.execute(sql`update lc_v9_config set data=${JSON.stringify(config)}::jsonb,revision=${config.revision} where tenant_id=${base.tenantId}::uuid`);
 const caseId=await v9CreateOffboarding(admin,{employmentId,type:'Termination',noticeDate:'2026-11-01',lastDay:'2026-12-01'});
 const [projection]=await withTenant(admin,tx=>tx.execute<{routings:{id:string;revision:number;rows:unknown[]}[]}>(sql`select app.v9_offboarding_document_routings(${caseId}::uuid,1,array(select jsonb_array_elements_text(${JSON.stringify(config.templates.map(template=>template.id))}::jsonb))) routings`));
 expect(projection.routings).toHaveLength(210);expect(projection.routings.map(route=>route.id)).toEqual(definitions.map(route=>route.id).sort());expect(projection.routings.every(route=>route.revision===1&&route.rows.length===1)).toBe(true);
});
