/** Contract policy over the shared signing engine; Probation's signing rules remain unchanged. */
import {documentRoutingProblems, resolveDocumentRouting, type DocumentRouting, type DocumentRoutingReferences, type DocumentRoutingResolveContext} from './document-signing-routing';
import {currentRoundActions, pendingSigningSteps, recordSigningAction, resendSigningDocument, reviseSigningDocument, signingComplete, signingContentLocked, signingDocumentOwner, canEditSigningContent, type SigningDocument} from './document-signing-model';
import {SigningError} from './document-signing-model';
import type {Block,Field,Document} from './lifecycle-v9-model';
import {automationDocument} from './automation-document';

export type ContractLetterFlow = {
  id: string; templateId: string; templateVersion: number; generatedOn: string;
  document: SigningDocument; state: 'routing' | 'released' | 'declined' | 'withdrawn';
  values: Record<string, string>; valuesFixed: boolean;
  blocks: Record<string, string>; releasedAt: string | null;
  /** Immutable block/field source copied from the chosen published template version at generation. */
  definition?:{name:string;blocks:Block[];fields:Field[]};
};
export function contractLetterRoutingProblems(routing: DocumentRouting, refs: DocumentRoutingReferences): string[] {
  if (!routing.length) return ['Add at least one signing or review step.'];
  return documentRoutingProblems(routing, refs, {requireSign: false, requireOwner: true});
}
export function resolveContractLetterRouting(routing: DocumentRouting, ctx: DocumentRoutingResolveContext) {
  return resolveDocumentRouting(routing, {...ctx, holdMissingEmployee: true,routingDefaultOnEmpty:true});
}
export function contractLetterCanEdit(letter: ContractLetterFlow, userId: string): boolean {
  return letter.state === 'routing' && canEditSigningContent(letter.document, userId);
}
/** Re-read fields before actions, but never replace the values to which the first signer committed. */
export function refreshContractLetterValues(letter: ContractLetterFlow, values: Record<string, string>,fingerprint?:string): ContractLetterFlow {
  if(letter.valuesFixed||letter.state!=='routing')return letter;
  if(fingerprint&&(!/^[a-f0-9]{64}$/.test(fingerprint)||!letter.document.routing))throw new SigningError('invalid','A valid routed letter fingerprint is required.');
  // A live Personnel value does not rewrite earlier reviews. A text edit uses reviseSigningDocument instead.
  return {...letter,values:{...values},...(fingerprint?{document:{...letter.document,contentHash:fingerprint,routing:{...letter.document.routing!,liveMergeReviews:true}}}:{})};
}
export function editContractLetterBlocks(letter: ContractLetterFlow, input: {userId: string; blocks: Record<string, string>; fingerprint: string}): ContractLetterFlow {
  if (!contractLetterCanEdit(letter, input.userId)) throw new SigningError('forbidden', 'Only the current reviewer or document owner can edit before the first signature.');
  if (Object.keys(input.blocks).some(key => !Object.hasOwn(letter.blocks, key))) throw new SigningError('invalid', 'Only the existing editable content blocks may be changed.');
  const blocks = {...letter.blocks, ...input.blocks};
  if (!Object.values(blocks).some(text => text.trim())) throw new SigningError('invalid', 'The letter cannot be empty.');
  if (Object.entries(blocks).every(([key, value]) => value === letter.blocks[key])) return letter;
  return {...letter, blocks, document: reviseSigningDocument(letter.document, input.fingerprint)};
}
/** Persistence verifies actor/session and fingerprint against rendered current values before this transition. */
export function actOnContractLetter(letter: ContractLetterFlow, input: Parameters<typeof recordSigningAction>[2]): ContractLetterFlow {
  if (letter.state !== 'routing') throw new SigningError('conflict', 'This letter is no longer waiting for an action.');
  const document = recordSigningAction(letter.document, {requiredRoles: []}, input);
  const released = signingComplete(document, {requiredRoles: []});
  return {...letter, document, valuesFixed: input.action === 'returned' ? false : letter.valuesFixed || signingContentLocked(document) || released,
    state: released ? 'released' : 'routing', releasedAt: released ? input.at : null};
}
export function resendContractLetter(letter: ContractLetterFlow, input: Parameters<typeof resendSigningDocument>[1]): ContractLetterFlow {
  if (letter.state !== 'routing') throw new SigningError('conflict', 'This letter is no longer waiting for changes.');
  return {...letter, document: resendSigningDocument(letter.document, input), valuesFixed: false};
}
export function contractEmployeeSignaturePending(letter: ContractLetterFlow): boolean {
  return letter.state === 'routing' && pendingSigningSteps(letter.document).some(step => step.role === 'employee' && step.kind === 'sign');
}
export function declineContractLetter(letter: ContractLetterFlow): ContractLetterFlow {
  if (!contractEmployeeSignaturePending(letter)) throw new SigningError('conflict', 'The employee signature is not pending.');
  return {...letter, state: 'declined'};
}
export function contractLetterSummary(letter: ContractLetterFlow) {
  return {owner: signingDocumentOwner(letter.document), pending: pendingSigningSteps(letter.document), locked: letter.valuesFixed,
    signed: currentRoundActions(letter.document).filter(a => a.action === 'signed').map(a => ({by: a.actorName, at: a.at, role: a.role}))};
}
export function contractLetterDocument(letter:ContractLetterFlow):Document{
 if(!letter.definition)throw new SigningError('invalid','This letter has no pinned template snapshot.');
 const blocks=letter.definition.blocks.map(block=>{
  if(!Object.hasOwn(letter.blocks,block.id))return block;
  return block.type==='table'?{...block,rows:letter.blocks[block.id]}:['heading','subheading','text'].includes(block.type)?{...block,text:letter.blocks[block.id]}:block;
 });
 const document=automationDocument({id:letter.id,name:letter.definition.name,templateId:letter.templateId,templateVersion:letter.templateVersion,blocks,fields:letter.definition.fields,
  merge:{...letter.values,'company.name':letter.values['org.company']??''},createdAt:letter.generatedOn,signing:letter.document});
 return {...document,status:letter.state==='withdrawn'?'withdrawn':letter.state==='released'?(currentRoundActions(letter.document).some(action=>action.action==='signed')?'signed':'completed'):'draft'};
}
/** The service hashes this deterministic source. Signatures and action history never alter the agreed content hash. */
export function contractLetterFingerprintSource(letter:ContractLetterFlow,values=letter.values):string{
 if(!letter.definition)throw new SigningError('invalid','This letter has no pinned template snapshot.');
 const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>(value as Record<string,unknown>)[key]!==undefined).map(key=>[key,canonical((value as Record<string,unknown>)[key])])):value;
 return JSON.stringify(canonical({id:letter.id,contentRevision:letter.document.contentRevision,templateId:letter.templateId,templateVersion:letter.templateVersion,generatedOn:letter.generatedOn,definition:letter.definition,blocks:letter.blocks,values}));
}
