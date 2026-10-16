/** Isolated application composition. Every Auth/SQL read receives the SAME explicit transaction. */
import {z} from 'zod';
import {internalConfig,internalSelected} from './config';
import {readRecord,type AuthSql} from './record-store';
import {parseCredential,assertActiveCredential} from './credential';
import {readActiveRelayTx} from './active-relay';
import {InternalAuthError} from './errors';
import {EmailSettingsError} from '../identity/email-model';
import {masterArtifactFingerprint,type MasterArtifactAuthorization} from '../employee-master-artifact-model';
import {MasterDeliveryPreparationError} from '../../deploy/identity-email/reports';
import {reportBrokerRequest,reportBrokerResponse,reportBrokerTarget,type ReportBrokerRequest,type ReportBrokerResponse,type ReportBrokerFailureReason} from './report-broker-model';
import {openReportInspection,sealReportInspection,reportProofDigest,REPORT_INSPECTION_LIFETIME_MS,type ReportInspectionClaims} from './report-broker-proof';
const instant=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const binding=z.object({issuer:z.string().max(500),subject:z.uuid(),userId:z.uuid(),personId:z.uuid().nullable(),createdAt:instant}).strict();
const contextSchema=z.object({target:reportBrokerTarget,issuer:z.string().max(500),bindings:z.object({owner:binding,recipient:binding}).strict(),leaseUntil:instant}).strict();
const lockedSchema=z.union([z.object({status:z.literal('ready'),context:contextSchema}).strict(),z.object({status:z.enum(['busy','notEligible','unavailable'])}).strict()]);
const authorizedSchema=z.object({accessStamp:z.string().regex(/^[a-f0-9]{64}$/),artifact:masterArtifactFingerprint}).strict();
type Context=z.infer<typeof contextSchema>;
export interface ReportBrokerDependencies {
 /** Caller owns BEGIN/COMMIT/ROLLBACK. Throwing always rolls back; never a singleton or nested Tx. */
 transaction<T>(work:(tx:AuthSql)=>Promise<T>):Promise<T>;
 /** Production is the direct fixed renderer RPC. No sender-forwarded manifest accepted. */
 authorizeArtifact(input:{occurrenceId:string;leaseToken:string;expectedAccessStamp:string}):Promise<MasterArtifactAuthorization>;
 now?:()=>number;
}
export class ReportBrokerRefusal extends Error {
 constructor(readonly reason:ReportBrokerFailureReason){super('Managed report broker refused.');}
}
function refuse(reason:ReportBrokerFailureReason='notEligible'):never {throw new ReportBrokerRefusal(reason);}
export async function assertReportBrokerDatabaseRole(tx:AuthSql):Promise<void> {
 const [role]=await tx.unsafe(`select current_user as name,r.rolsuper,r.rolbypassrls,
  (r.rolcreaterole or r.rolcreatedb or r.rolreplication
   or exists(select 1 from pg_auth_members m where m.member=r.oid)
   or exists(select 1 from pg_class c where c.relowner=r.oid)
   or exists(select 1 from pg_namespace n where n.nspowner=r.oid)) as privileged
  from pg_roles r where r.rolname=current_user`);
 if(role?.name!=='ai_hr_app'||role.rolsuper!==false||role.rolbypassrls!==false||role.privileged!==false)refuse('unavailable');
}
async function bounded(tx:AuthSql){
 await tx.unsafe('set transaction isolation level read committed read write');
 await tx.unsafe("set local statement_timeout='5s'");
 await tx.unsafe("set local lock_timeout='250ms'");
 await assertReportBrokerDatabaseRole(tx);
}
async function lockedContext(tx:AuthSql,nonce:{occurrenceId:string;leaseToken:string},origin:string):Promise<Context> {
 const [row]=await tx.unsafe('select app.internal_auth_report_lock_context($1::uuid,$2::uuid,$3::text) value',[nonce.occurrenceId,nonce.leaseToken,origin]);
 const parsed=lockedSchema.safeParse(row?.value);if(!parsed.success)refuse('unavailable');
 if(parsed.data.status!=='ready')refuse(parsed.data.status);
 const c=parsed.data.context,t=c.target;
 if(c.issuer!==origin+'/auth/'+t.tenantId||c.bindings.owner.issuer!==c.issuer||c.bindings.recipient.issuer!==c.issuer
  ||c.bindings.owner.userId!==t.ownerUserId||c.bindings.recipient.userId!==t.recipientUserId
  ||c.bindings.owner.personId!==t.ownerPersonId||c.bindings.recipient.personId!==t.recipientPersonId
  ||c.bindings.recipient.subject!==t.subject)refuse();
 return c;
}
async function material(tx:AuthSql,c:Context):Promise<{identities:ReportInspectionClaims['identities'];relay:NonNullable<Awaited<ReturnType<typeof readActiveRelayTx>>>}> {
 // Keep logical roles distinct even when both use the same canonical credential.
 const identity=async(role:'owner'|'recipient'):Promise<ReportInspectionClaims['identities']['owner']>=>{
  const expected=c.bindings[role],credential=parseCredential(await readRecord<unknown>(tx,'credential:'+expected.subject,true));
  if(!credential||credential.subject!==expected.subject||credential.tenantId!==c.target.tenantId||credential.issuer!==expected.issuer)refuse();
  const principal=await assertActiveCredential(tx,credential);
  if(principal.app_user_id!==expected.userId||principal.tenant_id!==c.target.tenantId)refuse();
  if(role==='recipient'&&credential.email.toLowerCase()!==c.target.email.toLowerCase())refuse();
  return {issuer:expected.issuer,subject:expected.subject,userId:expected.userId,personId:expected.personId,bindingCreatedAt:expected.createdAt,credentialVersion:credential.version};
 };
 const identities={owner:await identity('owner'),recipient:await identity('recipient')};
 const relay=await readActiveRelayTx(tx,true);if(!relay)refuse('unavailable');
 return {identities,relay};
}
/** Finite public failures contain no SQL, credential, proof, relay secret or caught Error.message. */
export async function executeReportBrokerRequest(input:unknown,d:ReportBrokerDependencies):Promise<ReportBrokerResponse> {
 const parsed=reportBrokerRequest.safeParse(input);if(!parsed.success)return {ok:false,reason:'notEligible'};
 const request=parsed.data,now=d.now??Date.now;
 try{
  if(!internalSelected())refuse('unavailable');
  const origin=internalConfig().origin;
  if(request.phase==='status')return await d.transaction(async tx=>{
   await bounded(tx);return reportBrokerResponse.parse({available:Boolean(await readActiveRelayTx(tx,false))});
  });
  if(request.phase==='inspect')return await d.transaction(async tx=>{
   await bounded(tx);const c=await lockedContext(tx,request,origin),m=await material(tx,c),issuedAt=now();
   const expiresAt=Math.min(issuedAt+REPORT_INSPECTION_LIFETIME_MS,Date.parse(c.leaseUntil));
   if(!Number.isSafeInteger(expiresAt)||expiresAt<=issuedAt)refuse();
   const inspectionProof=sealReportInspection({v:1,purpose:'managed-report-inspection-v1',origin,occurrenceId:request.occurrenceId,leaseToken:request.leaseToken,issuedAt,expiresAt,targetDigest:reportProofDigest(c.target),accessStamp:c.target.accessStamp,identities:m.identities,relayRevision:m.relay.revision});
   return reportBrokerResponse.parse({ok:true,phase:'inspect',target:c.target,inspectionProof});
  });
  return await start(request,d,origin,now);
 }catch(error){
  if(error instanceof ReportBrokerRefusal)return {ok:false,reason:error.reason};
  if(error instanceof InternalAuthError)return {ok:false,reason:error.code==='invalidLogin'?'notEligible':'unavailable'};
  if(error instanceof MasterDeliveryPreparationError)return {ok:false,reason:error.reason};
  if(error instanceof EmailSettingsError)return {ok:false,reason:'unavailable'};
  // Unexpected storage, AEAD record tamper and infrastructure failures propagate to the process
  // boundary, which emits only unavailable. They never become a successful empty/default result.
  throw error;
 }
}
async function start(request:Extract<ReportBrokerRequest,{phase:'start'}>,d:ReportBrokerDependencies,origin:string,now:()=>number):Promise<ReportBrokerResponse> {
 const proof=openReportInspection(request.inspectionProof,request,now());if(!proof)refuse();
 // Authorize/hash first; no DB transaction or row lock spans the renderer RPC.
 const manifest=authorizedSchema.parse(await d.authorizeArtifact({occurrenceId:request.occurrenceId,leaseToken:request.leaseToken,expectedAccessStamp:proof.accessStamp}));
 if(manifest.accessStamp!==proof.accessStamp||reportProofDigest(manifest.artifact)!==reportProofDigest(request.expectedArtifact))refuse('generationFailed');
 const result=await d.transaction(async tx=>{
  await bounded(tx);const c=await lockedContext(tx,request,origin),m=await material(tx,c);
  // Reopen at the final check: time consumed by renderer/lock acquisition cannot extend the proof.
  const freshProof=openReportInspection(request.inspectionProof,request,now());
  if(!freshProof||freshProof.targetDigest!==reportProofDigest(c.target)||freshProof.accessStamp!==c.target.accessStamp
   ||manifest.accessStamp!==c.target.accessStamp||reportProofDigest(freshProof.identities)!==reportProofDigest(m.identities)
   ||freshProof.relayRevision!==m.relay.revision)refuse();
  const [row]=await tx.unsafe('select app.internal_auth_report_start($1::uuid,$2::uuid,$3::text,($4::text)::jsonb,($5::text)::jsonb) value',
   [request.occurrenceId,request.leaseToken,origin,JSON.stringify(c),JSON.stringify(manifest.artifact)]);
  if(row?.value!=='started')refuse(row?.value==='busy'?'busy':row?.value==='notEligible'?'notEligible':'unavailable');
  // Validate the whole response BEFORE commit; malformed output must roll back started.
  return reportBrokerResponse.parse({ok:true,phase:'start',target:c.target,artifact:manifest.artifact,relay:m.relay.relay});
 });
 // transaction() has committed; the process must close its pool before serializing this result.
 return result;
}
