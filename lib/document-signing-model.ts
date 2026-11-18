import {validV9SignatureValue} from './lifecycle-v9-signature';

/**
 * Generic content-bound signing. Subject owners supply policy, scope and current holders.
 *
 * Template routing (ADR 2026-11-15-probation-shared-automation, build step 3; handoff A2): a document generated from a
 * template version whose signing and review routing is not empty carries `routing`. Only such documents use the owner,
 * send-back/re-send, edit-lock and visibility rules below and the no-signature `reviewed` / `approved` actions. A
 * document without `routing` behaves exactly as before.
 *
 * Send back extends the existing `returned` action: a return at the current content revision stops the routing and hands
 * the document to its owner. The owner either revises the content (a new revision starts the routing from its first
 * stage, as before) or re-sends it unchanged with a `resent` action. Every action before the latest `resent` of the
 * current revision belongs to an earlier round and no longer counts, so a send-back clears all completed steps,
 * signatures included. History is never removed.
 */
export type SigningStepKind = 'sign' | 'acknowledge' | 'approve' | 'review';
export const SIGNING_STEP_KINDS: readonly SigningStepKind[] = ['sign', 'acknowledge', 'approve', 'review'];
export type SigningStep = {
  id: string; role: string; kind: SigningStepKind; stage: number;
  holderId: string | null; holderPersonId?: string; representedId?: string; required: boolean;
  coveredStepIds?: string[]; coveredByStepId?: string;
  /** "Owns the document": send-backs return to this step's holder. At most one step. */
  owner?: boolean;
  /** Set when nobody resolved and the fallback group took the step: who the step was meant for. */
  meantFor?: string;
  /**
   * `false` on an Approve step that records a decision without a signature on a document without template routing
   * (Probation form approval rows, migration 5756). Absent: an Approve step signs, as before.
   */
  signature?: false;
  /** Display name of who the step was routed to (a routing or assignment group name), frozen with the route. */
  label?: string;
};
export type SigningRoute = {version: number; steps: SigningStep[]};
export type SigningGuardrails = {requiredRoles: string[]; independentApprovalFromRole?: string};
export type SigningActionKind = 'signed' | 'returned' | 'declined' | 'reviewed' | 'approved' | 'resent';
export type SigningAction = {
  id: string; stepId: string; contentRevision: number; contentHash: string;
  actorId: string; actorPersonId: string; actorName: string; representedId: string; role: string;
  at: string; action: SigningActionKind; comment: string;
  coveredStepIds?: string[];
  signature: {method: 'typed' | 'drawn'; value: string; consent: true} | null;
};
/** Frozen at generation from the template version's routing; the subject adapter supplies the case owner. */
export type SigningRoutingMeta = {
  templateId: string; templateVersion: number;
  /** Last owner fallback: the case owner named by the subject adapter (for Probation, the PBP). */
  caseOwnerId: string | null;
  fallbackGroupId?: string | null;
  /** Contract merge fields stay live until first signature. Text revisions still invalidate every receipt. */
  liveMergeReviews?: boolean;
};
export type SigningDocument = {
  tenantId: string; companyId: string; subjectId: string; subjectType: string;
  contentRevision: number; contentHash: string; route: SigningRoute; actions: SigningAction[];
  routing?: SigningRoutingMeta;
};
export class SigningError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'conflict', message: string) {super(message);this.name='SigningError';}
}
const invalid = (message: string): never => {throw new SigningError('invalid',message);};
export function validateSigningRoute(route: SigningRoute, rules: SigningGuardrails): void {
  if (!Number.isSafeInteger(route.version) || route.version < 1 || !route.steps.length || route.steps.length > 30) invalid('Choose a valid published signing route.');
  const ids=new Set<string>();
  for (const step of route.steps) {
    if (!step.id || ids.has(step.id) || !step.role || !Number.isSafeInteger(step.stage) || step.stage < 0 || !SIGNING_STEP_KINDS.includes(step.kind)) invalid('Every signing step needs a unique identity, role and stage.');
    if (step.owner !== undefined && typeof step.owner !== 'boolean') invalid('Every signing step needs a unique identity, role and stage.');
    if (step.signature !== undefined && (step.signature !== false || step.kind !== 'approve')) invalid('Every signing step needs a unique identity, role and stage.');
    ids.add(step.id);
  }
  if (route.steps.filter(step=>step.owner).length>1) invalid('Only one step can own the document.');
  for(const step of route.steps){
    const covered=step.coveredStepIds??[];
    if(covered.length>1||covered.length&&step.coveredByStepId)invalid('One approval can cover one adjacent approval role.');
    if(step.coveredByStepId&&!route.steps.some(owner=>owner.id===step.coveredByStepId&&owner.coveredStepIds?.includes(step.id)))invalid('A covered role must name its actual signing step.');
    for(const id of covered){
      const target=route.steps.find(candidate=>candidate.id===id);
      if(!target||target.coveredByStepId!==step.id||!step.required||!target.required||step.kind!=='approve'||target.kind!=='approve'||step.role===target.role||!step.holderId||step.holderId!==target.holderId||!step.holderPersonId||step.holderPersonId!==target.holderPersonId||step.stage>=target.stage||route.steps.some(candidate=>candidate.required&&candidate.id!==step.id&&candidate.id!==target.id&&candidate.stage>=step.stage&&candidate.stage<=target.stage))invalid('A combined action requires adjacent approval roles held by the same verified person.');
    }
  }
  for (const role of rules.requiredRoles) if (!route.steps.some(s=>s.role===role&&s.required)) invalid('The required '+role+' signing step cannot be removed.');
  if (rules.independentApprovalFromRole) {
    const owner=route.steps.find(s=>s.role===rules.independentApprovalFromRole&&s.required);
    const independent=route.steps.filter(s=>s.kind==='approve'&&s.required&&s.role!==rules.independentApprovalFromRole);
    if (!owner || !independent.length) throw new SigningError('invalid','An independent approving person is required.');
    if (owner.holderId && independent.every(s=>s.holderId!==null&&(s.holderId===owner.holderId||Boolean(owner.holderPersonId)&&s.holderPersonId===owner.holderPersonId))) invalid('The approving person must be different from the submitting manager.');
  }
}
const atCurrentContent=(action:SigningAction,document:SigningDocument)=>action.contentRevision===document.contentRevision&&(
 action.contentHash===document.contentHash||document.subjectType==='contract'&&document.routing?.liveMergeReviews===true&&action.signature===null&&['reviewed','approved','returned','resent'].includes(action.action)
);
// Managed Resignation has its own native exact-content round and required-step admission rules.
// Its template metadata does not opt it into native lifecycle returned-custody semantics.
const usesNativeRoutingRules=(document:SigningDocument)=>Boolean(document.routing)&&document.subjectType!=='resignation';
/** Actions of the current round: current content, after the latest re-send of that content. */
export function currentRoundActions(document: SigningDocument): SigningAction[] {
  let start=0;
  for(let index=0;index<document.actions.length;index++){
    const action=document.actions[index];
    if(usesNativeRoutingRules(document)){if(action.action==='returned')start=index;else if(action.action==='resent')start=index+1;}
    else if(atCurrentContent(action,document)&&action.action==='resent')start=index+1;
  }
  const boundary=document.actions[start];
  if(usesNativeRoutingRules(document)&&boundary?.action==='returned')return [boundary];
  return document.actions.slice(start).filter(action=>atCurrentContent(action,document));
}
/** The send-back that currently holds the document with its owner, or null. */
export function signingSendBack(document: SigningDocument): SigningAction | null {
  // Editing a returned Contract letter changes its content revision, but sending it round again stays explicit.
  if(document.subjectType==='contract'&&document.routing?.liveMergeReviews){
    const marker=[...document.actions].reverse().find(action=>action.action==='returned'||action.action==='resent');
    if(marker?.action==='returned')return marker;
  }
  return currentRoundActions(document).find(action=>action.action==='returned')??null;
}
function actionFulfilsStep(action:SigningAction,step:SigningStep):boolean{
  if(action.action==='declined')return action.stepId===step.id&&step.kind==='acknowledge';
  if(action.action==='reviewed')return action.stepId===step.id&&step.kind==='review';
  if(action.action==='approved')return action.stepId===step.id&&step.kind==='approve';
  return action.action==='signed'&&(action.stepId===step.id||action.coveredStepIds?.includes(step.id)===true);
}
export function signingStepFulfilled(document: SigningDocument, step: SigningStep): boolean {
  return currentRoundActions(document).some(action=>actionFulfilsStep(action,step));
}
/** Missing holders block; one real approval can fulfil its explicitly covered adjacent role. Steps sharing a stage act in parallel. */
export function pendingSigningSteps(document: SigningDocument): SigningStep[] {
  if(signingSendBack(document))return [];
  const remaining=document.route.steps.filter(step=>!signingStepFulfilled(document,step));
  const stage=Math.min(...remaining.filter(step=>step.required).map(step=>step.stage));
  // Optional routed steps may act alongside/before the next required stage, but never delay it.
  // Managed Resignation and routes without template routing keep their required-only queue.
  return remaining.filter(step=>!step.coveredByStepId&&Number.isFinite(stage)&&(step.required?step.stage===stage:usesNativeRoutingRules(document)&&step.stage<=stage));
}
export function signingComplete(document: SigningDocument, rules: SigningGuardrails): boolean {
  validateSigningRoute(document.route,rules);
  if(document.route.steps.some(step=>step.required&&!signingStepFulfilled(document,step)))return false;
  if(signingSendBack(document))return false;
  if (rules.independentApprovalFromRole) {
    const current=currentRoundActions(document).filter(a=>a.action==='signed'||a.action==='approved');
    const manager=current.find(a=>a.action==='signed'&&a.role===rules.independentApprovalFromRole);
    if (!manager?.actorPersonId || !current.some(a=>Boolean(a.actorPersonId)&&a.actorPersonId!==manager.actorPersonId&&document.route.steps.some(s=>s.id===a.stepId&&s.kind==='approve'))) return false;
  }
  return true;
}
/**
 * The action a step takes. Template-routing documents record Review and Approve as decisions without a signature; so
 * does an Approve step marked `signature: false` (a Probation form "Approve" row).
 */
export function signingStepAction(document: SigningDocument, step: Pick<SigningStep,'kind'|'signature'>): 'signed' | 'reviewed' | 'approved' {
  if(step.kind==='review')return 'reviewed';
  if(step.kind==='approve'&&(document.routing||step.signature===false))return 'approved';
  return 'signed';
}
/** Review and Approve steps belong in approval queues; Sign and acknowledgement steps in task queues (handoff B5). */
export function signingStepQueue(step: Pick<SigningStep,'kind'>): 'approvals' | 'tasks' {
  return step.kind==='review'||step.kind==='approve'?'approvals':'tasks';
}
export function recordSigningAction(document: SigningDocument, rules: SigningGuardrails, input: {
  id: string; actorId: string; actorPersonId: string; actorName: string; stepId: string; revision: number; hash: string;
  action: 'signed' | 'returned' | 'reviewed' | 'approved'; comment?: string; method?: 'typed' | 'drawn'; value?: string; consent?: boolean; at: string;
}): SigningDocument {
  validateSigningRoute(document.route,rules);
  if (input.revision!==document.contentRevision || input.hash!==document.contentHash) throw new SigningError('conflict','This document changed. Read the current revision before signing.');
  if (document.actions.some(a=>a.id===input.id)) {
    const prior=document.actions.find(a=>a.id===input.id)!;
    if (prior.actorId===input.actorId&&prior.actorPersonId===input.actorPersonId&&prior.stepId===input.stepId&&prior.contentHash===input.hash&&prior.contentRevision===input.revision&&prior.action===input.action&&prior.comment===(input.comment?.trim()??'')&&(input.action!=='signed'||prior.signature?.method===input.method&&prior.signature?.value===input.value&&input.consent===true)) return document;
    throw new SigningError('conflict','This action reference was already used.');
  }
  const steps=input.action==='returned'&&usesNativeRoutingRules(document)&&!signingSendBack(document)?document.route.steps:pendingSigningSteps(document);
  const step=steps.find(s=>s.id===input.stepId);
  if (!step || !step.holderId || step.holderId!==input.actorId) throw new SigningError('forbidden','Only the current assigned signer can act at this step.');
  if (!input.actorPersonId || !input.actorName.trim() || !Number.isFinite(Date.parse(input.at))) invalid('The verified signer and action time are required.');
  if (input.action==='returned'&&!input.comment?.trim()) invalid('Explain why the review is being returned.');
  if (input.action!=='returned'&&input.action!==signingStepAction(document,step)) invalid('This step takes a different action.');
  if (input.action==='signed'&&(!input.consent||!input.method||!validV9SignatureValue(input.method,input.value??''))) invalid('Enter your signature and confirm consent.');
  const action: SigningAction={id:input.id,stepId:step.id,contentRevision:input.revision,contentHash:input.hash,actorId:input.actorId,actorPersonId:input.actorPersonId,actorName:input.actorName,representedId:step.representedId??step.holderId,role:step.role,at:input.at,action:input.action,comment:input.comment?.trim()??'',...(input.action==='signed'&&step.coveredStepIds?.length?{coveredStepIds:[...step.coveredStepIds]}:{}),signature:input.action==='signed'?{method:input.method!,value:input.value!,consent:true}:null};
  const next={...document,actions:[...document.actions,action]};
  if (rules.independentApprovalFromRole&&step.kind==='approve') {
    const manager=currentRoundActions(next).find(a=>a.action==='signed'&&a.role===rules.independentApprovalFromRole);
    if (manager?.actorPersonId===input.actorPersonId&&!document.route.steps.some(s=>s.required&&s.kind==='approve'&&s.holderId!==null&&s.holderPersonId!==undefined&&s.holderPersonId!==input.actorPersonId)) throw new SigningError('forbidden','A distinct person must approve this review.');
  }
  return next;
}
/** Only the subject owner's recorded refusal-confirmation path may invoke this transition. */
export function recordAcknowledgementDecline(document:SigningDocument,input:{id:string;stepId:string;actorId:string;actorPersonId:string;actorName:string;reason:string;at:string}):SigningDocument{
  const step=pendingSigningSteps(document).find(s=>s.id===input.stepId);
  if(!step||step.kind!=='acknowledge'||!step.holderId)throw new SigningError('conflict','Only the pending employee acknowledgement can be recorded as declined.');
  if(!input.reason.trim()||!input.actorId||!input.actorPersonId||input.actorId===step.holderId||input.actorPersonId===step.holderPersonId||!input.actorName.trim()||!Number.isFinite(Date.parse(input.at)))invalid('A recorded refusal reason and independent confirmation are required.');
  if(document.actions.some(a=>a.id===input.id))throw new SigningError('conflict','This refusal action reference was already used.');
  const action:SigningAction={id:input.id,stepId:step.id,contentRevision:document.contentRevision,contentHash:document.contentHash,actorId:input.actorId,actorPersonId:input.actorPersonId,actorName:input.actorName,representedId:step.holderId,role:step.role,at:input.at,action:'declined',comment:input.reason.trim(),signature:null};
  return{...document,actions:[...document.actions,action]};
}
export function reviseSigningDocument(document: SigningDocument, hash: string, route?:SigningRoute): SigningDocument {
  if (!/^[a-f0-9]{64}$/.test(hash)||hash===document.contentHash) invalid('A new content fingerprint is required.');
  return {...document,contentRevision:document.contentRevision+1,contentHash:hash,...(route?{route:structuredClone(route)}:{})};
}
export function replacePendingSigner(document: SigningDocument, rules: SigningGuardrails, input: {stepId:string;holderId:string;holderPersonId?:string;reason:string;kind:'delegation'|'holder_changed'|'missing_holder'}): SigningDocument {
  if (!input.holderId||!input.reason.trim()||!['delegation','holder_changed','missing_holder'].includes(input.kind)) invalid('A replacement holder and recorded reason are required.');
  const step=document.route.steps.find(s=>s.id===input.stepId);
  if (!step||signingStepFulfilled(document,step)) throw new SigningError('conflict','Completed signatures cannot be reassigned.');
  const next={...document,route:{...document.route,steps:document.route.steps.map(s=>s.id===step.id?{...s,holderId:input.holderId,holderPersonId:input.holderPersonId,representedId:input.kind==='delegation'?(s.representedId??s.holderId??undefined):undefined}:s)}};
  validateSigningRoute(next.route,rules);
  return next;
}

/**
 * Who owns the document: the step flagged "Owns the document"; with none flagged, the first Review step (lowest stage,
 * then route order); otherwise the case owner named by the subject adapter. Send-backs return to the owner.
 */
export function signingDocumentOwner(document: SigningDocument): {stepId: string | null; userId: string | null} {
  const flagged=document.route.steps.find(step=>step.owner);
  if(flagged)return{stepId:flagged.id,userId:flagged.holderId??(document.subjectType==='contract'||!usesNativeRoutingRules(document)?null:document.routing?.caseOwnerId??null)};
  const review=document.route.steps.map((step,index)=>({step,index})).filter(x=>x.step.kind==='review'||document.subjectType==='contract'&&x.step.kind==='approve').sort((a,b)=>a.step.stage-b.step.stage||a.index-b.index)[0]?.step;
  if(review)return{stepId:review.id,userId:review.holderId??(document.subjectType==='contract'||!usesNativeRoutingRules(document)?null:document.routing?.caseOwnerId??null)};
  return{stepId:null,userId:document.routing?.caseOwnerId??null};
}
/** True once a signature lands in the current round. Then the content is locked for everyone until a send-back. */
export function signingContentLocked(document: SigningDocument): boolean {
  return !signingSendBack(document)&&currentRoundActions(document).some(action=>action.action==='signed');
}
/**
 * Editing rights on a template-routing document: the owner, and the holder of a Review step whose turn it is, may edit
 * until the first signature; while a send-back holds the document only the owner may edit; Sign and Approve steps never
 * edit. Documents without template routing keep their subject's own rule (this returns false for them).
 */
export function canEditSigningContent(document: SigningDocument, userId: string | null): boolean {
  if(!document.routing||!userId)return false;
  const owner=signingDocumentOwner(document).userId;
  if(signingSendBack(document))return owner===userId;
  const pending=pendingSigningSteps(document);
  if(signingContentLocked(document)||!pending.length)return false;
  return owner===userId||pending.some(step=>step.kind==='review'&&step.holderId===userId);
}
/**
 * Visibility of the content (handoff A2): a template-routing document is private until it reaches you. You see it when
 * it is your turn, once you have acted on it, or after release; the owner always sees it. Everyone else with access to
 * the subject sees the routing and status only. Documents without template routing are visible as before.
 */
export function signingContentVisible(document: SigningDocument, userId: string | null, options: {released: boolean}): boolean {
  if(!document.routing||options.released)return true;
  if(!userId)return false;
  if(signingDocumentOwner(document).userId===userId)return true;
  if(document.actions.some(action=>action.actorId===userId))return true;
  return pendingSigningSteps(document).some(step=>step.holderId===userId);
}
/** The owner re-sends a returned document unchanged. The routing restarts at its first stage; every earlier action stops counting. */
export function resendSigningDocument(document: SigningDocument, input: {id:string;actorId:string;actorPersonId:string;actorName:string;comment?:string;at:string}): SigningDocument {
  const prior=document.actions.find(a=>a.id===input.id);
  if(prior){if(prior.action==='resent'&&prior.actorId===input.actorId&&prior.contentRevision===document.contentRevision&&prior.contentHash===document.contentHash)return document;throw new SigningError('conflict','This action reference was already used.');}
  if(!document.routing||!signingSendBack(document))throw new SigningError('conflict','Only a document that was sent back can be sent round again.');
  const owner=signingDocumentOwner(document);
  if(!owner.userId||owner.userId!==input.actorId)throw new SigningError('forbidden','Only the owner of the document can send it round again.');
  if(!input.actorPersonId||!input.actorName.trim()||!Number.isFinite(Date.parse(input.at)))invalid('The verified sender and action time are required.');
  const action:SigningAction={id:input.id,stepId:owner.stepId??'owner',contentRevision:document.contentRevision,contentHash:document.contentHash,actorId:input.actorId,actorPersonId:input.actorPersonId,actorName:input.actorName,representedId:input.actorId,role:'owner',at:input.at,action:'resent',comment:input.comment?.trim()??'',signature:null};
  return{...document,actions:[...document.actions,action]};
}
