import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import type {SqlExecutor} from '../../db/sql-executor';
import {canEditSigningContent,recordAcknowledgementDecline,recordSigningAction,replacePendingSigner,resendSigningDocument,reviseSigningDocument,validateSigningRoute,SigningError,type SigningDocument,type SigningGuardrails,type SigningRoute,type SigningRoutingMeta} from '../../lib/document-signing-model';
export type {SigningDocument,SigningGuardrails,SigningRoute,SigningRoutingMeta,SigningStep,SigningAction,SigningStepKind} from '../../lib/document-signing-model';
export {canEditSigningContent,currentRoundActions,pendingSigningSteps,resendSigningDocument,signingComplete,signingContentLocked,signingContentVisible,signingDocumentOwner,signingSendBack,signingStepAction,signingStepQueue,SigningError} from '../../lib/document-signing-model';
export * from '../../lib/document-signing-routing';
type StoredDocument={id:string;employment_id:string;company_id:string;subject_id:string;revision:number;data:SigningDocument;guardrails:SigningGuardrails};

/** Subject adapters own business eligibility; SQL independently rechecks actor and subject authority. */
async function load(tx:SqlExecutor,ctx:SessionContext,id:string):Promise<StoredDocument>{
  const [row]=await tx.execute<StoredDocument>(sql`select id,employment_id,company_id,subject_id,revision,data,guardrails from document_signing_document where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  if(!row)throw new SigningError('forbidden','This signing document is unavailable in your current scope.');
  return row;
}
export async function readSigningDocumentTx(tx:SqlExecutor,ctx:SessionContext,id:string):Promise<SigningDocument>{return(await load(tx,ctx,id)).data;}
/**
 * `routing` is passed only for a document generated from a template version whose signing and review routing is not
 * empty (lib/document-signing-routing.ts resolveDocumentRouting). It switches on the owner, send-back/re-send, edit-lock
 * and visibility rules; without it the document behaves exactly as before.
 */
export async function createSigningDocumentTx(tx:SqlExecutor,ctx:SessionContext,input:{id?:string;companyId:string;employmentId:string;subjectId:string;subjectType:'probation'|'contract'|'contract-approval';contentHash:string;route:SigningRoute;guardrails:SigningGuardrails;routing?:SigningRoutingMeta}):Promise<{id:string;document:SigningDocument}>{
  if((input.subjectType==='probation'&&!ctx.userId)||!/^[a-f0-9]{64}$/.test(input.contentHash))throw new SigningError('invalid','Verified actor and signed content fingerprint are required.');
  if(input.subjectType!=='probation'&&ctx.userId)throw new SigningError('forbidden','Contract signing creation requires its protected event worker.');
  if(input.routing&&(!input.routing.templateId||!Number.isSafeInteger(input.routing.templateVersion)||input.routing.templateVersion<1))throw new SigningError('invalid','The template version of the routing is required.');
  const route=await hydrateRoute(tx,ctx,input.route);
  validateSigningRoute(route,input.guardrails);
  const id=input.subjectType==='probation'?randomUUID():input.id??randomUUID(),document:SigningDocument={tenantId:ctx.tenantId,companyId:input.companyId,subjectId:input.subjectId,subjectType:input.subjectType,contentRevision:1,contentHash:input.contentHash,route,actions:[],...(input.routing?{routing:{templateId:input.routing.templateId,templateVersion:input.routing.templateVersion,caseOwnerId:input.routing.caseOwnerId??null,fallbackGroupId:input.routing.fallbackGroupId??null,...(input.subjectType==='contract'&&input.routing.liveMergeReviews?{liveMergeReviews:true}:{})}}:{})};
  await tx.execute(sql`select app.document_signing_store(${id}::uuid,${input.employmentId}::uuid,${input.companyId}::uuid,${input.subjectId}::uuid,${JSON.stringify(document)}::text::jsonb,${JSON.stringify(input.guardrails)}::text::jsonb,0,'create','Created signing route')`);
  return{id,document};
}
/** Sign, review, approve or send back (`returned`, with a comment) at the caller's pending step. */
export async function recordDocumentSigningActionTx(tx:SqlExecutor,ctx:SessionContext,input:{id:string;actionId?:string;stepId:string;revision:number;hash:string;action:'signed'|'returned'|'reviewed'|'approved';comment?:string;method?:'typed'|'drawn';value?:string;consent?:boolean}):Promise<SigningDocument>{
  if(!ctx.userId)throw new SigningError('forbidden','Sign in before recording your signature.');
  const row=await load(tx,ctx,input.id);
  const [actor]=await tx.execute<{name:string;person_id:string}>(sql`select p.full_name as name,p.id as person_id from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)`);
  if(!actor)throw new SigningError('forbidden','The verified signer is unavailable.');
  const actionId=input.actionId??randomUUID();
  const next=recordSigningAction(row.data,row.guardrails,{...input,id:actionId,actorId:ctx.userId,actorPersonId:actor.person_id,actorName:actor.name,at:new Date().toISOString()});
  const action=next.actions.find(a=>a.id===actionId);
  if(!action)throw new SigningError('conflict','The signature could not be recorded.');
  const [result]=await tx.execute<{document:SigningDocument}>(sql`select app.document_signing_act(${row.id}::uuid,${JSON.stringify(action)}::text::jsonb) as document`);
  return result.document;
}
export async function reviseSigningDocumentTx(tx:SqlExecutor,ctx:SessionContext,input:{id:string;hash:string;reason:string;route?:SigningRoute}):Promise<SigningDocument>{
  if(!input.reason.trim())throw new SigningError('invalid','Explain why the signed content is being revised.');
  const row=await load(tx,ctx,input.id);
  // Template-routing documents: only the owner or the pending Review step may edit, and never after the first signature.
  if(row.data.routing&&!canEditSigningContent(row.data,ctx.userId??null))throw new SigningError('forbidden','The content is locked or it is not your turn to edit it.');
  const route=input.route?await hydrateRoute(tx,ctx,input.route):undefined;
  if(route)validateSigningRoute(route,row.guardrails);
  const next=reviseSigningDocument(row.data,input.hash,route);
  await store(tx,row,next,'revise',input.reason);return next;
}
export async function replaceDocumentSignerTx(tx:SqlExecutor,ctx:SessionContext,input:{id:string;stepId:string;holderId:string;reason:string;kind:'delegation'|'holder_changed'|'missing_holder'}):Promise<SigningDocument>{
  const row=await load(tx,ctx,input.id);
  const route=await hydrateRoute(tx,ctx,{version:1,steps:[{id:input.stepId,role:'replacement',kind:'sign',stage:0,required:true,holderId:input.holderId}]});
  const next=replacePendingSigner(row.data,row.guardrails,{...input,holderPersonId:route.steps[0].holderPersonId});
  await store(tx,row,next,'reroute',input.reason);return next;
}
export async function declineDocumentAcknowledgementTx(tx:SqlExecutor,ctx:SessionContext,input:{id:string;stepId:string;reason:string}):Promise<SigningDocument>{
  if(!ctx.userId)throw new SigningError('forbidden','Sign in before confirming an acknowledgement refusal.');
  const row=await load(tx,ctx,input.id);
  const [actor]=await tx.execute<{name:string;person_id:string}>(sql`select p.full_name as name,p.id as person_id from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)`);
  if(!actor)throw new SigningError('forbidden','The verified confirmer is unavailable.');
  const next=recordAcknowledgementDecline(row.data,{...input,id:randomUUID(),actorId:ctx.userId,actorPersonId:actor.person_id,actorName:actor.name,at:new Date().toISOString()});
  const [result]=await tx.execute<{document:SigningDocument}>(sql`select app.document_signing_act(${row.id}::uuid,${JSON.stringify(next.actions.at(-1))}::text::jsonb) as document`);
  return result.document;
}
/** The owner sends a returned template-routing document round again unchanged; the routing restarts at its first stage. */
export async function resendSigningDocumentTx(tx:SqlExecutor,ctx:SessionContext,input:{id:string;actionId?:string;comment?:string}):Promise<SigningDocument>{
  if(!ctx.userId)throw new SigningError('forbidden','Sign in before sending the document round again.');
  const row=await load(tx,ctx,input.id);
  const [actor]=await tx.execute<{name:string;person_id:string}>(sql`select p.full_name as name,p.id as person_id from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)`);
  if(!actor)throw new SigningError('forbidden','The verified sender is unavailable.');
  const actionId=input.actionId??randomUUID();
  const next=resendSigningDocument(row.data,{id:actionId,actorId:ctx.userId,actorPersonId:actor.person_id,actorName:actor.name,comment:input.comment,at:new Date().toISOString()});
  const action=next.actions.find(a=>a.id===actionId);
  if(!action)throw new SigningError('conflict','The document could not be sent round again.');
  const [result]=await tx.execute<{document:SigningDocument}>(sql`select app.document_signing_act(${row.id}::uuid,${JSON.stringify(action)}::text::jsonb) as document`);
  return result.document;
}
/**
 * Readers ask this before showing a document's content (routing and status stay visible to everyone with access).
 * The database answers from the stored document and the signed-in user; `released` comes from the subject.
 */
export async function signingContentVisibleTx(tx:SqlExecutor,id:string,released:boolean):Promise<boolean>{
  const [row]=await tx.execute<{visible:boolean}>(sql`select app.document_signing_content_visible(${id}::uuid,${released}) as visible`);
  return row?.visible===true;
}
async function store(tx:SqlExecutor,row:StoredDocument,next:SigningDocument,operation:'revise'|'reroute',reason:string):Promise<void>{
  await tx.execute(sql`select app.document_signing_store(${row.id}::uuid,${row.employment_id}::uuid,${row.company_id}::uuid,${row.subject_id}::uuid,${JSON.stringify(next)}::text::jsonb,${JSON.stringify(row.guardrails)}::text::jsonb,${row.revision},${operation},${reason})`);
}

async function hydrateRoute(tx:SqlExecutor,ctx:SessionContext,route:SigningRoute):Promise<SigningRoute>{
  if(!route.steps.length||route.steps.length>30)throw new SigningError('invalid','Choose a valid published signing route.');
  const ids=[...new Set(route.steps.flatMap(step=>step.holderId?[step.holderId]:[]))];
  const holders=ids.length?await tx.execute<{id:string;person_id:string}>(sql`select id,person_id from app_user where id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}) and tenant_id=${ctx.tenantId}::uuid and person_id is not null and archived_at is null and not app.login_blocked(id)`):[];
  const people=new Map(holders.map(holder=>[holder.id,holder.person_id]));
  return {...route,steps:route.steps.map(step=>{
    if(!step.holderId)return {...step,holderPersonId:undefined};
    const personId=people.get(step.holderId);
    if(!personId)throw new SigningError('invalid','The current signing holder is unavailable.');
    return {...step,holderPersonId:personId};
  })};
}


/** Adopt the exact native Probation route in one revision, preserving completed signatures. */
export async function refreshCanonicalProbationSigningRouteTx(tx:SqlExecutor,id:string):Promise<SigningDocument>{
 const [row]=await tx.execute<{data:SigningDocument}>(sql`select app.document_signing_refresh_probation(${id}::uuid) as data`);
 return row.data;
}
