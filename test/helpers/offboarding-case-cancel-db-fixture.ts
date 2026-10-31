/** Authored real-DB fixture builder; invoked only after approved mounting/hosted test dispatch. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import * as s from '../../db/schema';
import type {SessionContext} from '../../db/client';
import {grantAssistant} from '../../core/assistant-grant';
import {hireEmployee} from '../../core/org';
import {createOffboardingCase,setOutcome,tickStep,addComment,registerAsset} from '../../packs/lifecycle/service';
import {adminCtx,createAppUser,harnessSnapshot,owner,resetDb,seedBase,setModule} from '../harness';
export async function caseCancelFixture(linked=false){
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'lifecycle','active');
 const userId=await createAppUser(b.tenantId,null,'employee');await owner.db.insert(s.lcStaff).values({tenantId:b.tenantId,userId,companyId:b.companyId,level:'manager'});await grantAssistant(adminCtx(b),{appUserId:userId});
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:harnessSnapshot(b.tenantId)};
 const subject=linked?await hireEmployee(adminCtx(b),{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-09-01',person:{fullName:'Fictional linked leaver',primaryEmail:randomUUID()+'@fixture.invalid'}}):null;
 const c=await createOffboardingCase(adminCtx(b),{companyId:b.companyId,fullName:'Fictional cancellation fixture',employeeNo:'CX-'+randomUUID().slice(0,8),resignationDate:'2026-10-01',lastWorkingDay:'2026-10-31',...(subject?{personId:subject.personId,employmentId:subject.employmentId}:{})});
 await setOutcome(ctx,c.number,'accepted');await tickStep(ctx,'offboarding',c.number,'resign_submit',{reference:'Retained reference',notes:'Retained step notes'});await addComment(ctx,'offboarding',c.number,'Retained case comment');
 const [q]=await owner.db.select().from(s.itRequisition).where(eq(s.itRequisition.caseId,c.id));if(!q)throw Error('nonempty native IT return fixture required');
 const items=await owner.db.select().from(s.itRequisitionItem).where(eq(s.itRequisitionItem.requisitionId,q.id));if(!items.length)throw Error('nonempty native IT item fixture required');
 const asset=await registerAsset(ctx,{companyId:b.companyId,assetType:'laptop',model:'Fictional linked hardware'});
 // A real registered asset with an existing legal FK link; no native cancellation result is forged.
 await owner.db.update(s.itAsset).set({requisitionId:q.id}).where(eq(s.itAsset.id,asset.id));
 return {b,ctx,caseId:c.id,number:c.number,reqId:q.id,itemKey:items[0].itemKey,assetId:asset.id,subject,human:{caseId:c.id,caseNumber:c.number,reason:'Opened in error',confirmCaseCancellation:true as const}};
}
export type CaseCancelFixture=Awaited<ReturnType<typeof caseCancelFixture>>;
export async function caseCancelSnapshot(f:CaseCancelFixture){
 const [c]=await owner.db.select().from(s.lcCase).where(eq(s.lcCase.id,f.caseId));
 const children=await owner.db.execute(sql`select
 (select jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) order by step_key) from lc_case_step a where case_id=${f.caseId}::uuid) steps,
 (select jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) order by id) from lc_comment a where case_id=${f.caseId}::uuid) comments,
 (select jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) order by id) from it_requisition a where case_id=${f.caseId}::uuid) requisitions,
 (select jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) order by a.requisition_id,a.item_key) from it_requisition_item a join it_requisition q on q.id=a.requisition_id where q.case_id=${f.caseId}::uuid) items,
 (select jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) order by a.id) from it_asset a join it_requisition q on q.id=a.requisition_id where q.case_id=${f.caseId}::uuid) assets`);
 return {c,related:children[0]};
}
