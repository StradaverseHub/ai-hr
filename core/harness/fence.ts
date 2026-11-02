/** ADR-0170 §2 principle 6 — tool output reaches the model fenced as untrusted data.
 *
 * The disclosed value is serialised as JSON, so every quote inside it is escaped, and wrapped in a fence
 * that carries a per-turn random nonce. Text inside a record cannot close the fence (it would need the
 * nonce, and its quotes are escaped) and cannot add tools: the offer is fixed before the first tool runs.
 * Over-long output is cut inside the fence and the cut is stated on the fence. Pure apart from the nonce. */
import {randomBytes} from 'node:crypto';
import {HARNESS_SPEC} from './spec';

export const fenceNonce=()=>randomBytes(9).toString('base64url');
export function fenceUntrusted(tool:string,value:unknown,nonce:string):string{
 // Review low item: '<' is escaped inside the JSON body, so no text in a record can even spell a fence marker.
 const {open,close,maxToolOutputChars}=HARNESS_SPEC.fencing,json=(JSON.stringify(value)??'null').replace(/</g,'\\u003c'),cut=json.length>maxToolOutputChars;
 return `${open} tool="${tool}" nonce="${nonce}"${cut?' cut="true"':''}>>\n${cut?json.slice(0,maxToolOutputChars):json}\n${close} nonce="${nonce}">>`;
}
