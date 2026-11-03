/** AI v2 W5 — "Why is my claim limit this figure, and how much have I used?" for one of the caller's own claim types.
 *
 * The answer is the claims owner's own balance (core/claims.ts employeeClaimTypesTx, the read the claim form and the
 * submit check share), read inside the Assistant read facade for each of the caller's own current employments and
 * projected by core/claim-limit-explain.ts claimLimitExplanation without recomputing anything. The claim type is
 * named, not handed over as an id, and resolved against the caller's own claim form, so a type they cannot claim is
 * never read. Amounts leave to the model only as bands and placeholders. */
import type {SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {withAssistantRead} from '../assistant-read-session';
import {claimLimitExplanation} from '../claim-limit-explain';
import {matchLeaveType} from './entitlement';
import {provenance,refuse,type ExplainerOutcome} from './outcome';

export const CLAIM_LIMIT_PROVENANCE=provenance('core/claims.ts#employeeClaimTypesTx','The claim policy row in force: its own valid-from date, for the person\'s job grade or for all grades.','/claims',
 'Limits, use and what remains are the claims service\'s own figures, the ones the claim form shows and the submit check enforces. Use counts pending, approved and paid claims by the date the expense was incurred; drafts hold nothing.');

export async function explainOwnClaimLimit(ctx:SessionContext,input:Readonly<{claim_type?:string}>,today=todayInKualaLumpur()):Promise<ExplainerOutcome>{
 if(typeof input.claim_type!=='string'||!input.claim_type.trim())return refuse('invalid_input','`claim_type` must name one of the asking person\'s claim types.');
 return withAssistantRead(ctx,'claims',async(read):Promise<ExplainerOutcome>=>{
  const employments=await read.myEmployments();
  if(!employments.length)return refuse('no_employment','The asking user has no current employee record, so they have no claim limits.');
  const forms=[];
  for(const employment of employments)forms.push({company:employment.company,types:await read.employeeClaimTypes(employment.employmentId)});
  const names=new Map<string,string>();
  for(const form of forms)for(const type of form.types)names.set(type.id,type.name);
  // The same matching the leave explainer uses: the exact name, otherwise the one own type the words name.
  const typeId=matchLeaveType(input.claim_type!,names);
  if(!typeId)return{...refuse('no_data','The asking person has no claim type by that name, or the name matches more than one. Ask which one they mean.'),claimTypes:[...new Set(names.values())].sort()};
  const explained=forms.flatMap(form=>form.types.filter(type=>type.id===typeId).map(type=>({company:form.company,...claimLimitExplanation(type.balance)})));
  return{ok:true,claimType:names.get(typeId),asOf:today,employments:explained,provenance:CLAIM_LIMIT_PROVENANCE};
 });
}
