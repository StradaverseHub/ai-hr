import type {ContractSharedLetter} from '@/packs/contracts/service';
import type {RoutedPdfSignature} from './lifecycle-v9-pdf';
import {automationSignerRoleLabel} from './automation-document';
import {ContractManagementError} from './contract-management-model';
/** Display adapter only: the canonical owner supplies every identity, image and original signed proof. */
export function contractPdfSignatures(letter:ContractSharedLetter):RoutedPdfSignature[]{
 return (letter.body?.receipts??[]).flatMap(receipt=>{
  if(!receipt.signature)return [];
  const action=letter.history.find(action=>action.action==='signed'&&action.stepId===receipt.stepId&&action.actorName===receipt.actorName&&action.at===receipt.at);
  if(!action||action.hash!==letter.contentHash||action.revision!==letter.contentRevision)throw new ContractManagementError('conflict','The recorded signature proof needs review before PDF export.');
  return [{signature:{by:{id:receipt.actorId,name:receipt.actorName},at:receipt.at,...receipt.signature},role:letter.layers.find(layer=>layer.id===receipt.stepId)?.label??automationSignerRoleLabel(receipt.role),contentRevision:action.revision,contentHash:action.hash}];
 });
}
