import {validV9SignatureValue} from './lifecycle-v9-signature';

/** Generic content-bound signing. Subject owners supply policy, scope and current holders. */
export type SigningStep = {
  id: string; role: string; kind: 'sign' | 'acknowledge' | 'approve'; stage: number;
  holderId: string | null; holderPersonId?: string; representedId?: string; required: boolean;
};
export type SigningRoute = {version: number; steps: SigningStep[]};
export type SigningGuardrails = {requiredRoles: string[]; independentApprovalFromRole?: string};
export type SigningAction = {
  id: string; stepId: string; contentRevision: number; contentHash: string;
  actorId: string; actorPersonId: string; actorName: string; representedId: string; role: string;
  at: string; action: 'signed' | 'returned' | 'declined'; comment: string;
  signature: {method: 'typed' | 'drawn'; value: string; consent: true} | null;
};
export type SigningDocument = {
  tenantId: string; companyId: string; subjectId: string; subjectType: string;
  contentRevision: number; contentHash: string; route: SigningRoute; actions: SigningAction[];
};
export class SigningError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'conflict', message: string) {super(message);this.name='SigningError';}
}
const invalid = (message: string): never => {throw new SigningError('invalid',message);};
export function validateSigningRoute(route: SigningRoute, rules: SigningGuardrails): void {
  if (!Number.isSafeInteger(route.version) || route.version < 1 || !route.steps.length || route.steps.length > 30) invalid('Choose a valid published signing route.');
  const ids=new Set<string>();
  for (const step of route.steps) {
    if (!step.id || ids.has(step.id) || !step.role || !Number.isSafeInteger(step.stage) || step.stage < 0 || !['sign','acknowledge','approve'].includes(step.kind)) invalid('Every signing step needs a unique identity, role and stage.');
    ids.add(step.id);
  }
  for (const role of rules.requiredRoles) if (!route.steps.some(s=>s.role===role&&s.required)) invalid('The required '+role+' signing step cannot be removed.');
  if (rules.independentApprovalFromRole) {
    const owner=route.steps.find(s=>s.role===rules.independentApprovalFromRole&&s.required);
    const independent=route.steps.filter(s=>s.kind==='approve'&&s.required&&s.role!==rules.independentApprovalFromRole);
    if (!owner || !independent.length) throw new SigningError('invalid','An independent approving person is required.');
    if (owner.holderId && independent.every(s=>s.holderId!==null&&(s.holderId===owner.holderId||Boolean(owner.holderPersonId)&&s.holderPersonId===owner.holderPersonId))) invalid('The approving person must be different from the submitting manager.');
  }
}
/** Missing holders block; they never silently turn a required step into a skipped step. */
export function pendingSigningSteps(document: SigningDocument): SigningStep[] {
  const signed=new Set(document.actions.filter(a=>a.contentRevision===document.contentRevision&&a.contentHash===document.contentHash&&(a.action==='signed'||a.action==='declined'&&document.route.steps.some(s=>s.id===a.stepId&&s.kind==='acknowledge'))).map(a=>a.stepId));
  const remaining=document.route.steps.filter(s=>s.required&&!signed.has(s.id));
  const stage=Math.min(...remaining.map(s=>s.stage));
  return remaining.filter(s=>s.stage===stage);
}
export function signingComplete(document: SigningDocument, rules: SigningGuardrails): boolean {
  validateSigningRoute(document.route,rules);
  if (pendingSigningSteps(document).length) return false;
  if (rules.independentApprovalFromRole) {
    const current=document.actions.filter(a=>a.action==='signed'&&a.contentRevision===document.contentRevision&&a.contentHash===document.contentHash);
    const manager=current.find(a=>a.role===rules.independentApprovalFromRole);
    if (!manager?.actorPersonId || !current.some(a=>Boolean(a.actorPersonId)&&a.actorPersonId!==manager.actorPersonId&&document.route.steps.some(s=>s.id===a.stepId&&s.kind==='approve'))) return false;
  }
  return true;
}
export function recordSigningAction(document: SigningDocument, rules: SigningGuardrails, input: {
  id: string; actorId: string; actorPersonId: string; actorName: string; stepId: string; revision: number; hash: string;
  action: 'signed' | 'returned'; comment?: string; method?: 'typed' | 'drawn'; value?: string; consent?: boolean; at: string;
}): SigningDocument {
  validateSigningRoute(document.route,rules);
  if (input.revision!==document.contentRevision || input.hash!==document.contentHash) throw new SigningError('conflict','This document changed. Read the current revision before signing.');
  if (document.actions.some(a=>a.id===input.id)) {
    const prior=document.actions.find(a=>a.id===input.id)!;
    if (prior.actorId===input.actorId&&prior.actorPersonId===input.actorPersonId&&prior.stepId===input.stepId&&prior.contentHash===input.hash&&prior.contentRevision===input.revision&&prior.action===input.action&&prior.comment===(input.comment?.trim()??'')&&(input.action==='returned'||prior.signature?.method===input.method&&prior.signature?.value===input.value&&input.consent===true)) return document;
    throw new SigningError('conflict','This action reference was already used.');
  }
  const step=pendingSigningSteps(document).find(s=>s.id===input.stepId);
  if (!step || !step.holderId || step.holderId!==input.actorId) throw new SigningError('forbidden','Only the current assigned signer can act at this step.');
  if (!input.actorPersonId || !input.actorName.trim() || !Number.isFinite(Date.parse(input.at))) invalid('The verified signer and action time are required.');
  if (input.action==='returned'&&!input.comment?.trim()) invalid('Explain why the review is being returned.');
  if (input.action==='signed'&&(!input.consent||!input.method||!validV9SignatureValue(input.method,input.value??''))) invalid('Enter your signature and confirm consent.');
  const action: SigningAction={id:input.id,stepId:step.id,contentRevision:input.revision,contentHash:input.hash,actorId:input.actorId,actorPersonId:input.actorPersonId,actorName:input.actorName,representedId:step.representedId??step.holderId,role:step.role,at:input.at,action:input.action,comment:input.comment?.trim()??'',signature:input.action==='signed'?{method:input.method!,value:input.value!,consent:true}:null};
  const next={...document,actions:[...document.actions,action]};
  if (rules.independentApprovalFromRole&&step.kind==='approve') {
    const manager=next.actions.find(a=>a.action==='signed'&&a.role===rules.independentApprovalFromRole&&a.contentRevision===input.revision&&a.contentHash===input.hash);
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
  if (!step||document.actions.some(a=>a.stepId===step.id&&a.contentRevision===document.contentRevision&&a.contentHash===document.contentHash&&a.action==='signed')) throw new SigningError('conflict','Completed signatures cannot be reassigned.');
  const next={...document,route:{...document.route,steps:document.route.steps.map(s=>s.id===step.id?{...s,holderId:input.holderId,holderPersonId:input.holderPersonId,representedId:input.kind==='delegation'?(s.representedId??s.holderId??undefined):undefined}:s)}};
  validateSigningRoute(next.route,rules);
  return next;
}
