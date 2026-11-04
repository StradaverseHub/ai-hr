/** AI v2 slice 3 follow-up — the values a profile change prepared in chat opens the profile page's form on, when the
 * person presses Edit on its card (core/assistant-actions/own-change-proposal-confirm.ts editOwnChangeProposal).
 *
 * The same pattern as the leave and attendance prefills (lib/leave-apply-prefill.ts, lib/leave-credit-prefill.ts): the
 * values only SEED the form, the form keeps every control live, and the profile owner (core/profile.ts) re-runs every
 * check when the person saves. Unlike those, no value rides in the link at all: the link carries only the review
 * handle (`/me?tab=…&profileSeed=<review id>`), and the page reopens that sealed review here, as the caller, through
 * its own custody (which re-checks the login, the Assistant grant, the own subject and the current field policy).
 *
 * What is seeded: only a review still awaiting the person's Confirm (a confirmed one is already with HR), only for the
 * employment the page shows, only fields the person may request on that page now, and only existing records the page
 * still holds. Bank account and identity numbers (the registry's masked fields) are NEVER seeded: they
 * are left empty and named in `withheld`, and the page says why. Storage-free and model-free. */
import type {SessionContext} from '../db/client';
import type {EssWorkspace} from './profile-edit';
import type {EssProfileProposal,EssRegisterChange,EssScalar} from '../lib/personnel-ess-model';
import {personnelField} from '../lib/personnel-field-registry';
import {reopenProfileModuleActionReview} from './assistant-actions/module-action-review-store';

export const PROFILE_SEED_PARAM='profileSeed' as const;
export type ProfileEditSeed=Readonly<{
 /** Top-level field values by field id. */
 fields:Readonly<Record<string,EssScalar>>;
 /** Register rows: an existing one by its id, a new one by the review's client id. */
 registers:readonly Readonly<{kind:EssRegisterChange['kind'];id:string|null;clientId:string;values:Readonly<Record<string,EssScalar>>}>[];
 /** Field ids the change named that were left empty on purpose (bank account and identity numbers). */
 withheld:readonly string[];
}>;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Bank account and identity numbers (the registry's masked fields: NRIC, old IC, passport, a dependant's IC or
 * passport, the bank account and the custom holder's identification) are never carried from chat into a form. An
 * unknown field is withheld too. */
export function isWithheldFromSeed(fieldId:string):boolean{
 const field=personnelField(fieldId);
 return !field||field.ess.masked===true;
}

/** The seed for one reviewed proposal against the page's current workspace. Pure. Null when nothing can be seeded. */
export function profileEditSeed(proposal:EssProfileProposal,workspace:Pick<EssWorkspace,'editable'|'legacyPrimaryEditable'|'registers'>):ProfileEditSeed|null{
 const editable=new Set(workspace.editable),primaryEditable=new Set(workspace.legacyPrimaryEditable),withheld:string[]=[];
 const keep=(fieldId:string,allowed:boolean)=>{if(isWithheldFromSeed(fieldId)){withheld.push(fieldId);return false;}return allowed;};
 const fields:Record<string,EssScalar>={};
 for(const change of proposal.fields)if(keep(change.fieldId,editable.has(change.fieldId)))fields[change.fieldId]=change.value;
 const registers:{kind:EssRegisterChange['kind'];id:string|null;clientId:string;values:Record<string,EssScalar>}[]=[];
 for(const row of proposal.registers){
  const existing=row.id===null?null:workspace.registers.find(item=>item.kind===row.kind&&item.id===row.id);
  // A record the page no longer holds is not seeded; a new record seeds a new row.
  if(row.id!==null&&!existing)continue;
  const values:Record<string,EssScalar>={};
  for(const change of row.fields)if(keep(change.fieldId,editable.has(change.fieldId)||Boolean(existing?.primary&&primaryEditable.has(change.fieldId))))values[change.fieldId]=change.value;
  if(Object.keys(values).length)registers.push({kind:row.kind,id:row.id,clientId:row.id??row.clientId,values:Object.freeze(values)});
 }
 if(!Object.keys(fields).length&&!registers.length&&!withheld.length)return null;
 return Object.freeze({fields:Object.freeze(fields),registers:Object.freeze(registers.map(row=>Object.freeze(row))),withheld:Object.freeze([...new Set(withheld)])});
}

/** Reopens the caller's own prepared profile review and seeds the page's form from it. Null for anything else: a
 * malformed handle, someone else's or an expired review, one already sent to HR, another employment's, or a review
 * whose custody now refuses the caller. Never throws. */
export async function ownProfileEditSeed(ctx:SessionContext,handle:unknown,workspace:EssWorkspace):Promise<ProfileEditSeed|null>{
 if(typeof handle!=='string'||!UUID.test(handle))return null;
 try{
  const current=await reopenProfileModuleActionReview(ctx,handle);
  if(current.kind!=='prepared'||current.review.content.employmentId!==workspace.employmentId)return null;
  return profileEditSeed(current.review.content.proposal,workspace);
 }catch{return null;}
}
