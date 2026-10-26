import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import * as s from '../db/schema';
import type {SessionContext} from '../db/client';
import {saveLetterField,saveLetterTemplate,decideLetterTemplate,saveLetterPolicy,createLetterDraftBatch,getLetterGenerationBatch,refreshLetterDraft,submitLetterBatch,setLetterTemplateActive,withdrawLetterDraft,decideLetter,issueLetter,voidLetter,listMyLetters,getMyLetter,createMyLetterAccess,downloadMyLetter,acknowledgeMyLetter} from '../core/letters';
import {getEmployeeDocument,updateEmployeeDocumentMeta,deleteEmployeeDocument} from '../core/employee-documents';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {LetterPolicy} from '../lib/letter-workflow';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:SessionContext,reviewer:SessionContext,templateId:string,templateVersionId:string,templateRevision:number,employees:string[];
const today=()=>todayInKualaLumpur();
const custom=(ids:string[])=>Object.fromEntries(ids.map(id=>[id,{effectiveDate:{kind:'date' as const,value:today()}}]));
beforeEach(async()=>{
 await resetDb();b=await seedBase();ctx=await entitledCtx(b);
 const [reviewerPerson]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional signatory',primaryEmail:'letter-signatory@fixture.test'}).returning();const userId=await createAppUser(b.tenantId,reviewerPerson.id,'hr_admin');reviewer={...ctx,userId,personId:reviewerPerson.id};
 employees=[];for(const index of [1,2]){const hired=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${Number(today().slice(0,4))-1}-01-01`,employeeCode:'LETTER-000'+index,person:{fullName:'Fictional subject '+index,primaryEmail:`letter-subject-${index}@fixture.test`}});employees.push(hired.employmentId);}
 const name=await saveLetterField(ctx,{companyId:b.companyId,definition:{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true});
 const date=await saveLetterField(ctx,{companyId:b.companyId,definition:{key:'effectiveDate',label:'Effective date',description:'Date entered for this letter',kind:'date',source:'custom.date',required:true,editable:true,sensitive:false},active:true});
 const template=await saveLetterTemplate(ctx,{companyId:b.companyId,code:'GENERATION',name:'Fictional generation test',category:'confirmation',effectiveFrom:today(),document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'To '},{type:'field',key:'employeeName'},{type:'text',text:' — effective '},{type:'field',key:'effectiveDate'}]}]},fieldVersionIds:[name.id,date.id]});templateId=template.templateId;templateVersionId=template.versionId;templateRevision=template.revision;
 await decideLetterTemplate(ctx,{versionId:templateVersionId,expectedStatus:'draft',action:'submit'});await decideLetterTemplate(reviewer,{versionId:templateVersionId,expectedStatus:'submitted',action:'approve'});
 const policy:LetterPolicy={version:1,stages:[{key:'signatory',label:'Authorised signatory',userIds:[reviewer.userId!],allowDelegation:false}],signatoryUserId:reviewer.userId!,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:false};
 await saveLetterPolicy(ctx,{companyId:b.companyId,category:'confirmation',policy,enabled:true});
});afterAll(closeAll);
describe('letter generation snapshots and complete-batch readiness',()=>{
 it('seals the current approved revision only after a personally confirmed final signatory decision',async()=>{
  const created=await createLetterDraftBatch(ctx,{companyId:b.companyId,templateVersionId,employmentIds:[employees[0]],customValues:custom([employees[0]]),operationKey:randomUUID()});await submitLetterBatch(ctx,created.batchId);
  const row=(await getLetterGenerationBatch(ctx,created.batchId))!.rows[0],input={letterId:row.record.id,expectedRevisionId:row.revision!.id,expectedLockVersion:row.record.lockVersion,decision:{action:'approve' as const,comment:'Reviewed the frozen document',confirmSignature:true}};
  await expect(decideLetter(ctx,input)).rejects.toMatchObject({code:'selfApproval'});await expect(decideLetter(reviewer,{...input,expectedLockVersion:input.expectedLockVersion-1})).rejects.toMatchObject({code:'stale'});await expect(decideLetter(reviewer,{...input,decision:{...input.decision,confirmSignature:false}})).rejects.toMatchObject({code:'signatureRequired'});expect(await owner.db.select().from(s.letterApprovalDecision)).toHaveLength(0);
  const result=await decideLetter(reviewer,input);expect(result.state).toBe('approved');expect(result.artifactId).toBeTruthy();
  const [artifact]=await owner.db.select().from(s.letterArtifact).where(eq(s.letterArtifact.id,result.artifactId!));expect(artifact.revisionId).toBe(row.revision!.id);expect(artifact.signatoryUserId).toBe(reviewer.userId);expect(artifact.content.subarray(0,5).toString()).toBe('%PDF-');expect(artifact.contentHash).toBe(createHash('sha256').update(artifact.content).digest('hex'));
  await expect(decideLetter(reviewer,input)).rejects.toMatchObject({code:'stale'});expect(await owner.db.select().from(s.letterApprovalDecision)).toHaveLength(1);expect(await owner.db.select().from(s.letterArtifact)).toHaveLength(1);
  const issue={letterId:row.record.id,expectedRevisionId:row.revision!.id,expectedLockVersion:result.lockVersion};expect(await issueLetter(ctx,issue)).toMatchObject({alreadyIssued:false});expect(await issueLetter(ctx,issue)).toMatchObject({alreadyIssued:true});
  const documents=await owner.db.select().from(s.employeeDocument).where(eq(s.employeeDocument.letterArtifactId,artifact.id));expect(documents).toHaveLength(1);expect(documents[0].content.length).toBe(0);expect(documents[0].sizeBytes).toBe(artifact.content.length);
  expect((await getEmployeeDocument(ctx,documents[0].id,employees[0]))?.content).toEqual(artifact.content);expect(await getEmployeeDocument(ctx,documents[0].id,employees[1])).toBeNull();
  await expect(updateEmployeeDocumentMeta(ctx,{documentId:documents[0].id,title:'Cannot overwrite the sealed letter'})).rejects.toMatchObject({cause:{code:'23514'}});await expect(deleteEmployeeDocument(ctx,{documentId:documents[0].id})).rejects.toMatchObject({cause:{code:'23514'}});
  const [subject]=await owner.db.select({personId:s.employment.personId}).from(s.employment).where(eq(s.employment.id,employees[0])),employeeUser=await createAppUser(b.tenantId,subject.personId,'employee'),self={...await entitledCtx(b,['employee']),userId:employeeUser,personId:subject.personId};
  expect((await listMyLetters(self)).rows.map(letter=>letter.id)).toEqual([row.record.id]);expect(await getMyLetter(self,row.record.id)).toMatchObject({acknowledgement:'acknowledge',artifact:{contentHash:artifact.contentHash}});await expect(getMyLetter(ctx,row.record.id)).rejects.toMatchObject({code:'permission'});
  const access=await createMyLetterAccess(self,row.record.id);expect((await downloadMyLetter(self,{letterId:row.record.id,token:access.token})).content).toEqual(artifact.content);await expect(downloadMyLetter(ctx,{letterId:row.record.id,token:access.token})).rejects.toMatchObject({code:'permission'});
  const acknowledgement={letterId:row.record.id,expectedArtifactHash:artifact.contentHash,action:'acknowledge' as const,intent:'I acknowledge this exact fictional letter'};await expect(acknowledgeMyLetter(self,{...acknowledgement,expectedArtifactHash:'0'.repeat(64)})).rejects.toMatchObject({code:'stale'});
  const recorded=await acknowledgeMyLetter(self,acknowledgement);expect(recorded.alreadyRecorded).toBe(false);expect(await acknowledgeMyLetter(self,acknowledgement)).toEqual({at:recorded.at,alreadyRecorded:true});expect((await owner.db.select().from(s.letterRecipientEvent).where(eq(s.letterRecipientEvent.kind,'acknowledged')))).toHaveLength(1);
  await voidLetter(ctx,{letterId:row.record.id,expectedLockVersion:result.lockVersion+1,reason:'Fictional original has been superseded'});expect(await getEmployeeDocument(ctx,documents[0].id)).toBeNull();expect(await owner.db.select().from(s.letterArtifact)).toHaveLength(1);await expect(issueLetter(ctx,issue)).rejects.toMatchObject({code:'stale'});
  await expect(downloadMyLetter(self,{letterId:row.record.id,token:access.token})).rejects.toMatchObject({code:'state'});expect(await getMyLetter(self,row.record.id)).toMatchObject({record:{state:'void'}});
 });
 it('returns with a required reason and cannot submit the old revision again',async()=>{
  const created=await createLetterDraftBatch(ctx,{companyId:b.companyId,templateVersionId,employmentIds:[employees[0]],customValues:custom([employees[0]]),operationKey:randomUUID()});await submitLetterBatch(ctx,created.batchId);const row=(await getLetterGenerationBatch(ctx,created.batchId))!.rows[0];
  const input={letterId:row.record.id,expectedRevisionId:row.revision!.id,expectedLockVersion:row.record.lockVersion,decision:{action:'return' as const,comment:'',confirmSignature:false}};await expect(decideLetter(reviewer,input)).rejects.toMatchObject({code:'reasonRequired'});
  expect(await decideLetter(reviewer,{...input,decision:{...input.decision,comment:'Correct the effective date'}})).toMatchObject({state:'returned'});await expect(submitLetterBatch(ctx,created.batchId)).rejects.toMatchObject({code:'state'});expect(await owner.db.select().from(s.letterArtifact)).toHaveLength(0);
 });
 it('saves missing-field drafts, counts only ready letters, and submits atomically after correction',async()=>{
  const created=await createLetterDraftBatch(ctx,{companyId:b.companyId,templateVersionId,employmentIds:employees,customValues:custom([employees[0]]),operationKey:randomUUID()});
  const preview=await getLetterGenerationBatch(ctx,created.batchId);expect(preview).toMatchObject({ready:1,needsCorrection:1});expect(new Set(preview!.rows.map(row=>row.record.reference)).size).toBe(2);
  await expect(submitLetterBatch(ctx,created.batchId)).rejects.toMatchObject({code:'configuration'});expect((await owner.db.select().from(s.letterRecord)).every(record=>record.state==='draft')).toBe(true);
  const missing=preview!.rows.find(row=>row.record.employmentId===employees[1])!;expect(missing.issue).toEqual({code:'missingField',field:'effectiveDate'});await refreshLetterDraft(ctx,{letterId:missing.record.id,expectedLockVersion:missing.record.lockVersion,customValues:custom([employees[1]])[employees[1]]});
  expect(await getLetterGenerationBatch(ctx,created.batchId)).toMatchObject({ready:2,needsCorrection:0});expect(await submitLetterBatch(ctx,created.batchId)).toMatchObject({submitted:2,alreadySubmitted:false});expect(await submitLetterBatch(ctx,created.batchId)).toMatchObject({submitted:0,alreadySubmitted:true});
  expect((await owner.db.select().from(s.letterRecord)).every(record=>record.state==='submitted')).toBe(true);
 });
 it('revalidates canonical master values and requires a new immutable revision before submission',async()=>{
  const created=await createLetterDraftBatch(ctx,{companyId:b.companyId,templateVersionId,employmentIds:[employees[0]],customValues:custom([employees[0]]),operationKey:randomUUID()}),before=(await getLetterGenerationBatch(ctx,created.batchId))!.rows[0];
  const [employment]=await owner.db.select().from(s.employment).where(eq(s.employment.id,employees[0]));await owner.db.update(s.person).set({fullName:'Corrected fictional name'}).where(eq(s.person.id,employment.personId));
  expect((await getLetterGenerationBatch(ctx,created.batchId))!.rows[0]).toMatchObject({sourceChanged:true,ready:false});await expect(submitLetterBatch(ctx,created.batchId)).rejects.toMatchObject({code:'stale'});
  await expect(refreshLetterDraft(ctx,{letterId:before.record.id,expectedLockVersion:before.record.lockVersion,customValues:{employeeName:{kind:'text',value:'Forged name'}}})).rejects.toMatchObject({code:'invalid'});
  const after=await refreshLetterDraft(ctx,{letterId:before.record.id,expectedLockVersion:before.record.lockVersion});expect(after.ordinal).toBe(2);expect(JSON.stringify(after.document)).toContain('Corrected fictional name');expect((await owner.db.select().from(s.letterRevision).where(eq(s.letterRevision.id,before.revision!.id)))[0]).toEqual(before.revision);
  expect(await submitLetterBatch(ctx,created.batchId)).toMatchObject({submitted:1});
 });
 it('deduplicates retries and rejects a changed payload using the same operation key',async()=>{
  const input={companyId:b.companyId,templateVersionId,employmentIds:[employees[0]],customValues:custom([employees[0]]),operationKey:randomUUID()};const first=await createLetterDraftBatch(ctx,input);expect(await createLetterDraftBatch(ctx,input)).toEqual({batchId:first.batchId,alreadyCreated:true});expect(await owner.db.select().from(s.letterRecord)).toHaveLength(1);
  await expect(createLetterDraftBatch(ctx,{...input,employmentIds:employees})).rejects.toMatchObject({code:'conflict'});expect(await owner.db.select().from(s.letterGenerationBatch)).toHaveLength(1);
 });
 it('keeps a generated snapshot readable after template deactivation and blocks new generation/submission',async()=>{
  const input={companyId:b.companyId,templateVersionId,employmentIds:[employees[0]],customValues:custom([employees[0]]),operationKey:randomUUID()},created=await createLetterDraftBatch(ctx,input);const old=(await getLetterGenerationBatch(ctx,created.batchId))!.rows[0].revision;
  await setLetterTemplateActive(ctx,{templateId,expectedRevision:templateRevision,active:false});const read=await getLetterGenerationBatch(ctx,created.batchId);expect(read!.templateActive).toBe(false);expect(read!.rows[0].revision).toEqual(old);expect(read!.ready).toBe(0);
  await expect(createLetterDraftBatch(ctx,{...input,operationKey:randomUUID()})).rejects.toMatchObject({code:'configuration'});await expect(submitLetterBatch(ctx,created.batchId)).rejects.toMatchObject({code:'configuration'});
 });
 it('can remove a missing-field draft without deleting its reference or audit history',async()=>{
  const created=await createLetterDraftBatch(ctx,{companyId:b.companyId,templateVersionId,employmentIds:employees,customValues:custom([employees[0]]),operationKey:randomUUID()}),missing=(await getLetterGenerationBatch(ctx,created.batchId))!.rows.find(row=>!row.revision)!;
  await withdrawLetterDraft(ctx,{letterId:missing.record.id,expectedLockVersion:missing.record.lockVersion,reason:'Remove from this batch until the date is confirmed'});expect(await submitLetterBatch(ctx,created.batchId)).toMatchObject({submitted:1});
  const rows=await owner.db.select().from(s.letterRecord).orderBy(asc(s.letterRecord.reference));expect(rows).toHaveLength(2);expect(rows.map(row=>row.state).sort()).toEqual(['submitted','withdrawn']);
  expect(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,missing.record.id),eq(s.domainEvent.eventType,'letter.withdrawn')))).toHaveLength(1);
 });
});
