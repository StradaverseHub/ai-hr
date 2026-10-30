/** Real native unused-company deletion compatibility; fictional data, hosted only after review. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {positionArchiveReviews} from '../core/assistant-actions/position-archive-review-store';
import {departmentArchiveReviews} from '../core/assistant-actions/department-archive-review-store';
import {employeeIdTemplateStatusReviews} from '../core/assistant-actions/employee-id-template-status-review-store';
import {createConfig} from '../core/employee-id-config';
import {bulkSaveLabels,createCompany,deleteCompany} from '../core/admin';
import {grantAssistant} from '../core/assistant-grant';
import {adminCtx,owner,resetDb,seedBase,setModule,closeAll,type Base} from './harness';
let b:Base,ctx:SessionContext;type Kind='position'|'department'|'template';
const kinds=['position','department','template'] as const;
async function setup(kind:Kind){const company=(await createCompany(ctx,{legalName:'Fictional Unused Retention '+randomUUID(),country:'MY',currency:'MYR'})).id;
 if(kind==='template'){const configId=(await createConfig(ctx,{companyId:company,prefix:'FIC'+randomUUID().slice(0,6),numberLength:4})).id;return{company,store:employeeIdTemplateStatusReviews,human:{action:'org.employee_id_template.status',contractVersion:1,configId,expectedStatus:'active',status:'inactive'}};}
 const made=await bulkSaveLabels(ctx,kind,{updates:[],creates:[kind==='position'?{key:'fixture',companyId:company,title:'Fictional unused position'}:{key:'fixture',companyId:company,name:'Fictional unused department'}]});expect(made.createdIds).toHaveLength(1);const id=made.createdIds[0].id;return kind==='position'?{company,store:positionArchiveReviews,human:{action:'org.position.archive',contractVersion:1,positionId:id,expectedArchived:false,archived:true}}:{company,store:departmentArchiveReviews,human:{action:'org.department.archive',contractVersion:1,departmentId:id,expectedArchived:false,archived:true}};
}
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-catalogue-retention-key');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');ctx={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(ctx,{appUserId:b.adminUserId});});afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
describe.each(kinds)('retained company audit: %s',kind=>{for(const end of ['discard','expire'] as const)it(`keeps the existing native delete refusal after preparing and ${end}, compared with an actually deletable no-review control`,async()=>{
 const control=await setup(kind);await deleteCompany(ctx,{id:control.company});const [gone]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from public.company where id=${control.company}::uuid`);expect(gone.n).toBe(0);
 const target=await setup(kind),r=(await target.store.prepare(ctx,target.human)).review;
 if(end==='discard')await target.store.discard(ctx,{action:target.human.action,contractVersion:1,actionId:r.actionId});else{await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '10 minutes' where id=${r.actionId}::uuid`);expect((await target.store.reopen(ctx,r.actionId)).kind).toBe('retired');}
 const [audit]=await owner.db.execute<{state:string;company:string;employment:string|null;bodies:number}>(sql`select state,company_id as company,employment_id as employment,(select count(*)::int from app.assistant_own_leave_review_content where action_id=r.id) as bodies from app.assistant_own_leave_review r where id=${r.actionId}::uuid`);expect(audit).toEqual({state:end==='discard'?'discarded':'expired',company:target.company,employment:null,bodies:0});
 const retained=await withTenant(ctx,async tx=>{const [r]=await tx.execute<{retained:boolean}>(sql`select app.ai_assistance_company_in_use(${target.company}::uuid) retained`);return r.retained;});expect(retained).toBe(true);
 await expect(deleteCompany(ctx,{id:target.company})).rejects.toMatchObject({reason:'other'});const [stays]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from public.company where id=${target.company}::uuid`);expect(stays.n).toBe(1);
});});
