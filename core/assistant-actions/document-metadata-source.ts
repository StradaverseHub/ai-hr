/** Ordinary document metadata only. No attachment bytes, provider, download or letter mutation. */
import {createHash} from 'node:crypto';
import {canonicalEntitlementsForDigest} from '../../lib/assistant-actions/canonical-entitlements';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {DocumentMetadata as C,type DocumentMetadataHuman as Human} from '../../lib/assistant-actions/document-metadata-contract';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {assertWorkforceEmploymentTx} from '../workforce-access';
import {lockAccessConfigurationTx} from '../access-configuration-lock';
import {prepareEmployeeDocumentMetadataTx,updateEmployeeDocumentMeta} from '../employee-documents';
export class DocumentMetadataUnavailable extends Error{constructor(){super('Please reopen document details on the Personnel screen.');this.name='DocumentMetadataUnavailable';}}
export const documentMetadataUnavailable=():never=>{throw new DocumentMetadataUnavailable();};
const fail=documentMetadataUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Subject=AssignedSubject&{employeeName:string;employeeCode:string|null;companyName:string;scopeDigest:string};
async function actor(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');if(!isAdmin(fresh))return fail();await lockAccessConfigurationTx(tx,fresh.tenantId);return fresh;}
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [nomination]=await tx.execute<{scope:{employmentId:string;personId:string;companyId:string;scopeDigest:string}|null}>(sql`select app.assistant_document_metadata_scope(${id}::uuid) as scope`);const scope=nomination?.scope;if(!scope||scope.personId===ctx.personId)return fail();
 await assertWorkforceEmploymentTx(tx,ctx,scope.employmentId,'maintain');
 const [labels]=await tx.execute<{employeeName:string;employeeCode:string|null;companyName:string}>(sql`select p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.id=${scope.employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid and e.person_id=${scope.personId}::uuid and not app.is_self_person(e.person_id)`);
 if(!labels)return fail();return{...labels,subjectId:id,subjectPersonId:scope.personId,employmentId:scope.employmentId,companyId:scope.companyId,scopeDigest:scope.scopeDigest};
}
export async function withDocumentMetadataSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{const fresh=await actor(tx,ctx);return work(fresh,await subject(tx,fresh,id));}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.subjectId);if(s.employmentId!==human.employmentId)return fail();
 const native=await prepareEmployeeDocumentMetadataTx(tx,ctx,{documentId:human.subjectId,...human.fields});if(native.subject.employmentId!==s.employmentId||native.subject.personId!==s.subjectPersonId)return fail();
 const {revision,...attachment}=native.attachment,item=C.Item.parse({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,before:native.before,after:native.after,attachment});
 return{review:item,reviewedDigest:hash([1,C.action,s,revision,attachment,item,canonicalEntitlementsForDigest(ctx.entitlements)])};
}
export const prepareDocumentMetadataSourceTx=review;
export async function confirmDocumentMetadataSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const native=await updateEmployeeDocumentMeta(ctx,{documentId:human.subjectId,...human.fields},tx);
 const [row]=await tx.execute<{fields:unknown;eventId:string}>(sql`select jsonb_build_object('title',q.title,'category',q.category,'description',q.description) as fields,d.id as "eventId" from employee_document q join domain_event d on d.aggregate_id=q.id and d.tenant_id=q.tenant_id where q.id=${human.subjectId}::uuid and q.tenant_id=${ctx.tenantId}::uuid and q.employment_id=${human.employmentId}::uuid and q.letter_artifact_id is null and q.xmin=pg_current_xact_id()::xid and d.id=${native.eventId}::uuid and d.xmin=pg_current_xact_id()::xid and d.event_type='employee-document.updated' and d.aggregate_type='employee-document' and d.subject_employment_id=q.employment_id and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.payload->>'metadataAfterHash'=encode(sha256(convert_to(jsonb_build_object('title',q.title,'category',q.category,'description',q.description)::text,'UTF8')),'hex')`);
 if(!row||JSON.stringify(C.Fields.parse(row.fields))!==JSON.stringify(current.review.after))return fail();return{eventId:row.eventId,receipt:await reconcileDocumentMetadataSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId:row.eventId})};
}
export async function reconcileDocumentMetadataSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){
 const s=await subject(tx,ctx,reference.subjectId);if(s.employmentId!==reference.employmentId)return fail();
 const [row]=await tx.execute(sql`select d.id from domain_event d where d.id=${reference.eventId}::uuid and d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_id=${reference.subjectId}::uuid and d.subject_employment_id=${reference.employmentId}::uuid and d.aggregate_type='employee-document' and d.event_type='employee-document.updated' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid`);if(!row)return fail();return C.Receipt.parse({kind:'maintained',...reference});
}
export async function readDocumentMetadataChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await actor(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const employees=await tx.execute<{employmentId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select e.id as "employmentId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.tenant_id=${fresh.tenantId}::uuid and not app.is_self_person(e.person_id) and app.access_workforce_employment(e.id,'workforce.maintain') and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern}) order by p.full_name,e.id limit 26`);
 const shown=Array.from(employees).slice(0,25);let documents:unknown[]=[];let truncated=employees.length>25;
 if(pick.employmentId){await assertWorkforceEmploymentTx(tx,fresh,pick.employmentId,'maintain');const [selected]=await tx.execute<{employmentId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select e.id as "employmentId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.id=${pick.employmentId}::uuid and e.tenant_id=${fresh.tenantId}::uuid and not app.is_self_person(e.person_id)`);if(!selected)return fail();
  documents=Array.from(await tx.execute(sql`select q.id,jsonb_build_object('title',q.title,'category',q.category,'description',q.description) as fields,jsonb_build_object('fileName',q.file_name,'mimeType',q.mime_type,'sizeBytes',q.size_bytes) as attachment from employee_document q where q.tenant_id=${fresh.tenantId}::uuid and q.employment_id=${pick.employmentId}::uuid and q.letter_artifact_id is null order by q.id limit 101`));if(documents.length>100)return fail();if(!shown.some(row=>row.employmentId===selected.employmentId)){if(shown.length===25){shown.pop();truncated=true;}shown.push(selected);}}
 return C.Choices.parse({kind:'choices',employees:shown,truncated,documents});
}
