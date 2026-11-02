import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {recordAcknowledgementDecline,recordSigningAction,replacePendingSigner,reviseSigningDocument,validateSigningRoute,SigningError,type SigningDocument,type SigningGuardrails,type SigningRoute} from '../../lib/document-signing-model';
export type {SigningDocument,SigningGuardrails,SigningRoute} from '../../lib/document-signing-model';
type StoredDocument={id:string;employment_id:string;company_id:string;subject_id:string;revision:number;data:SigningDocument;guardrails:SigningGuardrails};

/** Subject adapters own business eligibility; SQL independently rechecks actor and subject authority. */
async function load(tx:Tx,ctx:SessionContext,id:string):Promise<StoredDocument>{
  const [row]=await tx.execute<StoredDocument>(sql`select id,employment_id,company_id,subject_id,revision,data,guardrails from document_signing_document where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  if(!row)throw new SigningError('forbidden','This signing document is unavailable in your current scope.');
  return row;
}
export async function readSigningDocumentTx(tx:Tx,ctx:SessionContext,id:string):Promise<SigningDocument>{return(await load(tx,ctx,id)).data;}
export async function createSigningDocumentTx(tx:Tx,ctx:SessionContext,input:{companyId:string;employmentId:string;subjectId:string;subjectType:'probation';contentHash:string;route:SigningRoute;guardrails:SigningGuardrails}):Promise<{id:string;document:SigningDocument}>{
  if(!ctx.userId||!/^[a-f0-9]{64}$/.test(input.contentHash))throw new SigningError('invalid','Verified actor and signed content fingerprint are required.');
  const route=await hydrateRoute(tx,ctx,input.route);
  validateSigningRoute(route,input.guardrails);
  const id=randomUUID(),document:SigningDocument={tenantId:ctx.tenantId,companyId:input.companyId,subjectId:input.subjectId,subjectType:input.subjectType,contentRevision:1,contentHash:input.contentHash,route,actions:[]};
  await tx.execute(sql`select app.document_signing_store(${id}::uuid,${input.employmentId}::uuid,${input.companyId}::uuid,${input.subjectId}::uuid,${JSON.stringify(document)}::jsonb,${JSON.stringify(input.guardrails)}::jsonb,0,'create','Created signing route')`);
  return{id,document};
}
export async function recordDocumentSigningActionTx(tx:Tx,ctx:SessionContext,input:{id:string;actionId?:string;stepId:string;revision:number;hash:string;action:'signed'|'returned';comment?:string;method?:'typed'|'drawn';value?:string;consent?:boolean}):Promise<SigningDocument>{
  if(!ctx.userId)throw new SigningError('forbidden','Sign in before recording your signature.');
  const row=await load(tx,ctx,input.id);
  const [actor]=await tx.execute<{name:string;person_id:string}>(sql`select p.full_name as name,p.id as person_id from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)`);
  if(!actor)throw new SigningError('forbidden','The verified signer is unavailable.');
  const actionId=input.actionId??randomUUID();
  const next=recordSigningAction(row.data,row.guardrails,{...input,id:actionId,actorId:ctx.userId,actorPersonId:actor.person_id,actorName:actor.name,at:new Date().toISOString()});
  const action=next.actions.find(a=>a.id===actionId);
  if(!action)throw new SigningError('conflict','The signature could not be recorded.');
  const [result]=await tx.execute<{document:SigningDocument}>(sql`select app.document_signing_act(${row.id}::uuid,${JSON.stringify(action)}::jsonb) as document`);
  return result.document;
}
export async function reviseSigningDocumentTx(tx:Tx,ctx:SessionContext,input:{id:string;hash:string;reason:string;route?:SigningRoute}):Promise<SigningDocument>{
  if(!input.reason.trim())throw new SigningError('invalid','Explain why the signed content is being revised.');
  const row=await load(tx,ctx,input.id);
  const route=input.route?await hydrateRoute(tx,ctx,input.route):undefined;
  if(route)validateSigningRoute(route,row.guardrails);
  const next=reviseSigningDocument(row.data,input.hash,route);
  await store(tx,row,next,'revise',input.reason);return next;
}
export async function replaceDocumentSignerTx(tx:Tx,ctx:SessionContext,input:{id:string;stepId:string;holderId:string;reason:string;kind:'delegation'|'holder_changed'|'missing_holder'}):Promise<SigningDocument>{
  const row=await load(tx,ctx,input.id);
  const route=await hydrateRoute(tx,ctx,{version:1,steps:[{id:input.stepId,role:'replacement',kind:'sign',stage:0,required:true,holderId:input.holderId}]});
  const next=replacePendingSigner(row.data,row.guardrails,{...input,holderPersonId:route.steps[0].holderPersonId});
  await store(tx,row,next,'reroute',input.reason);return next;
}
export async function declineDocumentAcknowledgementTx(tx:Tx,ctx:SessionContext,input:{id:string;stepId:string;reason:string}):Promise<SigningDocument>{
  if(!ctx.userId)throw new SigningError('forbidden','Sign in before confirming an acknowledgement refusal.');
  const row=await load(tx,ctx,input.id);
  const [actor]=await tx.execute<{name:string;person_id:string}>(sql`select p.full_name as name,p.id as person_id from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)`);
  if(!actor)throw new SigningError('forbidden','The verified confirmer is unavailable.');
  const next=recordAcknowledgementDecline(row.data,{...input,id:randomUUID(),actorId:ctx.userId,actorPersonId:actor.person_id,actorName:actor.name,at:new Date().toISOString()});
  const [result]=await tx.execute<{document:SigningDocument}>(sql`select app.document_signing_act(${row.id}::uuid,${JSON.stringify(next.actions.at(-1))}::jsonb) as document`);
  return result.document;
}
async function store(tx:Tx,row:StoredDocument,next:SigningDocument,operation:'revise'|'reroute',reason:string):Promise<void>{
  await tx.execute(sql`select app.document_signing_store(${row.id}::uuid,${row.employment_id}::uuid,${row.company_id}::uuid,${row.subject_id}::uuid,${JSON.stringify(next)}::jsonb,${JSON.stringify(row.guardrails)}::jsonb,${row.revision},${operation},${reason})`);
}

async function hydrateRoute(tx:Tx,ctx:SessionContext,route:SigningRoute):Promise<SigningRoute>{
  const steps=[];
  for(const step of route.steps){
    if(!step.holderId){steps.push({...step,holderPersonId:undefined});continue;}
    const [holder]=await tx.execute<{person_id:string}>(sql`select person_id from app_user where id=${step.holderId}::uuid and tenant_id=${ctx.tenantId}::uuid and archived_at is null and not app.login_blocked(id)`);
    if(!holder)throw new SigningError('invalid','The current signing holder is unavailable.');
    steps.push({...step,holderPersonId:holder.person_id});
  }
  return {...route,steps};
}


/** Adopt the exact native Probation route in one revision, preserving completed signatures. */
export async function refreshCanonicalProbationSigningRouteTx(tx:Tx,id:string):Promise<SigningDocument>{
 const [row]=await tx.execute<{data:SigningDocument}>(sql`select app.document_signing_refresh_probation(${id}::uuid) as data`);
 return row.data;
}
