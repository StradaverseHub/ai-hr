/** Fictional data and observed state only; assertions stay in the three hosted test suites. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,vi} from 'vitest';
import type {SessionContext} from '../../db/client';
import * as schema from '../../db/schema';
import {hireEmployee,setReportingLine} from '../../core/org';
import {createCycle,openCycle,createGoal,proposeGoals,scheduleCheckIn} from '../../packs/performance/service';
import {grantAssistant} from '../../core/assistant-grant';
import {goalApprovalReviews} from '../../core/assistant-actions/goal-approval-review-store';
import {checkInCancellationReviews} from '../../core/assistant-actions/checkin-cancellation-review-store';
import {checkInCompletionReviews} from '../../core/assistant-actions/checkin-completion-review-store';
import {GoalApproval as G} from '../../lib/assistant-actions/goal-approval-contract';
import {CheckInCancellation as X} from '../../lib/assistant-actions/checkin-cancellation-contract';
import {CheckInCompletion as C} from '../../lib/assistant-actions/checkin-completion-contract';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from '../harness';
export let b:Base;
type Kind='goal'|'cancel'|'preserve'|'replace';
export const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
export const hire=(name:string,departmentId=b.deptA)=>hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId,employmentType:'full_time',hiredOn:'2026-01-01'});
async function login(personId:string,role:'employee'|'manager'):Promise<SessionContext>{const userId=await createAppUser(b.tenantId,personId,role);await grantAssistant(group(),{appUserId:userId});return{...await entitledCtx(b,[role]),userId,personId,grants:[{role,companyId:null}]};}
export type Packet={actionId:string;reviewedDigest:string};
export async function fixture(kind:Kind){
 const manager=await hire('Fictional Proof Manager'),employee=await hire('Fictional Proof Employee'),ctx=await login(manager.personId,'manager'),self=await login(employee.personId,'employee');
 await setReportingLine(group(),{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 let id:string;
 if(kind==='goal'){
  const {cycleId}=await createCycle(group(),{name:'Fictional proof cycle',periodStart:'2026-01-01',periodEnd:'2026-12-31'});await openCycle(group(),{cycleId});
  ({id}=await createGoal(self,{employmentId:employee.employmentId,cycleId,title:'Reviewed title',description:'Private description',target:'Reviewed target'}));
  const [review]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,employee.employmentId)));await proposeGoals(self,{reviewId:review.id});
 }else ({id}=await scheduleCheckIn(ctx,{subjectEmploymentId:employee.employmentId,scheduledOn:'2026-12-15',notes:'Private original notes'}));
 const human={contractVersion:1,subjectId:id,employmentId:employee.employmentId};
 const g=G.Human.parse({...human,action:G.action,approve:true}),x=X.Human.parse({...human,action:X.action,cancel:true}),c=C.Human.parse({...human,action:C.action,complete:true,notesMode:kind==='replace'?'replace':'preserve',...(kind==='replace'?{notes:'\u00a0\uFEFF Human Unicode note \u2003\n'}:{})});
 const prepare=()=>kind==='goal'?goalApprovalReviews.prepare(ctx,g):kind==='cancel'?checkInCancellationReviews.prepare(ctx,x):checkInCompletionReviews.prepare(ctx,c);
 const confirm=(r:Packet)=>kind==='goal'?goalApprovalReviews.confirm(ctx,r):kind==='cancel'?checkInCancellationReviews.confirm(ctx,r):checkInCompletionReviews.confirm(ctx,r);
 const reopen=(actionId:string)=>kind==='goal'?goalApprovalReviews.reopen(ctx,actionId):kind==='cancel'?checkInCancellationReviews.reopen(ctx,actionId):checkInCompletionReviews.reopen(ctx,actionId);
 return{kind,id,ctx,self,manager,employee,prepare,confirm,reopen,action:kind==='goal'?G.action:kind==='cancel'?X.action:C.action};
}
export async function state(a:Awaited<ReturnType<typeof fixture>>){const row=a.kind==='goal'?(await owner.db.select().from(schema.performanceGoal).where(eq(schema.performanceGoal.id,a.id)))[0]:(await owner.db.select().from(schema.performanceCheckin).where(eq(schema.performanceCheckin.id,a.id)))[0];return{row,events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,a.id)).orderBy(schema.domainEvent.sequence)};}
export async function proof(actionId:string){const [r]=await owner.db.execute<{version:number|null;unchanged:string|null;notes:string|null;mode:string|null;event:string|null;root:string|null;state:string;bodies:number}>(sql`select performance_postimage_version as version,performance_postimage_unchanged as unchanged,performance_postimage_notes as notes,performance_postimage_mode as mode,performance_postimage_event_id as event,performance_postimage_root_xid::text as root,state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where id=${actionId}::uuid`);return r;}

export function installPerformancePostimageFixtures(){
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-postimage-proof-key-123456');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'performance','active');});

}
