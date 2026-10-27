/** Server-only association custody/parser. This lower layer does not import the governance owner
 * or command service. A caller MUST first obtain real own-job provenance from the existing verifier;
 * this argument is trusted server output, never an accepted browser/model DTO. Native proof is
 * freshly reopened here; neither a stored marker nor an event UUID is canonical-engine provenance. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import type {AgentModuleCode} from '../lib/ai/module-agents';
import {encryptSecret,decryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {NativeOutcomeReference,NativeOutcomeEvidence,NativeOutcomeAssociationView,RecordNativeOutcomeAssociation,nativeOutcomeDescriptor} from '../lib/ai/module-native-outcomes';
import {readCompletedNativeOutcomeTx,type NativeOutcomeServerContext} from './assistant-actions/completed-outcome-readers';
export type NativeOutcomeJobProvenance=Readonly<{jobId:string;modules:readonly AgentModuleCode[];jobReceiptDigest:string;candidateDigest:string;sourceDigest:string;expiresAt:string}>;
const Id=z.uuid(),Digest=z.string().regex(/^[a-f0-9]{64}$/),Time=z.union([z.string(),z.date()]);
const Row=z.object({id:Id,tenant_id:Id,user_id:Id,person_id:Id.nullable(),job_id:Id,request_nonce:Id,request_digest:Digest,action:z.string(),source_kind:z.enum(['review','employee_import']),review_id:Id.nullable(),import_attempt_id:Id.nullable(),event_id:Id,native_digest:Digest,job_receipt_digest:Digest,receipt:z.string().min(1).max(16384),consented:z.literal(true),created_at:Time,expires_at:Time,fresh:z.literal(true)}).strict();
type Row=z.infer<typeof Row>;
const Sealed=z.object({version:z.literal(1),tenantId:Id,userId:Id,personId:Id.nullable(),jobId:Id,requestNonce:Id,reference:NativeOutcomeReference,jobReceiptDigest:Digest,candidateDigest:Digest,sourceDigest:Digest,native:NativeOutcomeEvidence,proofNonce:Id,consented:z.literal(true),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();
type Proof=z.infer<typeof Sealed>;
const fail=():never=>{throw Error('This outcome link needs a fresh look. Please check your access and completed action.');};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rawReceiptDigest=(receipt:string)=>createHash('sha256').update(receipt,'utf8').digest('hex');
const instant=(value:Date|string)=>{const d=value instanceof Date?value:new Date(value);if(!Number.isFinite(d.getTime()))return fail();return d.toISOString();};
const aad=(ctx:SessionContext,id:string)=>'module-native-outcome:v1:'+ctx.tenantId+':'+ctx.userId+':'+id;
const projection=sql`id,tenant_id,user_id,person_id,job_id,request_nonce,request_digest,action,source_kind,review_id,import_attempt_id,event_id,native_digest,job_receipt_digest,receipt,consented,created_at,expires_at,(expires_at>now()) as fresh`;
function requireProvenance(p:NativeOutcomeJobProvenance,reference:z.infer<typeof NativeOutcomeReference>){
 const descriptor=nativeOutcomeDescriptor(reference.action);if(!Id.safeParse(p.jobId).success||!Digest.safeParse(p.jobReceiptDigest).success||!Digest.safeParse(p.candidateDigest).success||!Digest.safeParse(p.sourceDigest).success||!Array.isArray(p.modules)||!p.modules.includes(descriptor.module))return fail();instant(p.expiresAt);return descriptor;
}
function openRow(ctx:SessionContext,row:Row):Proof{
 if(row.tenant_id!==ctx.tenantId||row.user_id!==ctx.userId||row.person_id!==(ctx.personId??null)||!row.fresh||!isSecretStorable())return fail();
 let proof:Proof;try{proof=Sealed.parse(JSON.parse(decryptSecret(row.receipt,aad(ctx,row.id))));}catch{return fail();}
 const p=proof,r=p.reference;
 if(p.tenantId!==row.tenant_id||p.userId!==row.user_id||p.personId!==row.person_id||p.jobId!==row.job_id||p.requestNonce!==row.request_nonce||p.native.action!==r.action||p.native.action!==row.action||p.native.eventId!==row.event_id||p.native.sourceId!==(r.source==='review'?r.actionId:r.attemptId)||row.source_kind!==r.source||row.review_id!==(r.source==='review'?r.actionId:null)||row.import_attempt_id!==(r.source==='employee_import'?r.attemptId:null)||hash([p.proofNonce,p.native])!==row.native_digest||p.jobReceiptDigest!==row.job_receipt_digest||p.createdAt!==instant(row.created_at)||p.expiresAt!==instant(row.expires_at)||hash({jobId:p.jobId,reference:r,consented:true,nonce:p.requestNonce})!==row.request_digest)return fail();
 return p;
}
function sameProvenance(p:Proof,job:NativeOutcomeJobProvenance){requireProvenance(job,p.reference);if(p.jobId!==job.jobId||p.jobReceiptDigest!==job.jobReceiptDigest||p.candidateDigest!==job.candidateDigest||p.sourceDigest!==job.sourceDigest||Date.parse(p.expiresAt)>Date.parse(job.expiresAt))return fail();}
function view(row:Row,p:Proof){const descriptor=nativeOutcomeDescriptor(p.reference.action);return NativeOutcomeAssociationView.parse({associationId:row.id,action:p.reference.action,module:descriptor.module,semantics:descriptor.semantics,currentStatus:p.native.currentStatus,association:'human_linked_verified_native_outcome',causalCredit:false,quality:'not_assessed',createdAt:p.createdAt,expiresAt:p.expiresAt});}
async function rowTx(tx:Tx,ctx:SessionContext,id:string){const [raw]=await tx.execute(sql`select ${projection} from public.ai_native_outcome_association where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);if(!raw)return fail();return Row.parse(raw);}
/** Append/delete-only custody interval. The table trigger uses the identical canonical UUID key
 * for INSERT/DELETE (including expiry/cascade). TRY failure requires whole caller-Tx rollback.
 * No UPDATE privilege or SELECT FOR UPDATE is needed or granted. */
export async function lockNativeOutcomeCustodyTx(tx:Tx,ctx:SessionContext){
 const bounds=await tx.execute(sql`select name,set_config(name,(case when setting::bigint=0 then case name when 'statement_timeout' then 5000 else 500 end else least(setting::bigint,case name when 'statement_timeout' then 5000 else 500 end) end)::text,true) as value from pg_catalog.pg_settings where name in ('statement_timeout','lock_timeout') and unit='ms'`);if(bounds.length!==2)return fail();
 if(!Id.safeParse(ctx.tenantId).success||!Id.safeParse(ctx.userId).success)return fail();
 const [row]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended('native-outcome:v1:'||(${ctx.tenantId}::uuid)::text||':'||(${ctx.userId}::uuid)::text,0)) as owned`);
 if(row?.owned!==true)return fail();
}
/** Minimal own nomination only; does not authenticate a job or reveal any action/source reference. */
export async function nominateOwnNativeOutcomeJobTx(tx:Tx,ctx:SessionContext,id:string){const [row]=await tx.execute<{job_id:string}>(sql`select job_id from public.ai_native_outcome_association where id=${Id.parse(id)}::uuid and tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid`);return Id.parse(row?.job_id);}
/** Existing authenticated job source may have changed because the native action succeeded. Reopen
 * proves the exact action again; a changed current status is stale evidence, not retroactive failure. */
export async function readVerifiedNativeOutcomeAssociationTx(tx:Tx,ctx:SessionContext,idValue:unknown,job:NativeOutcomeJobProvenance,server:NativeOutcomeServerContext={}){
 const id=Id.parse(idValue),before=await rowTx(tx,ctx,id),proof=openRow(ctx,before);sameProvenance(proof,job);
 const fresh=await readCompletedNativeOutcomeTx(tx,ctx,proof.reference,server);
 if(hash([proof.proofNonce,fresh.evidence])!==before.native_digest||Date.parse(proof.expiresAt)>Date.parse(fresh.sourceExpiresAt))return fail();
 await lockNativeOutcomeCustodyTx(tx,ctx);const row=await rowTx(tx,ctx,id);if(row.receipt!==before.receipt||row.request_digest!==before.request_digest)return fail();const checked=openRow(ctx,row);sameProvenance(checked,job);
 return Object.freeze({view:view(row,checked),reference:Object.freeze({associationId:id,jobId:job.jobId,associationReceiptDigest:rawReceiptDigest(row.receipt),nativeDigest:row.native_digest,jobReceiptDigest:row.job_receipt_digest,action:checked.reference.action,module:nativeOutcomeDescriptor(checked.reference.action).module,expiresAt:checked.expiresAt})});
}
/** Called only AFTER the existing own-job verifier took Access/release/signal ownership. */
export async function recordVerifiedNativeOutcomeAssociationTx(tx:Tx,ctx:SessionContext,value:z.infer<typeof RecordNativeOutcomeAssociation>,job:NativeOutcomeJobProvenance,server:NativeOutcomeServerContext={}){
 const input=RecordNativeOutcomeAssociation.parse(structuredClone(value));if(input.jobId!==job.jobId||!ctx.userId||!isSecretStorable())return fail();requireProvenance(job,input.reference);
 const native=await readCompletedNativeOutcomeTx(tx,ctx,input.reference,server),requestDigest=hash(input);
 await lockNativeOutcomeCustodyTx(tx,ctx);
 const [old]=await tx.execute(sql`select ${projection} from public.ai_native_outcome_association where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and request_nonce=${input.nonce}::uuid`);
 if(old){const row=Row.parse(old),proof=openRow(ctx,row);if(row.request_digest!==requestDigest)return fail();sameProvenance(proof,job);if(hash([proof.proofNonce,native.evidence])!==row.native_digest||Date.parse(proof.expiresAt)>Date.parse(native.sourceExpiresAt))return fail();return view(row,proof);}
 const [event]=await tx.execute<{id:string}>(sql`select id from public.ai_native_outcome_association where tenant_id=${ctx.tenantId}::uuid and user_id=${ctx.userId}::uuid and event_id=${native.evidence.eventId}::uuid`);if(event)return fail();
 const [clock]=await tx.execute<{created:Date|string;expires:Date|string}>(sql`select now() as created,least(now()+interval '30 days',${job.expiresAt}::timestamptz,${native.sourceExpiresAt}::timestamptz) as expires`);
 const id=randomUUID(),proof=Sealed.parse({version:1,tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,jobId:job.jobId,requestNonce:input.nonce,reference:input.reference,jobReceiptDigest:job.jobReceiptDigest,candidateDigest:job.candidateDigest,sourceDigest:job.sourceDigest,native:native.evidence,proofNonce:randomUUID(),consented:true,createdAt:instant(clock.created),expiresAt:instant(clock.expires)});
 if(Date.parse(proof.expiresAt)<=Date.parse(proof.createdAt))return fail();
 const receipt=encryptSecret(JSON.stringify(proof),aad(ctx,id)),nativeDigest=hash([proof.proofNonce,proof.native]);
 await tx.execute(sql`insert into public.ai_native_outcome_association(id,tenant_id,user_id,person_id,job_id,request_nonce,request_digest,action,source_kind,review_id,import_attempt_id,event_id,native_digest,job_receipt_digest,receipt,consented,created_at,expires_at)
 values(${id}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,${ctx.personId??null}::uuid,${job.jobId}::uuid,${input.nonce}::uuid,${requestDigest},${input.reference.action},${input.reference.source},${input.reference.source==='review'?input.reference.actionId:null}::uuid,${input.reference.source==='employee_import'?input.reference.attemptId:null}::uuid,${native.evidence.eventId}::uuid,${nativeDigest},${job.jobReceiptDigest},${receipt},true,${proof.createdAt}::timestamptz,${proof.expiresAt}::timestamptz)`);
 return view(await rowTx(tx,ctx,id),proof);
}
