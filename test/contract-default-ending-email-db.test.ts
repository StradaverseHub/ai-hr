/** Real seed definitions, generated/released BP-only letter and employee email disclosure; no substitute letter. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {closeAll,migrateTestDb,owner,createAppUser} from './harness';
import {fixture,submit,letters} from './helpers/contract-document-fixture';
import {contractStartingConfiguration,contractDefaultId} from '../lib/contract-starting-configuration';
import {saveAutomationRouting,saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../packs/automation/service';
import {readContractSharedLetter,actContractSharedLetter,renderContractSharedLetter,contractAutomationJobHandler} from '../packs/contracts/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {v9PdfDocument} from '../lib/lifecycle-v9-pdf';
beforeAll(migrateTestDb);afterAll(closeAll);
it('emails the one actual seeded released End letter to its employee and renders the frozen Shared letterhead',async()=>{
 const f=await fixture('end'),userId=await createAppUser(f.b.tenantId,f.employee.personId,'employee'),employee:SessionContext={...f.admin,userId,personId:f.employee.personId,roles:['employee'],grants:undefined};
 for(const user of [userId,f.admin.userId!])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${'https://default-letter-mail.example.test/auth/'+f.b.tenantId},${f.b.tenantId+'/'+user},${user}::uuid)`);
 await owner.db.execute(sql`update company set legal_name='Fictional Shared letterhead company',registration_no='FICT-SHARED-321',address_line1='123 Fictional Shared Street',address_line2=null,address_line3=null,postcode='12345',city='Fictional City',state=null,address_country='MY' where tenant_id=${f.b.tenantId}::uuid and id=${f.b.companyId}::uuid`);
 const bpRoutingId=randomUUID(),ceoRoutingId=randomUUID();for(const[id,name]of[[bpRoutingId,'Actual BP route'],[ceoRoutingId,'Actual CEO route']])await saveAutomationRouting(f.admin,{routing:{id,name,rows:[{match:{},assignTo:{kind:'group',groupId:f.groupId}}]},expectedRevision:0,retired:false,reason:'Actual seeded ending route'});
 const defaults=contractStartingConfiguration({companyId:f.b.companyId,fallbackGroupId:f.groupId,postingApproverGroupId:f.groupId,bpRoutingId,ceoRoutingId}),document=defaults.documents.find(d=>d.id===contractDefaultId(3))!,email=defaults.emails.find(e=>e.id===contractDefaultId(103))!,ending=defaults.workflows.find(w=>w.name==='End decision')!;
 await saveAutomationDocumentTemplate(f.admin,{template:document,expectedRevision:0,publish:true,retired:false});await saveAutomationEmailTemplate(f.admin,{template:email,expectedRevision:0,retired:false,reason:'Actual seeded End email'});
 // This proof stops after the actual email; native Offboarding behavior has its own separate fixtures.
 await saveAutomationWorkflow(f.admin,{workflow:{...ending,id:f.workflow.id,steps:ending.steps.filter(s=>s.type!=='startOffboarding')},expectedRevision:1,reason:'Actual seeded End letter and email path'});
 await submit(f,'end');const[letter]=await letters(f);expect(await letters(f)).toHaveLength(1);
 expect((await readContractSharedLetter(f.admin,letter.id)).body!.definition.blocks[0].type).toBe('letterhead');
 const act=async(action:'reviewed'|'signed')=>{const current=await readContractSharedLetter(f.admin,letter.id);return actContractSharedLetter(f.admin,{id:letter.id,actionId:randomUUID(),stepId:current.pendingAction!.stepId,revision:current.contentRevision,hash:current.contentHash!,action,...(action==='signed'?{method:'typed' as const,value:'Fictional verified BP',consent:true}:{})});};
 await act('reviewed');await act('signed');
 for(let n=0;n<40;n++){const[active]=await owner.db.execute<{count:number}>(sql`select count(*)::int count from bulk_job where tenant_id=${f.b.tenantId}::uuid and kind='contract_automation' and state in('queued','preparing','running','finalizing')`);if(!active.count)break;await runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler]});}
 expect(await owner.db.execute(sql`select id,error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state='failed'`)).toEqual([]);expect(await letters(f)).toHaveLength(1);
 const[pin]=await owner.db.execute<{documents:Record<string,string>}>(sql`select documents from contract_shared_email_document_step where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and email_template_id=${email.id}::uuid`);expect(pin.documents).toEqual({[document.id]:letter.id});
 const deliveries=await owner.db.execute<{documents:{id:string}[];recipients:string[]}>(sql`select payload->'mail'->'delivery'->'documents' documents,ARRAY(select jsonb_array_elements_text((payload->'mail'->'to')||(payload->'mail'->'cc'))) recipients from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${email.id}`);expect(deliveries.length).toBeGreaterThan(0);expect(deliveries.some(d=>d.recipients.includes(userId))).toBe(true);expect(deliveries.every(d=>d.documents.length===1&&d.documents[0].id===letter.id)).toBe(true);
 const released=await readContractSharedLetter(employee,letter.id);expect(released.state).toBe('released');expect(released.body).not.toBeNull();const rendered=renderContractSharedLetter(released)!;
 await owner.db.execute(sql`update company set legal_name='Later edited company',registration_no='LATER-999',address_line1='Later edited address' where id=${f.b.companyId}::uuid`);
 const output=JSON.stringify(v9PdfDocument(rendered));expect(output).toContain('Fictional Shared letterhead company');expect(output).toContain('FICT-SHARED-321');expect(output).toContain('123 Fictional Shared Street');expect(output).not.toContain('Later edited');
 expect(await owner.db.execute(sql`select id from personnel_posting where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
},120000);
