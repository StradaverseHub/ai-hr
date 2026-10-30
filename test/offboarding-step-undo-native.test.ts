/** Independent native-Tx seam checks only; no executable Assistant undo action is claimed yet. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import * as s from '../db/schema';
import {withLifecycleTenant} from '../core/module-gate';
import {createOffboardingCase,tickStep,setOutcome,getCase,undoStep,undoStepTx,prepareOffboardingStepUndoTx,cancelCase} from '../packs/lifecycle/service';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {SessionContext} from '../db/client';
let b:Base,manager:SessionContext,agent:SessionContext,caseId:string,number:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');const root=await entitledCtx(b);const managerId=await createAppUser(b.tenantId,null,'employee'),agentId=await createAppUser(b.tenantId,null,'employee');await owner.db.insert(s.lcStaff).values([{tenantId:b.tenantId,userId:managerId,companyId:b.companyId,level:'manager'},{tenantId:b.tenantId,userId:agentId,companyId:b.companyId,level:'agent'}]);manager={...root,userId:managerId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};agent={...manager,userId:agentId};const c=await createOffboardingCase(adminCtx(b),{companyId:b.companyId,fullName:'Fictional undo leaver',employeeNo:'U-'+randomUUID().slice(0,8),resignationDate:'2026-10-01'});caseId=c.id;number=c.number;await tickStep(manager,'offboarding',number,'resign_submit',{reference:'retained reference',notes:'retained notes'});});
it('allows a real unlinked native lifecycle manager and preserves references/notes with exact undo event',async()=>{
 const before=await withLifecycleTenant(manager,tx=>prepareOffboardingStepUndoTx(tx,manager,caseId,number,'resign_submit',null));expect(before).toMatchObject({reopensCase:false,reason:null,before:{done:true,reference:'retained reference',notes:'retained notes'},after:{done:false,reference:'retained reference',notes:'retained notes'}});
 const result=await withLifecycleTenant(manager,tx=>undoStepTx(tx,manager,'offboarding',number,'resign_submit',null));expect(result).toMatchObject({caseId,stepKey:'resign_submit',status:'in_progress',caseEventId:null});
 const [event]=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,result.stepEventId));expect(event).toMatchObject({aggregateId:caseId,eventType:'lifecycle-case.step-undone',actorType:'user',actorId:manager.userId,subjectEmploymentId:null,payload:{action:'step.undone',number,step:'resign_submit'}});
 const [step]=await owner.db.select().from(s.lcCaseStep).where(and(eq(s.lcCaseStep.caseId,caseId),eq(s.lcCaseStep.stepKey,'resign_submit')));expect(step).toMatchObject({done:false,doneBy:null,doneAt:null,reference:'retained reference',notes:'retained notes'});
 const [hash]=await owner.db.execute<{hash:string}>(sql`select encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') hash from lc_case_step a where a.case_id=${caseId}::uuid and a.step_key='resign_submit'`);expect(event.payload).toMatchObject({stepRowHash:hash.hash});
});
it('refuses lifecycle agents, repeated undo and cancelled cases without broadening native authority',async()=>{
 await expect(undoStep(agent,'offboarding',number,'resign_submit')).rejects.toThrow();await undoStep(manager,'offboarding',number,'resign_submit');await expect(undoStep(manager,'offboarding',number,'resign_submit')).rejects.toThrow();await tickStep(manager,'offboarding',number,'resign_submit');await cancelCase(manager,'offboarding',number,'Fictional cancellation');await expect(undoStep(manager,'offboarding',number,'resign_submit')).rejects.toThrow();
});
it('returns exact distinct native undo and derived reopening events for a completed case',async()=>{
 await setOutcome(manager,number,'accepted');const view=await getCase(manager,'offboarding',number);for(const step of view.steps.filter(step=>step.applicability==='applicable'&&!step.done))await tickStep(manager,'offboarding',number,step.key);expect((await getCase(manager,'offboarding',number)).case.status).toBe('completed');
 const projected=await withLifecycleTenant(manager,tx=>prepareOffboardingStepUndoTx(tx,manager,caseId,number,'resign_submit','Correction'));expect(projected.reopensCase).toBe(true);
 const result=await withLifecycleTenant(manager,tx=>undoStepTx(tx,manager,'offboarding',number,'resign_submit','Correction'));expect(result.status).toBe('in_progress');expect(result.caseEventId).not.toBeNull();expect(result.caseEventId).not.toBe(result.stepEventId);
 const [event]=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,result.caseEventId!));expect(event).toMatchObject({aggregateId:caseId,eventType:'lifecycle-case.reopened',actorType:'user',actorId:manager.userId});expect((await getCase(manager,'offboarding',number)).case.completedAt).toBeNull();
});
it('rolls back step, derived case reopening, history and both events on enclosing refusal',async()=>{
 await setOutcome(manager,number,'accepted');const view=await getCase(manager,'offboarding',number);for(const step of view.steps.filter(step=>step.applicability==='applicable'&&!step.done))await tickStep(manager,'offboarding',number,step.key);
 const prior=(await getCase(manager,'offboarding',number)).case;let eventId:string|undefined,caseEventId:string|null=null;
 await expect(withLifecycleTenant(manager,async tx=>{const result=await undoStepTx(tx,manager,'offboarding',number,'resign_submit');eventId=result.stepEventId;caseEventId=result.caseEventId;throw Error('outer refusal');})).rejects.toThrow('outer refusal');
 expect(caseEventId).not.toBeNull();for(const id of [eventId!,caseEventId!])expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,id))).toHaveLength(0);
 const after=await getCase(manager,'offboarding',number);expect(after.steps.find(step=>step.key==='resign_submit')?.done).toBe(true);expect(after.case.status).toBe('completed');expect(after.case.completedAt).toEqual(prior.completedAt);
 expect(await owner.db.select().from(s.lcHistory).where(and(eq(s.lcHistory.refId,caseId),eq(s.lcHistory.action,'step.undone')))).toHaveLength(0);
});

it('keeps outcome, inactive and not-applicable historical variants outside the bounded review',async()=>{
 await setOutcome(manager,number,'accepted');await expect(withLifecycleTenant(manager,tx=>prepareOffboardingStepUndoTx(tx,manager,caseId,number,'resign_outcome'))).rejects.toThrow();
 await owner.db.insert(s.lcStepDef).values({tenantId:b.tenantId,kind:'offboarding',stepKey:'resign_submit',phase:0,label:'Historical step',ownerTeam:'HR',rule:'always',sort:1,active:false});await expect(withLifecycleTenant(manager,tx=>prepareOffboardingStepUndoTx(tx,manager,caseId,number,'resign_submit'))).rejects.toThrow();
 await owner.db.update(s.lcStepDef).set({active:true,rule:'outcome_rejected'}).where(and(eq(s.lcStepDef.tenantId,b.tenantId),eq(s.lcStepDef.stepKey,'resign_submit')));await expect(withLifecycleTenant(manager,tx=>prepareOffboardingStepUndoTx(tx,manager,caseId,number,'resign_submit'))).rejects.toThrow();
});
it('retains the original native Promise<void> screen API',async()=>{expect(await undoStep(manager,'offboarding',number,'resign_submit')).toBeUndefined();});
