/** V9 subject adapter over the shared deterministic signing kernel. State stays on the saved document. */
import type {Document,Case,TemplateVersion,Environment,Signature} from './lifecycle-v9-model';
import {V9Error,personnelFieldSourceValue} from './lifecycle-v9-model';
import {canEditSigningContent,signingContentLocked,currentRoundActions,recordSigningAction,resendSigningDocument,reviseSigningDocument,signingComplete,signingSendBack,signingStepFulfilled,validateSigningRoute,type SigningDocument,type SigningRoute,type SigningAction} from './document-signing-model';
import type {DocumentRouting,DocumentRoutingUnresolved} from './document-signing-routing';

export type V9DocumentRoutingEnvironment={tenantId:string;personnelSource?:Record<string,string>;sourceUnavailable?:boolean;hash:(content:string)=>string;resolve:(routing:DocumentRouting)=>{route:SigningRoute;unresolved:DocumentRoutingUnresolved[]}};
export const V9_DOCUMENT_SIGNING_RULES={requiredRoles:[]};
/** PostgreSQL jsonb text ordering and spacing, over the bounded string/boolean/integer content shape.
 * The database independently hashes the same source object before accepting every action or edit. */
export function v9SigningCanonicalText(value:unknown):string{
 if(value===null||typeof value!=='object'){const text=JSON.stringify(value);if(text===undefined)throw new V9Error('Document content is unavailable.');return text;}
 if(Array.isArray(value))return '['+value.map(v9SigningCanonicalText).join(', ')+']';
 const bytes=(key:string)=>new TextEncoder().encode(key);
 const compare=(a:string,b:string)=>{const x=bytes(a),y=bytes(b);if(x.length!==y.length)return x.length-y.length;for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
 return '{'+Object.keys(value).filter(key=>Reflect.get(value,key)!==undefined).sort(compare).map(key=>JSON.stringify(key)+': '+v9SigningCanonicalText(Reflect.get(value,key))).join(', ')+'}';
}
export function v9DocumentSigningContent(document:Document){return {templateId:document.templateId,version:document.version,blocks:document.blocks,fields:document.fields,values:document.values,edits:document.edits,mergeValues:document.mergeValues??{},...(document.personnelSourceReference?{personnelSourceReference:document.personnelSourceReference}:{})};}
export function initializeV9DocumentRouting(c:Case,version:TemplateVersion,document:Document,env:Environment){
 if(!version.routing?.length)return;
 if(!env.documentRouting)throw new V9Error('Signing route resolution is unavailable.','conflict');
 if(env.documentRouting.sourceUnavailable)throw new V9Error('The current authorized Personnel source is unavailable. Review the case before generating this document.','conflict');
 if(env.documentRouting.personnelSource){const source=Object.fromEntries(Object.entries(env.documentRouting.personnelSource).filter(([key])=>!key.startsWith('_')));document.mergeValues={...document.mergeValues,...source};for(const field of document.fields)if(field.pmKey&&Object.hasOwn(source,field.pmKey))document.values[field.id]=personnelFieldSourceValue(field,source);}
 // Persist only the source values this document uses; signing participation grants no unrelated Personnel data.
 const used=new Set(document.fields.flatMap(field=>field.pmKey?[field.pmKey]:[]));
 for(const block of document.blocks){for(const match of [block.text,block.rows??'',block.label??''].join(' ').matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?)\}/g))used.add(match[1]);if(block.type==='letterhead')for(const key of ['company.name','company.regNo','company.address','company.color'])used.add(key);}
 const source=env.documentRouting.personnelSource;
 if(source&&['employee.department','employee.position','employee.supervisor','case.dept','case.position','case.supervisor','case.group','employee.businessUnit'].some(key=>used.has(key))){if(!['current','exit-boundary','draft'].includes(source._sourceBasis))throw new V9Error('The dated Personnel source requires review.','conflict');document.personnelSourceReference={version:1,basis:source._sourceBasis as 'current'|'exit-boundary'|'draft',asOf:source._sourceAsOf,assignmentId:source._assignmentId??null,reportingLineId:source._reportingLineId??null,exitEventId:source._exitEventId??null};}
 if(env.documentRouting.personnelSource?._identityFieldsWithheld==='true'&&['personalEmail','employee.icNo','employee.passportNo','icNo','passportNo','case.icNo','case.passportNo'].some(key=>used.has(key)))throw new V9Error('Permission to view protected Personnel identity fields is required for this document.','forbidden');
 document.mergeValues=Object.fromEntries(Object.entries(document.mergeValues??{}).filter(([key])=>used.has(key)));
 const resolved=env.documentRouting.resolve(version.routing);validateSigningRoute(resolved.route,V9_DOCUMENT_SIGNING_RULES);
 document.routing=structuredClone(version.routing);document.routingUnresolved=resolved.unresolved;
 document.signing={tenantId:env.documentRouting.tenantId,companyId:c.facts.company,subjectId:document.id,subjectType:'lifecycle_v9',contentRevision:1,contentHash:env.documentRouting.hash(v9SigningCanonicalText(v9DocumentSigningContent(document))),route:structuredClone(resolved.route),actions:[],routing:{templateId:document.templateId,templateVersion:document.version,caseOwnerId:c.facts.starterUserId??(env.eligibleUser(env.actor.id)?env.actor.id:null),fallbackGroupId:null}};
}
export function v9RouteReadyForEmployee(document:Document){
 if(!document.signing)return true;
 if(signingSendBack(document.signing))return false;
 const employeeStage=Math.min(...document.signing.route.steps.filter(step=>step.role==='employee').map(step=>step.stage));
 return document.signing.route.steps.filter(step=>step.required&&step.role!=='employee'&&step.stage<employeeStage).every(step=>signingStepFulfilled(document.signing!,step));
}
export function v9RoutedHrComplete(document:Document){const signing=document.signing;if(!signing||signingSendBack(signing))return false;const signed=new Set(currentRoundActions(signing).filter(action=>action.action==='signed').map(action=>action.stepId));return signing.route.steps.some(step=>step.role!=='employee'&&['sign','acknowledge'].includes(step.kind)&&signed.has(step.id))&&signing.route.steps.filter(step=>step.required&&step.role!=='employee').every(step=>signingStepFulfilled(signing,step));}
export function reviseV9DocumentRouting(document:Document,env:Environment,employeeFields=false){
 if(!document.signing)return;
 const employeeEdit=employeeFields&&!signingContentLocked(document.signing)&&document.signing.route.steps.some(step=>step.role==='employee'&&step.holderId===env.actor.id);
 if((!canEditSigningContent(document.signing,env.actor.id)&&!employeeEdit)||!env.documentRouting)throw new V9Error('The document is locked or it is not your turn to edit.','forbidden');
 const hash=env.documentRouting.hash(v9SigningCanonicalText(v9DocumentSigningContent(document)));
 if(hash!==document.signing.contentHash)document.signing=reviseSigningDocument(document.signing,hash);
 synchronizeV9SigningPresentation(document);
}
export function synchronizeV9SigningPresentation(document:Document){
 const signing=document.signing;if(!signing)return;
 const actions=signingSendBack(signing)?[]:currentRoundActions(signing);
 document.stepSignatures=Object.fromEntries(actions.filter(action=>action.action==='signed'&&action.signature).map(action=>[action.stepId,{by:{id:action.actorId,name:action.actorName},at:action.at,...action.signature!} satisfies Signature]));
 document.hrSignature=null;document.employeeSignature=null;
 if(signingComplete(signing,V9_DOCUMENT_SIGNING_RULES))document.status='signed';
 else if(!['withdrawn','superseded'].includes(document.status))document.status=document.sentAt?'opened':'draft';
}
export function recordV9DocumentRouteAction(document:Document,input:{id:string;stepId:string;revision:number;hash:string;action:'signed'|'returned'|'reviewed'|'approved'|'resent';comment?:string;signature?:Pick<Signature,'method'|'value'|'consent'>},actor:{id:string;personId:string;name:string},at:string):SigningAction{
 if(!document.signing)throw new V9Error('This document uses its existing signing process.','conflict');
 const next=input.action==='resent'?resendSigningDocument(document.signing,{id:input.id,actorId:actor.id,actorPersonId:actor.personId,actorName:actor.name,comment:input.comment,at}):recordSigningAction(document.signing,V9_DOCUMENT_SIGNING_RULES,{id:input.id,stepId:input.stepId,revision:input.revision,hash:input.hash,action:input.action,actorId:actor.id,actorPersonId:actor.personId,actorName:actor.name,comment:input.comment,at,...input.signature});
 const action=next.actions.find(action=>action.id===input.id)!;document.signing=next;synchronizeV9SigningPresentation(document);return action;
}
