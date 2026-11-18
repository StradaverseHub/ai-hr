import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {submitFeedback,getFeedback,approveFeedbackPlan} from '../core/feedback';
import {answerFeedbackClarification} from '../core/feedback-clarification';
import {pickupSql,completeSql,notifySql,type Completion} from '../scripts/improve/automation';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,reporter:SessionContext,other:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin=adminCtx(b);
 const login=async():Promise<SessionContext>=>{const[u]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning();
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role:'employee',companyId:null});
 return {...admin,userId:u.id,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};};
 reporter=await login();other=await login();
});
async function script(statement:string){const c=await owner.client.reserve();try{return await c.unsafe(statement).simple();}catch(e){await c.unsafe('ROLLBACK').simple();throw e;}finally{c.release();}}
const report=()=>submitFeedback(reporter,{category:'issue',title:'Payroll preview',description:'The preview shows the wrong November date.',expectedBehavior:'Show the selected date.'});
async function pickup(tenantId=b.tenantId){await script(pickupSql({tenantId,worker:'fixture'}));return owner.client<{feedback_request_id:string;claim_token:string;source_digest:string}[]>`select * from feedback_automation_work where tenant_id=${tenantId} and state='claimed' order by updated_at`;}
async function completion(action:Completion['action']='ask'){
 const [w]=await pickup();const detail=(await getFeedback(reporter,w.feedback_request_id))!;
 const common={id:w.feedback_request_id,tenantId:b.tenantId,reporterEmploymentId:null,claimToken:w.claim_token,sourceDigest:w.source_digest,expectedPlanRevision:detail.planRevision,dialogueDigest:detail.dialogueDigest};
 return action==='ask'?{...common,action,question:'Which preview screen did you open?'} as const:action==='plan'?{...common,action,plan:'Fix the selected date and show independent verification.',model:'fixture',visualChange:false} as const:action==='hold'?{...common,action,reason:'Needs a scope decision.'} as const:{...common,action:'retry'} as const;
}
describe('durable operator feedback coordinator',()=>{
 it('claims only the explicit tenant and cannot double-pick a live lease',async()=>{
  await report();const foreign=await seedBase();expect(await pickup(foreign.tenantId)).toHaveLength(0);
  const first=await pickup();expect(first).toHaveLength(1);await pickup();expect((await pickup())[0].claim_token).toBe(first[0].claim_token);
  await expect(withTenant(admin,tx=>tx.execute(sql.raw('select * from feedback_automation_work')))).rejects.toThrow();
 });
 it('commits one question, preserves its identity on retry, waits for reply, then picks the answer as new source',async()=>{
  const {id}=await report(),p=await completion();await script(completeSql(p));await script(completeSql(p));
  expect((await getFeedback(reporter,id))?.blockHistory).toHaveLength(1);expect(await pickup()).toHaveLength(0);
  await expect(script(completeSql({...p,question:'A different retry question.'}))).rejects.toThrow(/different result/);
  await answerFeedbackClarification(reporter,{feedbackId:id,questionId:p.claimToken,answer:'November payroll preview.'});
  const next=await completion('plan');expect(next.sourceDigest).not.toBe(p.sourceDigest);await script(completeSql(next));await script(completeSql(next));
  expect((await getFeedback(reporter,id))?.planRevision).toBe(1);expect((await getFeedback(reporter,id))?.status).toBe('planned');
  await approveFeedbackPlan(reporter,{feedbackId:id});expect((await getFeedback(reporter,id))?.status).toBe('approved');
 });
 it('fences expired and replaced tokens and refuses a changed description or attachment',async()=>{
  const {id}=await report(),p=await completion();await owner.db.update(s.feedbackRequest).set({description:'Changed after claim.'}).where(eq(s.feedbackRequest.id,id));
  await expect(script(completeSql(p))).rejects.toThrow(/source changed/);
  await owner.client`update feedback_automation_work set lease_until=now()-interval '1 second' where feedback_request_id=${id}`;
  const next=await completion();expect(next.claimToken).not.toBe(p.claimToken);await expect(script(completeSql(p))).rejects.toThrow(/claim changed/);
  await owner.db.insert(s.feedbackAttachment).values({tenantId:b.tenantId,feedbackRequestId:id,content:Buffer.from('new fixture'),fileName:'fixture.txt',mimeType:'text/plain',sizeBytes:11,uploadedByUserId:reporter.userId,stage:'submitted'});
  await expect(script(completeSql(next))).rejects.toThrow(/source changed/);
 });
 it('suspends an unchanged hold, caps retries, and permits a genuinely changed report',async()=>{
  const {id}=await report(),p=await completion('hold');await script(completeSql(p));expect(await pickup()).toHaveLength(0);
  await owner.db.update(s.feedbackRequest).set({description:'Reporter supplied the missing scope.'}).where(eq(s.feedbackRequest.id,id));
  for(let n=0;n<3;n++){const retry=await completion('retry');await script(completeSql(retry));await owner.client`update feedback_automation_work set retry_at=now()-interval '1 second' where feedback_request_id=${id}`;}
  expect(await pickup()).toHaveLength(0);
 });
 it('creates private account-bell notices once, including a user-only reporter, and suppresses follow-up after an answer',async()=>{
  const {id}=await report(),p=await completion();await script(completeSql(p));await script(notifySql(b.tenantId));await script(notifySql(b.tenantId));
  let notices=await owner.db.select().from(s.notification);expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({recipientUserId:reporter.userId,recipientEmploymentId:null,kind:'feedback.question',linkPath:'/feedback/'+id});
  const visible=await withTenant(reporter,tx=>tx.select().from(s.notification));expect(visible).toHaveLength(1);
  expect(await withTenant(other,tx=>tx.select().from(s.notification))).toHaveLength(0);
  await answerFeedbackClarification(reporter,{feedbackId:id,questionId:p.claimToken,answer:'Preview in November.'});
  await script(notifySql(b.tenantId));notices=await owner.db.select().from(s.notification);expect(notices).toHaveLength(1);
  await expect(withTenant(reporter,tx=>tx.update(s.notification).set({body:'Rewritten'}).where(eq(s.notification.id,notices[0].id)))).rejects.toThrow();
  await withTenant(reporter,tx=>tx.update(s.notification).set({readAt:new Date()}).where(eq(s.notification.id,notices[0].id)));
 });
 it('sends one reminder after 48h and never auto-closes or rejects a silent report',async()=>{
  const{id}=await report(),questionId=randomUUID();
  // Create an old episode directly as storage owner; the immutable episode trigger forbids changing asked_at later.
  await owner.db.insert(s.feedbackBlock).values({id:questionId,tenantId:b.tenantId,feedbackRequestId:id,question:'Which screen?',askedAt:new Date(Date.now()-49*3600000)});
  await owner.db.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'feedback',aggregateId:id,eventType:'feedback.clarification.requested',actorType:'agent',payload:{questionId,planRevision:0}});
  await script(notifySql(b.tenantId));await script(notifySql(b.tenantId));
  expect((await owner.db.select().from(s.notification)).map(n=>n.kind).sort()).toEqual(['feedback.question','feedback.reminder']);
  expect((await getFeedback(reporter,id))?.status).toBe('open');expect(await pickup()).toHaveLength(0);
 });
 it('notifies only a currently reviewable plan and does not notify a cancelled report',async()=>{
  const{id}=await report(),p=await completion('plan');await script(completeSql(p));await script(notifySql(b.tenantId));await script(notifySql(b.tenantId));
  expect((await owner.db.select().from(s.notification)).map(n=>n.kind)).toEqual(['feedback.plan']);
  await owner.db.update(s.feedbackRequest).set({status:'cancelled'}).where(eq(s.feedbackRequest.id,id));await script(notifySql(b.tenantId));
  expect(await pickup()).toHaveLength(0);expect(await owner.db.select().from(s.notification)).toHaveLength(1);
 });
 it('refuses forged recipients and does not let two workers commit different results',async()=>{
  const{id}=await report(),p=await completion('plan');await Promise.all([script(completeSql(p)),script(completeSql(p))]);
  expect((await getFeedback(reporter,id))?.planRevision).toBe(1);await script(notifySql(b.tenantId));
  const[n]=await owner.db.select().from(s.notification);
  await expect(owner.db.insert(s.notification).values({...n,id:randomUUID(),recipientUserId:other.userId})).rejects.toThrow();
 });
 it('treats dollar delimiters, quotes and backslashes as text at both SQL boundaries',async()=>{
  const {id}=await report();
  await script(pickupSql({tenantId:b.tenantId,worker:"fixture $pickup$ O'Reilly \\ literal"}));
  const [w]=await owner.client`select * from feedback_automation_work where feedback_request_id=${id}`;
  const question="Which screen? $complete$ $completex$ O'Reilly \\ path; not a command.";
  await script(completeSql({tenantId:b.tenantId,id,claimToken:w.claim_token,sourceDigest:w.source_digest,reporterEmploymentId:null,expectedPlanRevision:0,action:'ask',question}));
  expect((await getFeedback(reporter,id))?.blockHistory[0].question).toBe(question);
 });
 it('requires a design for an interface plan and commits images on the same revision',async()=>{
  const {id}=await report(),p=await completion('plan');
  if(p.action!=='plan')throw Error('Fixture plan required.');
  expect(()=>completeSql({...p,visualChange:true})).toThrow(/rendered mockups/);
  const mockup={fileName:'review.png',mimeType:'image/png',content:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB+0AAAAASUVORK5CYII=','base64')};
  const input={...p,visualChange:true,mockups:[mockup]};
  await script(completeSql(input));await script(completeSql(input));
  expect((await getFeedback(reporter,id))?.planRevision).toBe(1);
  const attachments=await owner.db.select().from(s.feedbackAttachment).where(eq(s.feedbackAttachment.feedbackRequestId,id));
  expect(attachments).toHaveLength(1);expect(attachments[0]).toMatchObject({stage:'plan',planRevision:1,fileName:'review.png'});
 });
});
