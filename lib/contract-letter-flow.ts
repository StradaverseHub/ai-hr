/** Contract policy over the shared signing engine; Probation's signing rules remain unchanged. */
import {documentRoutingProblems, resolveDocumentRouting, type DocumentRouting, type DocumentRoutingReferences, type DocumentRoutingResolveContext} from './document-signing-routing';
import {currentRoundActions, pendingSigningSteps, recordSigningAction, resendSigningDocument, reviseSigningDocument, signingComplete, signingContentLocked, signingDocumentOwner, canEditSigningContent, type SigningDocument} from './document-signing-model';
import {SigningError} from './document-signing-model';

export type ContractLetterFlow = {
  id: string; templateId: string; templateVersion: number; generatedOn: string;
  document: SigningDocument; state: 'routing' | 'released' | 'declined';
  values: Record<string, string>; valuesFixed: boolean;
  blocks: Record<string, string>; releasedAt: string | null;
};
export function contractLetterRoutingProblems(routing: DocumentRouting, refs: DocumentRoutingReferences): string[] {
  if (!routing.length) return ['Add at least one signing or review step.'];
  return documentRoutingProblems(routing, refs, {requireSign: false, requireOwner: true});
}
export function resolveContractLetterRouting(routing: DocumentRouting, ctx: DocumentRoutingResolveContext) {
  return resolveDocumentRouting(routing, {...ctx, holdMissingEmployee: true});
}
export function contractLetterCanEdit(letter: ContractLetterFlow, userId: string): boolean {
  return letter.state === 'routing' && canEditSigningContent(letter.document, userId);
}
/** Re-read fields before actions, but never replace the values to which the first signer committed. */
export function refreshContractLetterValues(letter: ContractLetterFlow, values: Record<string, string>): ContractLetterFlow {
  return letter.valuesFixed || letter.state !== 'routing' ? letter : {...letter, values: {...values}};
}
export function editContractLetterBlocks(letter: ContractLetterFlow, input: {userId: string; blocks: Record<string, string>; fingerprint: string}): ContractLetterFlow {
  if (!contractLetterCanEdit(letter, input.userId)) throw new SigningError('forbidden', 'Only the current reviewer or document owner can edit before the first signature.');
  if (!Object.values(input.blocks).some(text => text.trim())) throw new SigningError('invalid', 'The letter cannot be empty.');
  if (Object.keys(input.blocks).some(key => !Object.hasOwn(letter.blocks, key))) throw new SigningError('invalid', 'Only the existing editable content blocks may be changed.');
  const blocks = {...letter.blocks, ...input.blocks};
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
