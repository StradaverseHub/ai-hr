/** Request fixtures distinguish today's real editor from already-stored pre-v2 history. */
import {and,eq} from 'drizzle-orm';
import {employment,profileChangeRequest} from '../../db/schema';
import type {SessionContext} from '../../db/client';
import {readOwnProfileWorkspace} from '../../core/profile-edit';
import {requestProfileChange,type ProfileChangeProposed} from '../../core/profile';
import {PERSONNEL_FIELDS} from '../../lib/personnel-field-registry';
import {type EssScalar} from '../../lib/personnel-ess-model';
import {owner} from '../harness';

/** Does not filter unknown/closed fields, fabricate baselines, or grant the caller more access. */
export async function requestCurrentProfileChange(ctx:SessionContext,p:{employmentId:string;proposed:ProfileChangeProposed}){
 const workspace=await readOwnProfileWorkspace(ctx,{employmentId:p.employmentId});
 const fields=Object.entries(p.proposed).map(([key,value])=>{
  const field=PERSONNEL_FIELDS.find(field=>field.ess.binding?.legacyKey===key);
  const fieldId=field?.id??key; // Unknown names reach the actual owner's forged-field refusal.
  return {fieldId,before:workspace.baselines[fieldId]??null,value:value as EssScalar};
 });
 return requestProfileChange(ctx,{employmentId:p.employmentId,proposed:{v:2,fields,registers:[]}});
}
/** Historical decision/withdrawal/erasure tests only: deliberately NOT a new-submission API. */
export async function seedStoredLegacyProfileRequest(ctx:SessionContext,p:{employmentId:string;proposed:ProfileChangeProposed}){
 if(!ctx.personId)throw new Error('Historical fixture needs its subject person');
 const [subject]=await owner.db.select().from(employment).where(and(eq(employment.id,p.employmentId),eq(employment.tenantId,ctx.tenantId),eq(employment.personId,ctx.personId)));
 if(!subject)throw new Error('Historical fixture subject mismatch');
 const [row]=await owner.db.insert(profileChangeRequest).values({tenantId:ctx.tenantId,employmentId:subject.id,personId:subject.personId,proposed:p.proposed}).returning({requestId:profileChangeRequest.id});
 return row;
}
