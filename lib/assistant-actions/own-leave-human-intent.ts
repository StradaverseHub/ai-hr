/** Public correlation only, NEVER effect authority. This commits only the human's already posted
 * nomination/selection/text; no tenant/login/person, hidden balance or canonical source data. */
import {OwnLeaveNomination,OwnLeaveHumanSelection,OwnLeaveHumanText} from './own-leave-contract';
export function ownLeaveHumanIntentText(nominationValue:unknown,selectionValue:unknown,textValue:unknown){
 const n=OwnLeaveNomination.parse(nominationValue),s=OwnLeaveHumanSelection.parse(selectionValue),h=OwnLeaveHumanText.parse(textValue);
 if(n.employmentId!==s.employmentId||n.leaveTypeId!==s.leaveTypeId)throw Error('Own-leave selection unavailable.');
 return JSON.stringify(['own-leave-human-intent:v1',n,s,h]);
}
/** Capture the full canonical text BEFORE this first async boundary. Caller prevents duplicate
 * requests while hashing; a digest failure must not send or prepare any action. */
export async function ownLeaveBrowserHumanIntentDigest(nomination:unknown,selection:unknown,text:unknown){
 const bytes=new TextEncoder().encode(ownLeaveHumanIntentText(nomination,selection,text));
 const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
