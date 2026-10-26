/** UNMOUNTED advisory choices. No candidate, review, request, effect, provider or model admission.
 * Today-only menu eligibility is not the selected date's eligibility or permission to submit. */
import {and,eq,inArray} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {leaveType} from '../../db/schema';
import {isLocale} from '../../i18n/config';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {lockLeaveDependencyReadConfigurationTx} from '../../packs/leave/service';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {isEmploymentEnded} from '../employment-status';
import {listEligibleLeaveTypesFor,myOwnEmploymentSubjectsTx} from '../read';
import {readOwnLeaveActorTx} from './own-leave-actor';
import {ownLeaveFirstSliceTypeQualifies} from './own-leave-candidate';

export type OwnLeaveChoiceEmployment=Readonly<{id:string;label:string;leaveTypes:readonly Readonly<{id:string;label:string}>[]}>;
export type OwnLeaveChoices=Readonly<{kind:'choices';employments:readonly OwnLeaveChoiceEmployment[]}>|Readonly<{kind:'unavailable'}>;
export const OWN_LEAVE_CHOICE_LIMITS=Object.freeze({employments:16,types:128});

/** Fresh carrier/actor owns Access before the shared configuration phase. Bounded source discovery
 * rejects overflow rather than returning a truncated menu. Only labels/IDs leave this owner: no
 * person/tenant/company identity, salary, policy object, private balance or canonical event data.
 * The 128 bound counts ALL canonical eligible type rows across the complete own inventory before
 * the first-slice capability filter; a large catalogue must use the ordinary Leave form instead. */
export async function readOwnLeaveChoicesTx(tx:Tx,supplied:SessionContext,locale:string):Promise<OwnLeaveChoices>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 try{
  if(!isLocale(locale))return{kind:'unavailable'};
  const actor=await readOwnLeaveActorTx(tx,ctx);if(!actor)return{kind:'unavailable'};
  await assertAiActionUnpausedTx(tx,actor,'hr_assistant');
  await lockLeaveDependencyReadConfigurationTx(tx,actor.tenantId);
  const subjects=await myOwnEmploymentSubjectsTx(tx,actor);
  if(subjects.length>OWN_LEAVE_CHOICE_LIMITS.employments)return{kind:'unavailable'};
  const today=todayInKualaLumpur(),employments:OwnLeaveChoiceEmployment[]=[];let count=0;
  for(const subject of subjects){
   if(subject.hiredOn>today||isEmploymentEnded(subject,today))continue;
   // No guessed current company or label when the canonical dated assignment is missing/ambiguous.
   if(!subject.companyProof.companyId||subject.companyProof.companyId!==subject.currentCompanyId)return{kind:'unavailable'};
   const types=await listEligibleLeaveTypesFor(actor,subject.employmentId,locale,tx);
   count+=types.length;if(count>OWN_LEAVE_CHOICE_LIMITS.types)return{kind:'unavailable'};
   if(types.length===0)continue;
   const identities=await tx.select({id:leaveType.id,role:leaveType.role,code:leaveType.code,country:leaveType.country,essViewConfig:leaveType.essViewConfig})
    .from(leaveType).where(and(eq(leaveType.tenantId,actor.tenantId),inArray(leaveType.id,types.map(type=>type.id))));
   const byId=new Map(identities.map(identity=>[identity.id,identity]));
   const available=types.filter(type=>ownLeaveFirstSliceTypeQualifies(byId.get(type.id),type,subject.country))
    .map(type=>Object.freeze({id:type.id,label:type.name}));
   if(available.length===0)continue;
   employments.push(Object.freeze({id:subject.employmentId,label:[subject.company,subject.employeeCode??subject.hiredOn].join(' · '),leaveTypes:Object.freeze(available)}));
  }
  return Object.freeze({kind:'choices',employments:Object.freeze(employments)});
 }catch{return{kind:'unavailable'};}
}
